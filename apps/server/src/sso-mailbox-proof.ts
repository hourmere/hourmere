// SSO mailbox proof (docs/sso.md, Mailbox proof): the auth-protocol pair that proves a pending
// SSO attempt's mailbox through Hourmere, whatever the attempt's intent (sign-in, provider test,
// self-link or fresh proof). Send queues a proof email and answers the same in every case; only
// the worker decides whether the attempt is eligible, selects the attempt's frozen mailbox and
// issues the one-use token, of which only a SHA-256 digest is stored. Consume records the proof
// on the attempt itself; it never issues a session. Both endpoints answer `404 sso_disabled`
// while every protocol is off, before any other check. A bounded job deletes expired and
// consumed attempts with their tokens. This module owns that data access to `sso_attempts` and
// `sso_mailbox_tokens` and only reads `sso_providers` and the session table.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { CallerResolver } from '@hourmere/auth'
import { type InterfaceLanguage, localeCodes, resolveAdminLanguage } from '@hourmere/core/language'
import type { Db } from '@hourmere/db'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import { type Mailer, mailboxProofEmail } from '@hourmere/mail'
import {
  lockNotificationEmailBudget,
  mailboxProofRecipientHash,
  signInEmailBudget,
} from '@hourmere/notifications'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { sql } from 'kysely'
import { z } from 'zod'
import { withClientIpHeader } from './client-ip.ts'
import { createRateLimiter, type RateLimiter, rateLimitKey } from './rate-limit.ts'
import {
  requireSsoRetained,
  SCIM_MAPPING_CONSENT,
  type SsoCapabilities,
  ssoRetained,
  USE_SSO_RECOVERY,
} from './sso.ts'
import {
  samlAdmissionOperation,
  samlLinkOperation,
  samlMailboxOperation,
} from './sso-saml-state.ts'
import { ssoStorageDiagnostic } from './sso-storage-errors.ts'

/** The auth-protocol endpoints (outside /api/v1 and the interface-parity inventory). */
export const MAILBOX_PROOF_SEND_PATH = '/api/auth/sso/mailbox-proof/send'
export const MAILBOX_PROOF_CONSUME_PATH = '/api/auth/sso/mailbox-proof/consume'
/** The inert confirmation page the emailed link opens (Member UI); it never consumes on GET. */
export const MAILBOX_PROOF_CONFIRM_PATH = '/app/mailbox-proof'

export const MAILBOX_PROOF_EMAIL_JOB = 'sso-mailbox-proof-email'
export const SSO_ATTEMPT_CLEANUP_JOB = 'sso-attempt-cleanup'

/**
 * The browser-binding cookie that sign-in initiation, tests and link ceremonies set: an
 * attempt stores the SHA-256 of its value, never the value. `__Host-` on https.
 */
export const BROWSER_BINDING_COOKIE = 'hourmere.sso_binding'
const BINDING_VALUE = /^[A-Za-z0-9_-]{43}$/

export const MAILBOX_PROOF_LIMITS = Object.freeze({
  /** Send requests per client address (or IPv6 /64) per minute, in each server process. */
  sendsPerSourcePerMinute: 10,
  /** Consume requests per client address per minute, in each server process. */
  consumesPerSourcePerMinute: 30,
  /** A new token for an attempt only after its current one is this old (database clock). */
  resendCooldownSeconds: 60,
  /** The wrong token from the attempt's own browser that deletes its token (then resend). */
  guessesPerAttempt: 5,
  /** freshAdministrationProof: a token, and so its proof, lasts at most this long. */
  tokenLifetimeSeconds: 300,
  /** Attempts the cleanup deletes in one run. */
  cleanupBatch: 1000,
})
export type MailboxProofLimits = {
  -readonly [K in keyof typeof MAILBOX_PROOF_LIMITS]: number
}

/** The answer to every send that passes the Origin and input checks. */
const QUEUED = { status: 'queued' } as const
/** The single refusal of consume, whatever the reason. */
const INVALID = { error: 'sso_mailbox_proof_invalid' } as const

