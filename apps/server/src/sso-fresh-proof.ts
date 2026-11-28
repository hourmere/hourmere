/** Shared, session-only gate for writes requiring fresh SSO or mailbox proof. */
import { randomBytes } from 'node:crypto'
import type { Database, Db } from '@hourmere/db'
import {
  checkTeamWriteBeforeAuthorityChange,
  checkTeamWriteDeadline,
  teamWriteTransaction,
} from '@hourmere/db/team-write'
import { DomainError } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { sql, type Transaction } from 'kysely'
import { z } from 'zod'
import {
  enabledSsoProtocols,
  isCustomRoleProofOperation,
  isOwnershipTransferProofOperation,
  requireSsoEnabled,
  requireSsoRetained,
  SCIM_MAPPING_CONSENT,
  type SsoCapabilities,
} from './sso.ts'
import {
  bindingCookieName,
  browserBindingDigest,
  databaseClock,
  type MailboxProofClock,
  readBindingCookie,
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
  /** An affected account whose login mailbox must stay stable through the write. */
  affectedUserId?: string | undefined
  /** Accounts whose accepted recovery standing is used to preserve team access. */
  recoveryUserIds?: string[]
  sessionId: string
  organizationId: string
  operation: string
  /** Mapping consent can request mailbox proof without SSO. */
  scimMappingConsentEnabled?: boolean
  customRolesEnabled?: boolean
  /** Trust reduction uses administration proof and points to recovery when step-up is unavailable. */
  proofMode?: 'mailbox' | 'sso' | 'administration' | 'trust_reduction'
  input: unknown
  /** The operation's input without proofAttemptId. Unknown properties are always refused. */
  schema: z.ZodObject
}

