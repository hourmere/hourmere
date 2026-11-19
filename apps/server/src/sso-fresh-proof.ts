/** Shared, session-only SSO write gate. No route enables this while protocols are off. */
import { randomBytes } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { sql } from 'kysely'
import { z } from 'zod'
import { requireSsoEnabled, type SsoCapabilities } from './sso.ts'
import {
  bindingCookieName,
  browserBindingDigest,
  databaseClock,
  type MailboxProofClock,
  sha256,
} from './sso-mailbox-proof.ts'

export interface FreshProofDeps {
  db: Db
  capabilities: SsoCapabilities
  publicUrl: string
  /** Comparison clock for expiry checks; new attempts always use their actual database issuance time. */
  now?: MailboxProofClock | undefined
}

export interface FreshProofRequest {
  headers: Headers
  /** Resolved cookie-session principal; the gate rechecks its stored lifetime and person. */
  userId: string
  sessionId: string
  organizationId: string
  operation: string
  /** Independent local proof is required even on teams with SSO enforcement. */
  proofMode?: 'mailbox'
  input: unknown
  /** The operation's input without proofAttemptId. Unknown properties are always refused. */
  schema: z.ZodObject
}

export type FreshProofResult<T> =
  | {
      status: 'proof_required'
      body: {
        error: 'sso_reauthentication_required'
        attemptId: string
        proofMethods: string[]
        expiresAt: string
      }
      setCookie?: string
    }
  | { status: 'complete'; value: T; setCookie?: string }

interface FreshMailboxProof {
  mailbox: string
  provenAt: string
  expiresAt: string
}

/** Nested Zod objects may strip unknown keys; none may silently disappear from the retry. */
function retainsInputKeys(raw: unknown, parsed: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return true
  if (parsed === null || typeof parsed !== 'object') return false
  if (Array.isArray(raw) !== Array.isArray(parsed)) return false
  return Object.entries(raw).every(
    ([key, value]) =>
      Object.hasOwn(parsed, key) &&
      retainsInputKeys(value, (parsed as Record<string, unknown>)[key]),
  )
}

/** JSON object order is irrelevant, while array order and scalar types remain significant. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  throw new DomainError('invalid', 'invalid_request')
}

/**
 * Returns the proof challenge instead of throwing it, so its attempt commits. Only the
 * successful branch consumes proof and runs mutate in the same transaction. authorize must
 * check current role, expected team and operation-specific authority/revisions, and must not
 * write. It runs under the organization lock on both initial requests and retries. Adapters
 * must return proof_required as HTTP 403 and append setCookie to the response when present.
 */
