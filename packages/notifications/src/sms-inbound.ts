import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { digest } from './sms-service.ts'

export const SMS_INBOUND_PATH = '/api/sms/twilio'
const empty = '<Response></Response>'

/** Authenticate the exact configured URL and every form field before interpreting any data. */
export function verifyTwilioSignature(
  url: string,
  params: URLSearchParams,
  signature: string,
  token: string,
) {
  let value = url
  for (const name of [...new Set(params.keys())].sort()) {
    for (const entry of [...new Set(params.getAll(name))].sort()) value += name + entry
  }
  const expected = createHmac('sha1', token).update(value).digest('base64')
  return (
    Buffer.byteLength(signature) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
}

export function createSmsInboundHandler(deps: {
  db: Db
  publicUrl: string
  accountSid: string
  authToken: string
  hashSecret: string
  from?: string | undefined
  messagingServiceSid?: string | undefined
}) {
  return async (request: Request): Promise<Response> => {
    const respond = (body: string, status = 200) =>
      new Response(body, {
        status,
        headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' },
      })
    if (
      request.method !== 'POST' ||
      new URL(request.url).search ||
      request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded'
    )
      return respond('', 400)
    const reader = request.body?.getReader()
    if (!reader) return respond('', 400)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 16384) {
          await reader.cancel()
          return respond('', 413)
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
    const url = new URL(SMS_INBOUND_PATH, deps.publicUrl).href
    if (
      !verifyTwilioSignature(
        url,
        params,
        request.headers.get('x-twilio-signature') ?? '',
        deps.authToken,
      )
    )
      return respond('', 403)
    // Ambiguous duplicate fields are rejected even if authenticated.
    if ([...params.keys()].some((name) => params.getAll(name).length !== 1)) return respond('', 400)
    const phone = params.get('From') ?? ''
    const sid = params.get('MessageSid') ?? ''
    if (
      params.get('AccountSid') !== deps.accountSid ||
      !/^SM[0-9a-f]{32}$/i.test(sid) ||
      !/^\+[1-9]\d{7,14}$/.test(phone) ||
      (deps.from && params.get('To') !== deps.from) ||
      (deps.messagingServiceSid && params.get('MessagingServiceSid') !== deps.messagingServiceSid)
    )
      return respond('', 400)
    const keyword = (params.get('Body') ?? '').trim().toUpperCase()
    const advanced = params.get('OptOutType')
    const action =
      advanced === 'STOP' || advanced === 'START' || advanced === 'HELP'
        ? advanced
        : ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'].includes(
              keyword,
            )
          ? 'STOP'
          : ['START', 'UNSTOP', 'YES'].includes(keyword)
            ? 'START'
            : ['HELP', 'INFO'].includes(keyword)
              ? 'HELP'
              : undefined
    const fresh = await deps.db.transaction().execute(async (tx) => {
      // Same serialization fence as send reservation: a committed STOP always wins over a later reservation.
      await sql`SELECT pg_advisory_xact_lock(1852798057, 1936552802)`.execute(tx)
      const inserted = await tx
        .insertInto('sms_inbound_receipts')
        .values({ key_hash: digest(deps.hashSecret, 'inbound', sid) })
        .onConflict((c) => c.column('key_hash').doNothing())
        .returning('key_hash')
        .executeTakeFirst()
      if (!inserted) return false
      const recipient = digest(deps.hashSecret, 'recipient', phone)
      if (action === 'STOP')
        await tx
          .insertInto('sms_suppressions')
          .values({ recipient_hash: recipient })
          .onConflict((c) => c.column('recipient_hash').doNothing())
          .execute()
      if (action === 'START')
        await tx.deleteFrom('sms_suppressions').where('recipient_hash', '=', recipient).execute()
      return true
    })
    // Advanced Opt-Out has already sent Twilio's configured response; never duplicate it.
    if (!fresh || advanced || action !== 'HELP') return respond(empty)
    return respond(
      '<Response><Message>Booking reminders. Contact the business that sent your reminder for help. Reply STOP to unsubscribe or START to subscribe.</Message></Response>',
    )
  }
}