function requireSsoStepUpAvailable(
  capabilities: SsoCapabilities,
  proofMode: FreshProofRequest['proofMode'],
) {
  if (
    proofMode === 'trust_reduction' &&
    !capabilities.ssoOidcEnabled &&
    !capabilities.ssoSamlEnabled
  )
    throw new DomainError('forbidden', 'sso_required')
  requireSsoEnabled(capabilities)
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

interface RecoveryAuthority {
  id: string
  deadline: string
  acceptedAt: string
}

export interface RecoveryProofContext {
  preflight: boolean
  enforced: boolean
  hasProofAttempt: boolean
  preparedGrantId: string | undefined
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
    /** The session context fence must be acquired before user and organization locks. */
    beforeLocks?: (trx: Transaction<Database>) => Promise<void>
    authorize: (trx: Transaction<Database>) => Promise<void>
    /** A locked lifecycle write can commit a terminal result without consuming proof. */
    beforeProof?: (trx: Transaction<Database>) => Promise<T | undefined>
    /** The operation can revoke the acting session's team proof in this transaction. */
    changesAuthority?: boolean
    /** Only a recovery-enabled operation supplies this and consumes authority under the team lock. */
    consumeRecovery?: (
      trx: Db,
      binding: string,
      now: string,
      context: RecoveryProofContext,
    ) => Promise<RecoveryAuthority | undefined>
    /** A target can be eligible for recovery while remaining unavailable to ordinary proof. */
    authorizeOrdinary?: () => void
    /** Optional I/O after preflight, outside the transaction. Authority is checked again. */
    prepare?: () => Promise<void>
    mutate: (
      trx: Transaction<Database>,
      input: Record<string, unknown>,
      browserBinding: string,
      mailboxProof: FreshMailboxProof | undefined,
      attemptId: string,
      recovery?: RecoveryAuthority,
    ) => Promise<T>
  },
): Promise<FreshProofResult<T>> {
  const ownershipTransfer = isOwnershipTransferProofOperation(request.operation)
  if (request.operation === SCIM_MAPPING_CONSENT) {
    if (!request.scimMappingConsentEnabled)
      throw new DomainError('not_found', 'scim_resources_disabled')
  } else if (isCustomRoleProofOperation(request.operation)) {
    if (!request.customRolesEnabled) throw new DomainError('not_found', 'custom_roles_disabled')
  } else if (!ownershipTransfer) {
    requireSsoRetained(deps.capabilities)
  }
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
  let browserBinding = readBindingCookie(request.headers, cookieName) ?? ''
  let binding = browserBindingDigest(browserBinding)
  let setCookie: string | undefined
  if (binding === null) {
    browserBinding = randomBytes(32).toString('base64url')
    binding = sha256(browserBinding)
    setCookie = `${cookieName}=${browserBinding}; Path=/; HttpOnly; SameSite=Strict${publicUrl.protocol === 'https:' ? '; Secure' : ''}`
  }
  const cookie = setCookie === undefined ? {} : { setCookie }
  const clock = deps.now ?? databaseClock
  const lockedUsers = [
    request.userId,
    request.affectedUserId ?? request.userId,
    ...(request.recoveryUserIds ?? []),
  ]
  const prepare = Symbol('prepare')
  let preparedGrantId: string | undefined
  const run = (prepared: boolean): Promise<FreshProofResult<T> | typeof prepare> =>
    teamWriteTransaction(deps.db.transaction(), async (trx) => {
      await callbacks.beforeLocks?.(trx)
      // Follow the shared team-write lock order: person, organization, then session/attempt.
      await sql`SELECT id FROM auth."user"
      WHERE id = ANY(${lockedUsers}::uuid[])
      ORDER BY id FOR SHARE`.execute(trx)
      // All team authority changes use the organization parent as their serialization point.
      const organization = await sql`SELECT id FROM auth.organization
      WHERE id = ${request.organizationId}::uuid FOR UPDATE`.execute(trx)
      if (organization.rows.length === 0) throw new HTTPException(403, { message: 'forbidden' })
      await callbacks.authorize(trx)
      // Session deletion/expiry and proof expiry are checked after all potentially waiting locks.
      await sql`SELECT id FROM auth.session WHERE id = ${request.sessionId}::uuid FOR SHARE`.execute(
        trx,
      )
      const { rows: policies } = await sql<{ require_sso: boolean; trust_generation: number }>`
      SELECT require_sso, trust_generation FROM sso_policies
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
      const terminal = await callbacks.beforeProof?.(trx)
      if (terminal !== undefined) return { status: 'complete', value: terminal, ...cookie }
      const recovery = await callbacks.consumeRecovery?.(trx, binding, now, {
        preflight: !prepared,
        enforced: policies[0]?.require_sso === true,
        hasProofAttempt: proofAttemptId !== undefined,
        preparedGrantId,
      })
      if (recovery) {
        const checked = await checkTeamWriteBeforeAuthorityChange(trx, recovery)
        if (!prepared) {
          preparedGrantId = recovery.id
          return prepare
        }
        const value = await callbacks.mutate(
          trx,
          input,
          browserBinding,
          undefined,
          recovery.id,
          recovery,
        )
        if (checked === undefined)
          await checkTeamWriteDeadline(trx, recovery.deadline, () => {
            throw new DomainError('forbidden', 'sso_required')
          })
        return { status: 'complete', value, ...cookie }
      }
      callbacks.authorizeOrdinary?.()
      const independentMailbox = request.proofMode === 'mailbox'
      const delegatedSso = request.proofMode === 'sso'
      const policy = policies[0]
      const needsSso = delegatedSso || (!independentMailbox && policy?.require_sso === true)
      const trustGeneration = needsSso ? (policy?.trust_generation ?? 1) : null
      if (needsSso) requireSsoStepUpAvailable(deps.capabilities, request.proofMode)
      const needsMailbox = !needsSso
      if (proofAttemptId) {
        const { rows } = await sql<{
          id: string
          expires_at: string
          requires_mailbox: boolean
          requires_sso: boolean
          mailbox_live: boolean
          sso_live: boolean
          proven_at: string | null
          proof_expires_at: string | null
        }>`SELECT id, expires_at::text, requires_mailbox, requires_sso,
          mailbox_proven_at::text AS proven_at,
          mailbox_proof_expires_at::text AS proof_expires_at,
          step_up_link_id IS NOT NULL AS sso_live,
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
          AND (NOT ${independentMailbox || ((ownershipTransfer || request.customRolesEnabled) && needsMailbox)} OR mailbox = ${mailbox})
          AND (requires_mailbox OR NOT ${needsMailbox})
          AND (step_up_link_id IS NULL OR (
            step_up_proof_expires_at > ${now}::timestamptz
            AND step_up_trust_generation = ${trustGeneration}::integer
            AND (NOT requires_mailbox OR mailbox = ${mailbox})
            AND EXISTS (
              SELECT 1 FROM sso_identity_links l JOIN sso_providers p ON p.id = l.provider_id
              WHERE l.id = step_up_link_id AND l.user_id = sso_attempts.user_id
                AND l.organization_id = sso_attempts.organization_id
                AND p.id = step_up_provider_id
                AND p.protocol = ANY(${enabledSsoProtocols(deps.capabilities)}::text[])
                AND l.retired_at IS NULL AND p.enabled AND p.retired_at IS NULL
            )
          ))`.execute(trx)
        const attempt = rows[0]
        if (attempt) {
          const remaining: string[] = []
          if (attempt.requires_mailbox && !attempt.mailbox_live) remaining.push('mailbox')
          if (attempt.requires_sso && !attempt.sso_live) remaining.push('sso')
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
          if (callbacks.changesAuthority) await checkTeamWriteBeforeAuthorityChange(trx)
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
              attempt.id,
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