export async function runWithFreshProof<T>(
  deps: FreshProofDeps,
  request: FreshProofRequest,
  callbacks: {
    authorize: (trx: Db) => Promise<void>
    /** Optional I/O after preflight, outside the transaction. Authority is checked again. */
    prepare?: () => Promise<void>
    mutate: (
      trx: Db,
      input: Record<string, unknown>,
      browserBinding: string,
      mailboxProof: FreshMailboxProof | undefined,
    ) => Promise<T>
  },
): Promise<FreshProofResult<T>> {
  requireSsoEnabled(deps.capabilities)
  const publicUrl = new URL(deps.publicUrl)
  if (request.headers.get('origin') !== publicUrl.origin || request.headers.has('authorization'))
    throw new HTTPException(403, { message: 'forbidden' })
  const parsed = request.schema
    .extend({ proofAttemptId: z.uuid().optional() })
    .strict()
    .safeParse(request.input)
  if (!parsed.success || !retainsInputKeys(request.input, parsed.data))
    throw new DomainError('invalid', 'invalid_request')
  const { proofAttemptId, ...input } = parsed.data
  const inputDigest = sha256(canonical(input))
  const cookieName = bindingCookieName(deps.publicUrl)
  const cookieValue =
    request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1) ?? ''
  let browserBinding = cookieValue
  let binding = browserBindingDigest(browserBinding)
  let setCookie: string | undefined
  if (binding === null) {
    browserBinding = randomBytes(32).toString('base64url')
    binding = sha256(browserBinding)
    setCookie = `${cookieName}=${browserBinding}; Path=/; HttpOnly; SameSite=Strict${publicUrl.protocol === 'https:' ? '; Secure' : ''}`
  }
  const cookie = setCookie === undefined ? {} : { setCookie }
  const clock = deps.now ?? databaseClock
  const prepare = Symbol('prepare')
  const run = (prepared: boolean) =>
    deps.db.transaction().execute(async (trx): Promise<FreshProofResult<T> | typeof prepare> => {
      // Follow the shared team-write lock order: person, organization, then session/attempt.
      await sql`SELECT id FROM auth."user" WHERE id = ${request.userId}::uuid FOR SHARE`.execute(
        trx,
      )
      // All team authority changes use the organization parent as their serialization point.
      const organization = await sql`SELECT id FROM auth.organization
      WHERE id = ${request.organizationId}::uuid FOR UPDATE`.execute(trx)
      if (organization.rows.length === 0) throw new HTTPException(403, { message: 'forbidden' })
      await callbacks.authorize(trx)
      // Session deletion/expiry and proof expiry are checked after all potentially waiting locks.
      await sql`SELECT id FROM auth.session WHERE id = ${request.sessionId}::uuid FOR SHARE`.execute(
        trx,
      )
      await sql`SELECT organization_id FROM sso_policies
      WHERE organization_id = ${request.organizationId}::uuid FOR SHARE`.execute(trx)
      if (proofAttemptId)
        await sql`SELECT id FROM sso_attempts WHERE id = ${proofAttemptId}::uuid FOR UPDATE`.execute(
          trx,
        )
      const now = await clock(trx)
      const session = await sql<{ mailbox: string }>`SELECT lower(btrim(u.email)) AS mailbox
      FROM auth.session s JOIN auth."user" u ON u.id = s."userId"
      WHERE s.id = ${request.sessionId}::uuid AND s."userId" = ${request.userId}::uuid
        AND s."expiresAt" > ${now}::timestamptz`.execute(trx)
      const mailbox = session.rows[0]?.mailbox
      if (!mailbox) throw new HTTPException(403, { message: 'forbidden' })
      const policy = await sql<{ require_sso: boolean }>`SELECT require_sso FROM sso_policies
      WHERE organization_id = ${request.organizationId}::uuid`.execute(trx)
      const independentMailbox = request.proofMode === 'mailbox'
      const needsSso = !independentMailbox && policy.rows[0]?.require_sso === true
      const needsMailbox = !needsSso
      if (proofAttemptId) {
        const { rows } = await sql<{
          id: string
          expires_at: string
          requires_mailbox: boolean
          requires_sso: boolean
          mailbox_live: boolean
          proven_at: string | null
          proof_expires_at: string | null
        }>`SELECT id, expires_at::text, requires_mailbox, requires_sso,
          mailbox_proven_at::text AS proven_at,
          mailbox_proof_expires_at::text AS proof_expires_at,
          (mailbox_proven_at IS NOT NULL AND mailbox_proof_expires_at > ${now}::timestamptz)
            AS mailbox_live
        FROM sso_attempts
        WHERE id = ${proofAttemptId}::uuid AND kind = 'fresh_proof'
          AND organization_id = ${request.organizationId}::uuid
          AND user_id = ${request.userId}::uuid AND session_id = ${request.sessionId}::uuid
          AND browser_binding_digest = ${binding} AND operation = ${request.operation}
          AND input_digest = ${inputDigest} AND consumed_at IS NULL
          AND expires_at > ${now}::timestamptz
          AND (mailbox_proven_at IS NULL OR mailbox_proof_expires_at > ${now}::timestamptz)
          AND requires_sso = ${needsSso}
          AND (NOT ${independentMailbox} OR mailbox = ${mailbox})
          AND (requires_mailbox OR NOT ${needsMailbox})`.execute(trx)
        const attempt = rows[0]
        if (attempt) {
          const remaining: string[] = []
          if (attempt.requires_mailbox && !attempt.mailbox_live) remaining.push('mailbox')
          // SSO proof cannot be satisfied until the protocol's step-up implementation exists.
          if (attempt.requires_sso) remaining.push('sso')
          if (remaining.length > 0)
            return {
              status: 'proof_required',
              body: {
                error: 'sso_reauthentication_required',
                attemptId: attempt.id,
                proofMethods: remaining,
                expiresAt: new Date(attempt.expires_at).toISOString(),
              },
              ...cookie,
            }
          if (!prepared) return prepare
          await sql`UPDATE sso_attempts SET consumed_at = ${now}::timestamptz
          WHERE id = ${attempt.id}::uuid`.execute(trx)
          return {
            status: 'complete',
            value: await callbacks.mutate(
              trx,
              input,
              browserBinding,
              attempt.proven_at && attempt.proof_expires_at
                ? { mailbox, provenAt: attempt.proven_at, expiresAt: attempt.proof_expires_at }
                : undefined,
            ),
            ...cookie,
          }
        }
      }
      const issuedAt = await databaseClock(trx)
      const { rows } = await sql<{ id: string; expires_at: string }>`INSERT INTO sso_attempts
      (kind, organization_id, user_id, session_id, browser_binding_digest, operation, input_digest,
       requires_mailbox, requires_sso, mailbox, created_at, expires_at)
      VALUES ('fresh_proof', ${request.organizationId}::uuid, ${request.userId}::uuid,
        ${request.sessionId}::uuid, ${binding}, ${request.operation}, ${inputDigest},
        ${needsMailbox}, ${needsSso}, ${mailbox}, ${issuedAt}::timestamptz,
        ${issuedAt}::timestamptz + interval '600 seconds')
      RETURNING id, expires_at::text`.execute(trx)
      const attempt = rows[0]
      if (!attempt) throw new Error('Fresh proof attempt was not created')
      return {
        status: 'proof_required',
        body: {
          error: 'sso_reauthentication_required',
          attemptId: attempt.id,
          proofMethods: needsSso ? ['sso'] : ['mailbox'],
          expiresAt: new Date(attempt.expires_at).toISOString(),
        },
        ...cookie,
      }
    })
  const preflight = await run(!callbacks.prepare)
  if (preflight !== prepare) return preflight
  await callbacks.prepare?.()
  const result = await run(true)
  if (result === prepare) throw new Error('Fresh proof preparation did not complete')
  return result
}
