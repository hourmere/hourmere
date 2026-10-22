// Durable login delivery: requests enqueue every address alike; only workers decide who
// gets mail. Credentials never enter job JSON or error logs, and the outbox is short-lived.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { hasAccount, MAGIC_LINK_CONFIRM_PATH, maySignUp, type SignupPolicy } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import { type Mailer, magicLinkEmail } from '@hourmere/mail'
import { z } from 'zod'
import {
  lockNotificationEmailBudget,
  type SignInMailLimits,
  signInEmailBudget,
  signInRecipientHash,
} from './mail-limits.ts'

export const SIGN_IN_EMAIL_JOB = 'sign-in-email'
const CLEANUP_JOB = 'sign-in-email-cleanup'
const MAX_CIPHERTEXT = 1_048_576
const Request = z.strictObject({
  email: z.email(),
  url: z.string().max(524_288),
  // Old encrypted outbox rows have no language and keep the original English template.
  language: z.enum(['en', 'zh-CN']).optional(),
})
// A newer web process may enqueue additive metadata or a language this worker does
// not support. Ignore that metadata and use English while still validating credentials.
const StoredRequest = z.object({
  ...Request.shape,
  language: Request.shape.language.catch(undefined),
})
export const SignInEmailPayload = z.strictObject({ emailId: z.uuid() })

export interface SignInEmailDeps extends SignInMailLimits {
  db: Db
  mailer: Mailer
  publicUrl: string
  /** BETTER_AUTH_SECRET; rotating it also discards old queued sign-in links. */
  secret: string
  signup: SignupPolicy
  now?: (() => Date) | undefined
  log?: ((line: string) => void) | undefined
}

interface Queue {
  enqueue(
    name: typeof SIGN_IN_EMAIL_JOB,
    payload: z.input<typeof SignInEmailPayload>,
    options?: EnqueueOptions,
  ): Promise<string | null>
}

type SealDeps = Pick<SignInEmailDeps, 'secret' | 'publicUrl'>
const key = (secret: string) =>
  Buffer.from(hkdfSync('sha256', secret, 'Hourmere sign-in email', 'outbox-v1', 32))
const aad = (deps: SealDeps, id: string) =>
  Buffer.from(`hourmere:sign-in-email:v1:${new URL(deps.publicUrl).origin}:${id}`)

function seal(deps: SealDeps, id: string, value: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(deps.secret), iv)
  cipher.setAAD(aad(deps, id))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted])
}

