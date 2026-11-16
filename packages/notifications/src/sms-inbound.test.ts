import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/src/testing.ts'
import { createSmsInboundHandler } from './sms-inbound.ts'
import { createFakeSmsProvider } from './sms-provider.ts'
import { createSmsService } from './sms-service.ts'

const secret = 'synthetic-sms-inbound-hash-key-at-least-32'
const token = 'synthetic-account-token'
const url = 'https://example.test/api/sms/twilio'
const account = `AC${'1'.repeat(32)}`
const phone = '+14155550123'
const from = '+14155550124'
function request(
  body: string,
  sid = `SM${randomUUID().replaceAll('-', '')}`,
  extra: Record<string, string> = {},
) {
  const params = new URLSearchParams({
    AccountSid: account,
    From: phone,
    To: from,
    MessageSid: sid,
    Body: body,
    ...extra,
  })
  const text =
    url +
    [...params.keys()]
      .sort()
      .map((k) => k + params.get(k))
      .join('')
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': createHmac('sha1', token).update(text).digest('base64'),
    },
    body: params,
  })
}
describe.skipIf(!process.env.DATABASE_URL)('signed SMS inbound', () => {
  let owned: TestDatabase
  let db: Db
  let receive: ReturnType<typeof createSmsInboundHandler>
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    receive = createSmsInboundHandler({
      db,
      publicUrl: 'https://example.test',
      accountSid: account,
      authToken: token,
      hashSecret: secret,
      from,
    })
  })
  afterAll(async () => {
    await owned?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('sms_inbound_receipts').execute()
    await db.deleteFrom('sms_suppressions').execute()
    await db.deleteFrom('sms_deliveries').execute()
  })
  const input = () => ({
    to: phone,
    body: 'Reminder',
    organizationId: randomUUID(),
    idempotencyKey: randomUUID(),
  })
  it.each(['STOP', 'stopall', 'Unsubscribe', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'])(
    'suppresses %s instance-wide, without storing raw phone or body',
    async (keyword) => {
      expect((await receive(request(keyword))).status).toBe(200)
      const provider = createFakeSmsProvider()
      const sender = createSmsService({ db, hashSecret: secret, provider })
      await expect(sender.sendSms(input())).rejects.toMatchObject({ code: 'sms_opted_out' })
      expect(provider.calls).toHaveLength(0)
      expect(
        JSON.stringify(await db.selectFrom('sms_suppressions').selectAll().execute()),
      ).not.toContain(phone)
    },
  )
  it.each(['START', 'UNSTOP', 'YES'])(
    're-enables %s; replayed START cannot undo a later STOP',
    async (keyword) => {
      await receive(request('STOP'))
      const start = request(keyword)
      await receive(start.clone())
      const provider = createFakeSmsProvider()
      await expect(
        createSmsService({ db, hashSecret: secret, provider }).sendSms(input()),
      ).resolves.toBeDefined()
      await receive(request('STOP'))
      await receive(start)
      await expect(
        createSmsService({ db, hashSecret: secret, provider }).sendSms(input()),
      ).rejects.toMatchObject({ code: 'sms_opted_out' })
      expect(provider.calls).toHaveLength(1)
    },
  )
  it('rejects forged, changed and wrong-account callbacks before writes', async () => {
    const unicode = request('STOP')
    unicode.headers.set('x-twilio-signature', 'é'.repeat(28))
    expect((await receive(unicode)).status).toBe(403)
    const forged = request('STOP')
    forged.headers.set('x-twilio-signature', 'invalid')
    expect((await receive(forged)).status).toBe(403)
    const changed = request('START')
    const bad = new Request(changed, {
      body: await changed.text().then((s) => s.replace('START', 'STOP')),
    })
    expect((await receive(bad)).status).toBe(403)
    expect(
      (await receive(request('STOP', undefined, { AccountSid: `AC${'2'.repeat(32)}` }))).status,
    ).toBe(400)
    expect(await db.selectFrom('sms_suppressions').selectAll().execute()).toEqual([])
  })
  it('answers HELP once and lets Advanced Opt-Out answer its own messages', async () => {
    const help = request('HELP')
    expect(await (await receive(help.clone())).text()).toContain('<Message>')
    expect(await (await receive(help)).text()).toBe('<Response></Response>')
    expect(await (await receive(request('ayuda', undefined, { OptOutType: 'HELP' }))).text()).toBe(
      '<Response></Response>',
    )
    await receive(request('custom keyword', undefined, { OptOutType: 'STOP' }))
    expect(await db.selectFrom('sms_suppressions').selectAll().execute()).toHaveLength(1)
  })
  it('serializes STOP and a send reservation on the same database fence', async () => {
    const blocker = await owned.pool.connect()
    const provider = createFakeSmsProvider()
    let stop: Promise<Response> | undefined
    let sending: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_advisory_xact_lock(1852798057, 1936552802)')
      stop = receive(request('STOP'))
      // Observe the inbound waiter before starting a send, making the ordering deterministic.
      const { vi } = await import('vitest')
      await vi.waitFor(async () => {
        expect(
          (
            await blocker.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=1852798057 AND objid=1936552802 AND NOT granted",
            )
          ).rows[0].n,
        ).toBeGreaterThan(0)
      })
      sending = Promise.allSettled([
        createSmsService({ db, hashSecret: secret, provider }).sendSms(input()),
      ])
      await blocker.query('COMMIT')
      expect((await stop).status).toBe(200)
      expect(await sending).toMatchObject([
        { status: 'rejected', reason: { code: 'sms_opted_out' } },
      ])
      expect(provider.calls).toHaveLength(0)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await stop
      await sending
    }
  })
  it('kills signature and suppression source-copy bypasses', async () => {
    async function mutated(file: string, before: string, after: string) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source).toContain(before)
      const javascript = stripTypeScriptTypes(source.replace(before, after)).replace(
        /from '([^']+)'/g,
        (_, specifier: string) => `from '${import.meta.resolve(specifier)}'`,
      )
      return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
    }
    const inbound = await mutated(
      './sms-inbound.ts',
      '!verifyTwilioSignature(',
      'false && !verifyTwilioSignature(',
    )
    const verify = async (factory: typeof createSmsInboundHandler) => {
      const handler = factory({
        db,
        publicUrl: 'https://example.test',
        accountSid: account,
        authToken: token,
        hashSecret: secret,
        from,
      })
      const forged = request('STOP')
      forged.headers.set('x-twilio-signature', 'invalid')
      expect((await handler(forged)).status).toBe(403)
    }
    await verify(createSmsInboundHandler)
    await expect(verify(inbound.createSmsInboundHandler)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await verify(createSmsInboundHandler)
    await receive(request('STOP'))
    const service = await mutated(
      './sms-service.ts',
      "if (suppressed) throw new SmsError('sms_opted_out')",
      "if (false) throw new SmsError('sms_opted_out')",
    )
    const check = async (factory: typeof createSmsService) => {
      await expect(
        factory({ db, hashSecret: secret, provider: createFakeSmsProvider() }).sendSms(input()),
      ).rejects.toMatchObject({ code: 'sms_opted_out' })
    }
    await check(createSmsService)
    await expect(check(service.createSmsService)).rejects.toMatchObject({ name: 'AssertionError' })
    await check(createSmsService)
  })
})