export const MailboxProofEmailPayload = z.strictObject({
  attemptId: z.uuid(),
  /** SHA-256 of the request's browser-binding cookie; null without a well-formed one. */
  binding: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  /** The request's own session and person; null without a session. */
  sessionId: z.string().min(1).max(128).nullable(),
  userId: z.string().min(1).max(128).nullable(),
  language: z.enum(localeCodes).catch('en'),
})
export type MailboxProofEmailPayload = z.output<typeof MailboxProofEmailPayload>

export interface MailboxProofQueue {
  enqueue(
    name: typeof MAILBOX_PROOF_EMAIL_JOB,
    payload: z.input<typeof MailboxProofEmailPayload>,
    options?: EnqueueOptions,
  ): Promise<string | null>
}

/**
 * The database instant every check and write of one transaction uses, read after its row
 * locks. Tests inject one to reach an exact boundary; the text keeps microseconds.
 */
export type MailboxProofClock = (trx: Db) => Promise<string>
export const databaseClock: MailboxProofClock = async (trx) => {
  const { rows } = await sql<{ now: string }>`SELECT clock_timestamp()::text AS now`.execute(trx)
  return rows[0]?.now as string
}

export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

/** The attempt digest of a browser-binding cookie value; null for a malformed value. */
export function browserBindingDigest(value: string | undefined): string | null {
  return value !== undefined && BINDING_VALUE.test(value) ? sha256(value) : null
}

export function bindingCookieName(publicUrl: string) {
  return new URL(publicUrl).protocol === 'https:'
    ? `__Host-${BROWSER_BINDING_COOKIE}`
    : BROWSER_BINDING_COOKIE
}