function open(deps: SealDeps, id: string, value: Buffer): z.output<typeof Request> | undefined {
  try {
    if (value.length < 30 || value.length > MAX_CIPHERTEXT || value[0] !== 1) return undefined
    const decipher = createDecipheriv('aes-256-gcm', key(deps.secret), value.subarray(1, 13))
    decipher.setAAD(aad(deps, id))
    decipher.setAuthTag(value.subarray(13, 29))
    const text = Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString(
      'utf8',
    )
    return StoredRequest.parse(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** Better Auth 1.7's hashed magic-link identifier; actual auth round trips test parity. */
function identifier(deps: SealDeps, url: string): string | undefined {
  try {
    const link = new URL(url)
    if (
      link.origin !== new URL(deps.publicUrl).origin ||
      link.pathname !== MAGIC_LINK_CONFIRM_PATH ||
      link.search ||
      link.username ||
      link.password
    )
      return undefined
    const token = new URLSearchParams(link.hash.slice(1)).get('token')
    if (!token || token.length > 256) return undefined
    return `magic-link:${createHash('sha256').update(token).digest('base64url')}`
  } catch {
    return undefined
  }
}

async function verification(db: Db, deps: SealDeps, request: z.output<typeof Request>) {
  const id = identifier(deps, request.url)
  if (!id) return undefined
  const row = await db
    .selectFrom('auth.verification')
    .select(['expiresAt', 'value'])
    .where('identifier', '=', id)
    .executeTakeFirst()
  if (!row) return undefined
  try {
    const value: unknown = JSON.parse(row.value)
    if (!value || typeof value !== 'object') return undefined
    const record = value as { type?: unknown; email?: unknown }
    if (
      record.type !== 'magic-link' ||
      typeof record.email !== 'string' ||
      record.email.toLowerCase() !== request.email.toLowerCase()
    )
      return undefined
    return row
  } catch {
    return undefined
  }
}

/**
 * The outbox insert and job enqueue commit together. No account or signup-policy decision
 * occurs here; the token lookup is identical for every address and uses its random hash.
 */
export function queuedSignInEmail(
  queue: Queue,
  deps: Pick<SignInEmailDeps, 'db' | 'secret' | 'publicUrl'>,
) {
  return async (input: z.input<typeof Request>): Promise<void> => {
    try {
      const request = Request.parse(input)
      const token = await verification(deps.db, deps, request)
      if (!token) throw new Error()
      const id = randomUUID()
      const encrypted = seal(deps, id, JSON.stringify(request))
      if (encrypted.length > MAX_CIPHERTEXT) throw new Error()
      await deps.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('sign_in_emails')
          .values({ id, encrypted_payload: encrypted, expires_at: token.expiresAt })
          .execute()
        const job = await queue.enqueue(
          SIGN_IN_EMAIL_JOB,
          { emailId: id },
          { transaction: trx, singletonKey: id },
        )
        if (job === null) throw new Error()
      })
    } catch {
      // Database/crypto errors and Zod issues can contain input: never chain them into logs.
      throw new Error('Sign-in email could not be queued')
    }
  }
}

/** SMTP diagnostics from a fixed vocabulary, with no recipient, link or cause chain. */
function deliveryError(error: unknown): Error {
  const codes = new Set([
    'EAUTH',
    'ECONNECTION',
    'ESOCKET',
    'EDNS',
    'ETIMEDOUT',
    'ETLS',
    'EENVELOPE',
    'EMESSAGE',
    'ESTREAM',
  ])
  try {
    const e = error as { code?: unknown; responseCode?: unknown }
    const code = typeof e?.code === 'string' && codes.has(e.code) ? ` (${e.code})` : ''
    const response =
      typeof e?.responseCode === 'number' &&
      Number.isInteger(e.responseCode) &&
      e.responseCode >= 400 &&
      e.responseCode <= 599
        ? ` (${e.responseCode})`
        : ''
    return new Error(`Sign-in email could not be sent${code}${response}`)
  } catch {
    return new Error('Sign-in email could not be sent')
  }
}

export async function deliverSignInEmail(
  deps: SignInEmailDeps,
  emailId: string,
  signal?: AbortSignal,
): Promise<void> {
  const clock = deps.now ?? (() => new Date())
  await deps.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('sign_in_emails')
      .selectAll()
      .where('id', '=', emailId)
      .forUpdate()
      .executeTakeFirst()
    if (!row) return
    signal?.throwIfAborted()
    const remove = () => trx.deleteFrom('sign_in_emails').where('id', '=', emailId).execute()
    if (row.expires_at <= clock()) {
      await remove()
      return
    }
    const request = open(deps, row.id, row.encrypted_payload)
    if (!request) {
      await remove()
      ;(deps.log ?? console.warn)('[auth] discarded an unavailable queued sign-in email')
      return
    }
    const token = await verification(trx, deps, request)
    if (
      !token ||
      (!(await maySignUp(trx, deps.signup, request.email)) &&
        !(await hasAccount(trx, request.email)))
    ) {
      await remove()
      return
    }
    // Serialize every notification send, then recheck credentials after any lock wait:
    // the one-time link may have been used or expired while another SMTP send ran.
    await lockNotificationEmailBudget(trx)
    signal?.throwIfAborted()
    const current = await verification(trx, deps, request)
    const now = clock()
    if (!current || current.expiresAt <= now || row.expires_at <= now) {
      await remove()
      return
    }
    const recipientHash = signInRecipientHash(request.email, deps.secret)
    const reason = await signInEmailBudget(trx, deps, recipientHash, now)
    if (reason) {
      await remove()
      ;(deps.log ?? console.warn)(
        JSON.stringify({
          level: 'warn',
          event: 'sign_in_email_suppressed',
          reason,
          recipientHash: recipientHash.toString('hex'),
        }),
      )
      return
    }
    const minutes = Math.max(1, Math.ceil((current.expiresAt.getTime() - now.getTime()) / 60_000))
    try {
      await deps.mailer.send(
        magicLinkEmail({
          to: request.email,
          url: request.url,
          expiresInMinutes: minutes,
          language: request.language,
        }),
        { signal },
      )
    } catch (error) {
      throw deliveryError(error)
    }
    await trx
      .insertInto('notification_email_sends')
      .values({ recipient_hash: recipientHash, sent_at: clock() })
      .execute()
    await remove()
  })
}

export function signInEmailJobs(deps: SignInEmailDeps) {
  return [
    defineJob({
      name: SIGN_IN_EMAIL_JOB,
      payload: SignInEmailPayload,
      policy: 'exclusive',
      concurrency: 2,
      retry: { limit: 3, delaySeconds: 5, backoff: true, maxDelaySeconds: 30 },
      expireInSeconds: 60,
      retentionSeconds: 300,
      deleteAfterSeconds: 60,
      handler: ({ emailId }, { signal }) => deliverSignInEmail(deps, emailId, signal),
    }),
    defineJob({
      name: CLEANUP_JOB,
      payload: z.strictObject({}),
      schedule: { cron: '* * * * *', payload: {} },
      handler: async () => {
        await deps.db
          .deleteFrom('sign_in_emails')
          .where('expires_at', '<=', (deps.now ?? (() => new Date()))())
          .execute()
      },
    }),
  ] as const
}