export function readBindingCookie(headers: Headers, name: string) {
  return headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

function sameDigest(a: string | null, b: string | null): boolean {
  if (a === null || b === null || a.length !== 64 || b.length !== 64) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/** The caller the attempt must belong to: its browser, and its session and person if any. */
interface Presenter {
  binding: string | null
  sessionId: string | null
  userId: string | null
}

interface AttemptState {
  id: string
  organization_id: string
  kind: string
  operation: string
  mailbox: string | null
  user_id: string | null
  session_id: string | null
  browser_binding_digest: string
  /** Unexpired at `now`, unconsumed, needing a mailbox proof that is not recorded yet. */
  awaiting: boolean
  /** Its provider (if any) is live at the frozen revision, and enabled for a sign-in or link. */
  current: boolean
  /** Its session (if any) is still that person's unexpired session. */
  session_live: boolean
}

/** Locks the attempt and reports what eligibility needs, all at the instant `now`. */
async function lockAttempt(trx: Db, attemptId: string, now: string) {
  const { rows } = await sql<AttemptState>`
    SELECT a.id, a.organization_id, a.kind, a.operation, a.mailbox, a.user_id, a.session_id,
      a.browser_binding_digest,
      (a.expires_at > ${now}::timestamptz AND a.consumed_at IS NULL AND a.requires_mailbox
        AND a.mailbox IS NOT NULL AND a.mailbox_proven_at IS NULL) AS awaiting,
      (a.provider_id IS NULL OR EXISTS (
        SELECT FROM sso_providers p WHERE p.id = a.provider_id
          AND p.revision = a.provider_revision AND p.retired_at IS NULL
          AND (p.enabled OR a.kind NOT IN ('sign_in', 'link')))) AS current,
      (a.session_id IS NULL OR EXISTS (
        SELECT FROM auth.session s WHERE s.id = a.session_id AND s."userId" = a.user_id
          AND s."expiresAt" > ${now}::timestamptz)) AS session_live
    FROM sso_attempts a WHERE a.id = ${attemptId}::uuid
    FOR UPDATE OF a`.execute(trx)
  return rows[0]
}

/**
 * Whether the presenter may act on the attempt: its own browser and, for every intent but a
 * pre-session sign-in, its own session and person. A sign-in attempt needs only the browser.
 */
function presentedBy(attempt: AttemptState, presenter: Presenter): boolean {
  if (!sameDigest(attempt.browser_binding_digest, presenter.binding)) return false
  if (attempt.session_id === null) return attempt.kind === 'sign_in'
  return (
    attempt.session_live &&
    presenter.sessionId === attempt.session_id &&
    presenter.userId === attempt.user_id
  )
}

const usable = (attempt: AttemptState | undefined, presenter: Presenter) =>
  attempt?.awaiting === true && attempt.current && presentedBy(attempt, presenter)

/** A job error carries no SSO storage row, address or token: names and codes only. */
function jobError(error: unknown, label: string): Error {
  const diagnostic = ssoStorageDiagnostic(error)
  return new Error(diagnostic ? `${label}: ${diagnostic}` : label)
}

export interface MailboxProofDeliveryDeps {
  capabilities: SsoCapabilities
  /** Enabled with SCIM resources to deliver mailbox proof for mapping consent. */
  scimMappingConsentEnabled?: boolean
  db: Db
  mailer: Mailer
  publicUrl: string
  /** BETTER_AUTH_SECRET, for the recipient budget's keyed address digest. */
  secret: string
  signInMailMaxPerHour?: number | undefined
  signInMailMaxPerDay?: number | undefined
  mailMaxPerHour?: number | undefined
  limits?: Partial<MailboxProofLimits> | undefined
  now?: MailboxProofClock | undefined
  log?: ((line: string) => void) | undefined
}

// Recovery and trust-reducing operations keep their mailbox proof while a setting is off.
function mailboxProofEnabled(capabilities: SsoCapabilities, mappingEnabled?: boolean) {
  return mappingEnabled || ssoRetained(capabilities)
}

function attemptEnabled(
  attempt: AttemptState,
  {
    capabilities,
    scimMappingConsentEnabled,
  }: Pick<MailboxProofDeliveryDeps, 'capabilities' | 'scimMappingConsentEnabled'>,
) {
  if (
    attempt.operation === samlLinkOperation ||
    attempt.operation === samlMailboxOperation ||
    attempt.operation === samlAdmissionOperation
  )
    return capabilities.ssoSamlEnabled
  return attempt.operation === SCIM_MAPPING_CONSENT
    ? scimMappingConsentEnabled === true
    : mailboxProofEnabled(capabilities)
}

/**
 * Delivers one queued proof email. Only here is the attempt read: an ineligible request ends
 * silently, so the send answer never depends on it. Rotation deletes the attempt's previous
 * token in the transaction that issues the next one; the raw token exists only in the email.
 */
export async function deliverMailboxProof(
  deps: MailboxProofDeliveryDeps,
  payload: MailboxProofEmailPayload,
  signal?: AbortSignal,
): Promise<void> {
  if (!mailboxProofEnabled(deps.capabilities, deps.scimMappingConsentEnabled)) return
  const limits = { ...MAILBOX_PROOF_LIMITS, ...deps.limits }
  const clock = deps.now ?? databaseClock
  let diagnostic: string | undefined
  try {
    diagnostic = await deps.db.transaction().execute(async (trx) => {
      const presenter = payload
      const attempt = await lockAttempt(trx, payload.attemptId, await clock(trx))
      if (!attempt || !usable(attempt, presenter) || !attemptEnabled(attempt, deps)) return
      const now = await clock(trx)
      const { rows: cooling } = await sql<{ cooling: boolean }>`
        SELECT issued_at > ${now}::timestamptz - make_interval(secs => ${limits.resendCooldownSeconds})
          AS cooling
        FROM sso_mailbox_tokens WHERE attempt_id = ${attempt.id}::uuid FOR UPDATE`.execute(trx)
      if (cooling[0]?.cooling) return
      // Every notification send is serialized; recheck the attempt after that wait.
      await lockNotificationEmailBudget(trx)
      signal?.throwIfAborted()
      const at = await clock(trx)
      const recheck = await lockAttempt(trx, attempt.id, at)
      if (!recheck || !usable(recheck, presenter) || recheck.mailbox === null) return
      const recipientHash = mailboxProofRecipientHash(recheck.mailbox, deps.secret)
      const reason = await signInEmailBudget(
        trx,
        {
          signInMailMaxPerHour: deps.signInMailMaxPerHour,
          signInMailMaxPerDay: deps.signInMailMaxPerDay,
          mailMaxPerHour: deps.mailMaxPerHour,
        },
        recipientHash,
        new Date(Date.parse(at)),
      )
      if (reason)
        return JSON.stringify({
          level: 'warn',
          event: 'sso_mailbox_proof_email_suppressed',
          reason,
          recipientHash: recipientHash.toString('hex'),
        })
      const token = randomBytes(32).toString('base64url')
      await sql`DELETE FROM sso_mailbox_tokens WHERE attempt_id = ${recheck.id}::uuid`.execute(trx)
      const { rows } = await sql<{ minutes: number }>`
        INSERT INTO sso_mailbox_tokens (token_digest, organization_id, attempt_id, issued_at, expires_at)
        SELECT ${sha256(token)}, a.organization_id, a.id, ${at}::timestamptz,
          least(a.expires_at, ${at}::timestamptz + make_interval(secs => ${limits.tokenLifetimeSeconds}))
        FROM sso_attempts a WHERE a.id = ${recheck.id}::uuid
        RETURNING greatest(1, ceil(extract(epoch FROM expires_at - ${at}::timestamptz) / 60))::int
          AS minutes`.execute(trx)
      const url = new URL(MAILBOX_PROOF_CONFIRM_PATH, deps.publicUrl)
      url.hash = new URLSearchParams({ attempt: recheck.id, token }).toString()
      try {
        await deps.mailer.send(
          mailboxProofEmail({
            to: recheck.mailbox,
            url: url.href,
            expiresInMinutes: rows[0]?.minutes ?? 1,
            language: payload.language,
          }),
          { signal },
        )
      } catch {
        // SMTP replies can repeat the recipient: never chained into the job log.
        throw new Error('SSO mailbox proof email could not be sent')
      }
      await trx
        .insertInto('notification_email_sends')
        .values({ recipient_hash: recipientHash, sent_at: new Date(Date.parse(at)) })
        .execute()
      return undefined
    })
  } catch (error) {
    throw jobError(error, 'SSO mailbox proof delivery failed')
  }
  if (diagnostic) (deps.log ?? console.warn)(diagnostic)
}

export interface MailboxProofConsumeDeps {
  capabilities: SsoCapabilities
  /** Allow mailbox proof for SCIM mapping consent when provisioning is enabled. */
  scimMappingConsentEnabled?: boolean
  db: Db
  limits?: Partial<MailboxProofLimits> | undefined
  now?: MailboxProofClock | undefined
  /** Wrong tokens per attempt, counted only for the attempt's own browser and session. */
  guesses: RateLimiter
}

/**
 * Records a mailbox proof on the attempt when the token is its current, unexpired, unconsumed
 * one and the presenter is the attempt's own browser (and session). True only then; every
 * other outcome is the same refusal.
 */
export async function consumeMailboxProof(
  deps: MailboxProofConsumeDeps,
  input: { attemptId: string; token: string },
  presenter: Presenter,
): Promise<boolean> {
  if (!deps.scimMappingConsentEnabled) requireSsoRetained(deps.capabilities)
  const clock = deps.now ?? databaseClock
  return deps.db.transaction().execute(async (trx) => {
    // Take the row locks first (a delivery may hold the attempt through SMTP), then read the
    // instant every check and write of this transaction uses.
    await sql`SELECT 1 FROM sso_attempts WHERE id = ${input.attemptId}::uuid FOR UPDATE`.execute(
      trx,
    )
    await sql`SELECT 1 FROM sso_mailbox_tokens WHERE attempt_id = ${input.attemptId}::uuid
      FOR UPDATE`.execute(trx)
    const now = await clock(trx)
    const attempt = await lockAttempt(trx, input.attemptId, now)
    if (!attempt || !usable(attempt, presenter) || !attemptEnabled(attempt, deps)) return false
    const { rows } = await sql<{ token_digest: string; live: boolean }>`
      SELECT token_digest, (consumed_at IS NULL AND expires_at > ${now}::timestamptz) AS live
      FROM sso_mailbox_tokens WHERE attempt_id = ${attempt.id}::uuid FOR UPDATE`.execute(trx)
    const token = rows[0]
    if (!token?.live) return false
    if (!sameDigest(token.token_digest, sha256(input.token))) {
      // The attempt's own browser guessed wrong: after the cap its token is gone, and only a
      // resend (bounded by the cooldown and the recipient budget) issues another.
      if (deps.guesses.hit(attempt.id) !== undefined)
        await sql`DELETE FROM sso_mailbox_tokens WHERE attempt_id = ${attempt.id}::uuid`.execute(
          trx,
        )
      return false
    }
    await sql`UPDATE sso_mailbox_tokens SET consumed_at = ${now}::timestamptz
      WHERE attempt_id = ${attempt.id}::uuid`.execute(trx)
    await sql`UPDATE sso_attempts a SET mailbox_proven_at = ${now}::timestamptz,
        mailbox_proof_expires_at = t.expires_at
      FROM sso_mailbox_tokens t WHERE t.attempt_id = a.id AND a.id = ${attempt.id}::uuid`.execute(
      trx,
    )
    return true
  })
}

/**
 * Deletes at most `limit` expired or spent attempts and cascades their mailbox tokens.
 * Completed recovery attempts remain until the mailbox deadline or a repair spends them.
 */
export async function cleanupSsoAttempts(
  db: Db,
  limit: number = MAILBOX_PROOF_LIMITS.cleanupBatch,
) {
  const { rows } = await sql<{ deleted: string }>`
    WITH gone AS (
      DELETE FROM sso_attempts WHERE id IN (
        SELECT id FROM sso_attempts
        WHERE expires_at <= clock_timestamp() OR (consumed_at IS NOT NULL AND (
          operation IS DISTINCT FROM ${USE_SSO_RECOVERY}
          OR mailbox_proof_expires_at <= clock_timestamp()
        ))
        ORDER BY expires_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING 1)
    SELECT count(*)::text AS deleted FROM gone`.execute(db)
  return Number(rows[0]?.deleted ?? 0)
}

/** The worker side: delivery of queued proofs, and the bounded cleanup in every flag state. */
export function mailboxProofJobs(deps: MailboxProofDeliveryDeps) {
  return [
    defineJob({
      name: MAILBOX_PROOF_EMAIL_JOB,
      payload: MailboxProofEmailPayload,
      policy: 'exclusive',
      concurrency: 2,
      retry: { limit: 3, delaySeconds: 5, backoff: true, maxDelaySeconds: 30 },
      expireInSeconds: 60,
      retentionSeconds: 300,
      deleteAfterSeconds: 60,
      handler: (payload, { signal }) => deliverMailboxProof(deps, payload, signal),
    }),
    defineJob({
      name: SSO_ATTEMPT_CLEANUP_JOB,
      payload: z.strictObject({}),
      policy: 'exclusive',
      schedule: { cron: '* * * * *', payload: {} },
      handler: async () => {
        try {
          await cleanupSsoAttempts(deps.db, deps.limits?.cleanupBatch)
        } catch (error) {
          throw jobError(error, 'SSO attempt cleanup failed')
        }
      },
    }),
  ] as const
}

export interface MailboxProofModule {
  mount(shared: {
    app: OpenAPIHono
    resolveCaller: CallerResolver
    publicUrl: string
    scimMappingConsentEnabled?: boolean
  }): void
}

export const MailboxProofSendInput = z.strictObject({ attemptId: z.uuid() })
export const MailboxProofConsumeInput = MailboxProofSendInput.extend({
  token: z.string().min(1).max(256),
})

/**
 * The two endpoints. createApp mounts them ahead of Better Auth's `/api/auth/*`, in every
 * flag state, so that each answers `404 sso_disabled` itself while every protocol is off.
 */
export function mailboxProofRoutes(deps: {
  capabilities: SsoCapabilities
  db: Db
  queue: MailboxProofQueue
  limits?: Partial<MailboxProofLimits> | undefined
  now?: MailboxProofClock | undefined
}): MailboxProofModule {
  const limits = { ...MAILBOX_PROOF_LIMITS, ...deps.limits }
  const sends = createRateLimiter({ limit: limits.sendsPerSourcePerMinute, windowSeconds: 60 })
  const consumes = createRateLimiter({
    limit: limits.consumesPerSourcePerMinute,
    windowSeconds: 60,
  })
  // An attempt lives at most authenticationAttemptLifetime (600 seconds).
  const guesses = createRateLimiter({ limit: limits.guessesPerAttempt - 1, windowSeconds: 600 })
  return {
    mount({ app, resolveCaller, publicUrl, scimMappingConsentEnabled = false }) {
      const origin = new URL(publicUrl).origin
      const cookie = bindingCookieName(publicUrl)

      /** The checks both endpoints share, in order; a Response ends the request. */
      async function admit<T>(
        c: Context,
        limiter: RateLimiter,
        schema: z.ZodType<T>,
      ): Promise<Response | { input: T; presenter: Presenter; language: InterfaceLanguage }> {
        // While every protocol is off: before Origin, input, rate limits or any lookup.
        if (!scimMappingConsentEnabled) requireSsoRetained(deps.capabilities)
        c.header('Cache-Control', 'no-store')
        if (c.req.method !== 'POST') return c.json({ error: 'method_not_allowed' }, 405)
        // A protocol endpoint, not a product write: exact Origin, never a Referer or a key.
        if (c.req.header('origin') !== origin || c.req.header('authorization') !== undefined)
          return c.json({ error: 'forbidden' }, 403)
        let body: unknown
        try {
          body = await c.req.json()
        } catch {
          return c.json({ error: 'invalid_request' }, 400)
        }
        const parsed = schema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
        const wait = limiter.hit(rateLimitKey(c.var.clientIp))
        if (wait !== undefined) {
          c.header('Retry-After', String(wait))
          return c.json({ error: 'rate_limited' }, 429)
        }
        let sessionId: string | null = null
        let userId: string | null = null
        if (c.req.header('cookie')) {
          const caller = await resolveCaller(withClientIpHeader(c.req.raw.headers, c.var.clientIp))
          for (const value of caller.setCookie) c.header('Set-Cookie', value, { append: true })
          if (!caller.ok && caller.error === 'rate_limited') {
            if (caller.retryAfterSeconds !== null)
              c.header('Retry-After', String(caller.retryAfterSeconds))
            return c.json({ error: 'rate_limited' }, 429)
          }
          if (caller.ok && caller.principal.kind === 'session') {
            sessionId = caller.principal.sessionId
            userId = caller.principal.user.id
          }
        }
        return {
          input: parsed.data,
          presenter: { binding: browserBindingDigest(getCookie(c, cookie)), sessionId, userId },
          language: resolveAdminLanguage({
            cookie: c.req.header('cookie'),
            acceptLanguage: c.req.header('accept-language'),
          }),
        }
      }

      app.all(MAILBOX_PROOF_SEND_PATH, async (c) => {
        const admitted = await admit(c, sends, MailboxProofSendInput)
        if (admitted instanceof Response) return admitted
        const { input, presenter, language } = admitted
        // No attempt lookup here: the worker decides, so every answer is the same.
        await deps.queue.enqueue(
          MAILBOX_PROOF_EMAIL_JOB,
          { attemptId: input.attemptId, ...presenter, language },
          { singletonKey: `${input.attemptId}:${presenter.binding ?? 'none'}` },
        )
        return c.json(QUEUED, 202)
      })

      app.all(MAILBOX_PROOF_CONSUME_PATH, async (c) => {
        const admitted = await admit(c, consumes, MailboxProofConsumeInput)
        if (admitted instanceof Response) return admitted
        const proven = await consumeMailboxProof(
          { ...deps, scimMappingConsentEnabled, limits, guesses },
          admitted.input,
          admitted.presenter,
        )
        return proven ? c.json({ status: 'proven' }, 200) : c.json(INVALID, 400)
      })
    },
  }
}
