import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { domainToASCII } from 'node:url'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { auditActor, writeSsoAuditEvent } from '@hourmere/db/audit'
import { resolveSsoDomainTxt, ssoPublicName } from '@hourmere/outbound/sso'
import { DomainError } from '@hourmere/scheduling'
import { HTTPException } from 'hono/http-exception'
import { sql } from 'kysely'
import { parse } from 'tldts'
import { z } from 'zod'
import { requireSsoEnabled } from './sso.ts'
import { type FreshProofDeps, runWithFreshProof } from './sso-fresh-proof.ts'
import { databaseClock } from './sso-mailbox-proof.ts'
import { authorizeSsoRead } from './sso-reads.ts'
import { EXPECTED_ORGANIZATION_HEADER, organizationContextAccess } from './team-management.ts'

export interface SsoDomainDeps extends FreshProofDeps {
  /** The trusted server resolver, never a client-supplied lookup result. */
  resolveTxt?: ((name: string) => Promise<string[][]>) | undefined
}
export const SSO_DOMAIN_LIMITS = Object.freeze({
  domainChallengeLifetime: 86400,
  domainRecheckInterval: 86400,
  domainVerificationLifetime: 604800,
})
// Shared consumer mailbox namespaces cannot establish a team's mail authority.
const publicMailDomains = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'fastmail.com',
  'fastmail.fm',
  'hey.com',
  'mail.com',
  'gmx.com',
  'gmx.net',
  'qq.com',
  '163.com',
  '126.com',
  'yandex.com',
  'yandex.ru',
])
export function normalizeSsoDomain(value: string): string | undefined {
  if (
    /[\s/\\?#:@*%]/u.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return undefined
  const ascii = domainToASCII(value).toLowerCase()
  if (ascii.endsWith('..')) return undefined
  const name = ascii.replace(/\.$/, '')
  if (
    !name ||
    name.length + '_hourmere-sso.'.length > 253 ||
    !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)
  )
    return undefined
  const parsed = parse(name, { allowPrivateDomains: true })
  if (!parsed.domain || (!parsed.isIcann && !parsed.isPrivate) || parsed.isIp) return undefined
  if (publicMailDomains.has(parsed.domain)) return undefined
  if (!ssoPublicName(new URL(`https://${name}`))) return undefined
  return name
}
const domainName = z
  .string()
  .max(1024)
  .transform((value, ctx) => {
    const normalized = normalizeSsoDomain(value)
    if (normalized === undefined) {
      ctx.addIssue({ code: 'custom', message: 'Invalid domain' })
      return z.NEVER
    }
    return normalized
  })
const create = z.strictObject({ domain: domainName })
const generation = z.strictObject({ expectedGeneration: z.number().int().min(1).max(2147483646) })
const proof = { proofAttemptId: z.uuid().optional() }
export const CreateSsoDomainChallengeInput = create.extend(proof)
export const VerifySsoDomainInput = generation.extend(proof)
export const DeleteSsoDomainInput = generation.extend(proof)
const denied = () => new DomainError('forbidden', 'team_management_access_denied')
const missing = () => new DomainError('not_found', 'sso_not_found')
const changed = () => new DomainError('conflict', 'sso_configuration_changed')
const unverified = () => new DomainError('conflict', 'sso_domain_unverified')
function uniformDenial(error: unknown): never {
  if (error instanceof HTTPException && error.status === 403) throw denied()
  throw error
}
function enabled(deps: SsoDomainDeps, principal: Principal) {
  requireSsoEnabled(deps.capabilities)
  if (principal.kind !== 'session' || principal.organization.personal) throw denied()
  return principal
}
async function authorize(deps: SsoDomainDeps, db: Db, principal: Principal, headers: Headers) {
  await authorizeSsoRead({ ...deps, db }, principal)
  await organizationContextAccess(
    principal,
    headers.get(EXPECTED_ORGANIZATION_HEADER) ?? undefined,
    true,
    true,
  )(db, principal.organization.id)
}
// All domain operations take the same instance-wide exact-name lock, after the team lock.
async function lockDomain(db: Db, name: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sso-domain:${name}`}, 0))`.execute(db)
}
async function domain(db: Db, organizationId: string, id: string) {
  if (!z.uuid().safeParse(id).success) throw missing()
  const row = await db
    .selectFrom('sso_domains')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('id', '=', id)
    .where('retired_at', 'is', null)
    .executeTakeFirst()
  if (!row) throw missing()
  return row
}
type Domain = Awaited<ReturnType<typeof domain>>
function summary(row: Domain, now: string) {
  return {
    id: row.id,
    name: row.name,
    generation: row.generation,
    status: !row.verified_at
      ? row.last_check_outcome === 'unknown'
        ? 'unknown'
        : row.last_check_outcome === 'failed'
          ? 'failed'
          : 'pending'
      : !row.verification_expires_at ||
          new Date(row.verification_expires_at).getTime() <= Date.parse(now)
        ? 'expired'
        : row.last_check_outcome === 'positive'
          ? 'verified'
          : row.last_check_outcome === 'failed'
            ? 'failed'
            : 'unknown',
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    verificationExpiresAt: row.verification_expires_at
      ? new Date(row.verification_expires_at).toISOString()
      : null,
    nextCheckAt: row.next_check_at ? new Date(row.next_check_at).toISOString() : null,
  }
}
function digest(
  deps: SsoDomainDeps,
  row: Pick<Domain, 'organization_id' | 'name' | 'generation'>,
  value: string,
) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        new URL(deps.publicUrl).origin,
        row.organization_id,
        row.name,
        row.generation,
        value,
      ]),
    )
    .digest('hex')
}
async function audit(
  db: Db,
  p: Principal,
  id: string,
  action: 'sso_domain.challenged' | 'sso_domain.verified' | 'sso_domain.released',
) {
  await writeSsoAuditEvent(db, {
    ...auditActor(p),
    organizationId: p.organization.id,
    action,
    targetType: 'sso_domain',
    targetId: id,
    details: {},
  })
}
export async function createSsoDomainChallenge(
  deps: SsoDomainDeps,
  principal: Principal,
  headers: Headers,
  input: unknown,
) {
  const p = enabled(deps, principal)
  return runWithFreshProof(
    deps,
    {
      headers,
      userId: p.user.id,
      sessionId: p.sessionId,
      organizationId: p.organization.id,
      operation: 'createSsoDomainChallenge',
      input,
      schema: create,
    },
    {
      authorize: async (db) => {
        await authorize(deps, db, p, headers)
        await lockDomain(db, CreateSsoDomainChallengeInput.parse(input).domain)
      },
      mutate: async (db, raw) => {
        const { domain: name } = create.parse(raw)
        const previous = await db
          .selectFrom('sso_domains')
          .selectAll()
          .where('organization_id', '=', p.organization.id)
          .where('name', '=', name)
          .where('retired_at', 'is', null)
          .executeTakeFirst()
        const now = await (deps.now ?? databaseClock)(db)
        const nextGeneration = (previous?.generation ?? 0) + 1
        const txtValue = `hourmere-sso=${randomBytes(32).toString('base64url')}`
        const expiresAt = new Date(
          Date.parse(now) + SSO_DOMAIN_LIMITS.domainChallengeLifetime * 1000,
        ).toISOString()
        const challengeDigest = digest(
          deps,
          { organization_id: p.organization.id, name, generation: nextGeneration },
          txtValue,
        )
        const row = previous
          ? await db
              .updateTable('sso_domains')
              .set({
                generation: nextGeneration,
                challenge_digest: challengeDigest,
                challenge_expires_at: expiresAt,
                verified_at: null,
                verification_expires_at: null,
                last_checked_at: null,
                last_check_outcome: null,
                next_check_at: null,
              })
              .where('id', '=', previous.id)
              .returningAll()
              .executeTakeFirstOrThrow()
          : await db
              .insertInto('sso_domains')
              .values({
                organization_id: p.organization.id,
                name,
                challenge_digest: challengeDigest,
                challenge_expires_at: expiresAt,
              })
              .returningAll()
              .executeTakeFirstOrThrow()
        await audit(db, p, row.id, 'sso_domain.challenged')
        return {
          domain: { id: row.id, name: row.name, generation: row.generation, status: 'pending' },
          txtName: `_hourmere-sso.${name}`,
          txtValue,
          expiresAt,
        }
      },
    },
  ).catch(uniformDenial)
}
function boundInput(input: unknown, domainId: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || 'domainId' in input)
    throw new DomainError('invalid', 'invalid_request')
  return { ...input, domainId }
}
async function authorizeDomain(
  deps: SsoDomainDeps,
  db: Db,
  p: Principal,
  headers: Headers,
  id: string,
  input: unknown,
) {
  await authorize(deps, db, p, headers)
  const before = await domain(db, p.organization.id, id)
  await lockDomain(db, before.name)
  const row = await domain(db, p.organization.id, id)
  if (row.generation !== VerifySsoDomainInput.parse(input).expectedGeneration) throw changed()
  return row
}
export async function verifySsoDomain(
  deps: SsoDomainDeps,
  principal: Principal,
  headers: Headers,
  domainId: string,
  input: unknown,
) {
  const p = enabled(deps, principal)
  return runWithFreshProof(
    deps,
    {
      headers,
      userId: p.user.id,
      sessionId: p.sessionId,
      organizationId: p.organization.id,
      operation: 'verifySsoDomain',
      input: boundInput(input, domainId),
      schema: generation.extend({ domainId: z.uuid() }),
    },
    {
      authorize: async (db) => {
        await authorizeDomain(deps, db, p, headers, domainId, input)
      },
      mutate: async (db) => {
        const row = await domain(db, p.organization.id, domainId)
        let now = await (deps.now ?? databaseClock)(db)
        const expired = () =>
          row.verified_at
            ? !row.verification_expires_at ||
              new Date(row.verification_expires_at).getTime() <= Date.parse(now)
            : new Date(row.challenge_expires_at).getTime() <= Date.parse(now)
        if (expired()) throw unverified()
        let outcome: 'positive' | 'failed' | 'unknown'
        try {
          const answers = await (deps.resolveTxt ?? resolveSsoDomainTxt)(
            `_hourmere-sso.${row.name}`,
          )
          outcome = answers.some((parts) =>
            timingSafeEqual(
              Buffer.from(digest(deps, row, parts.join('')), 'hex'),
              Buffer.from(row.challenge_digest, 'hex'),
            ),
          )
            ? 'positive'
            : 'failed'
        } catch {
          outcome = 'unknown'
        }
        // A DNS lookup may cross either deadline; no late result grants or revives authority.
        now = await (deps.now ?? databaseClock)(db)
        if (expired()) throw unverified()
        if (outcome === 'positive') {
          const competing = await db
            .selectFrom('sso_domains')
            .select('id')
            .where('name', '=', row.name)
            .where('claimed_at', 'is not', null)
            .where('retired_at', 'is', null)
            .where('id', '!=', row.id)
            .executeTakeFirst()
          if (competing) throw unverified()
        }
        const updated = await db
          .updateTable('sso_domains')
          .set({
            last_checked_at: now,
            last_check_outcome: outcome,
            next_check_at: new Date(
              Date.parse(now) + SSO_DOMAIN_LIMITS.domainRecheckInterval * 1000,
            ).toISOString(),
            ...(outcome === 'positive'
              ? {
                  claimed_at: sql`coalesce(claimed_at, ${now}::timestamptz)`,
                  verified_at: sql`coalesce(verified_at, ${now}::timestamptz)`,
                  verification_expires_at: new Date(
                    Date.parse(now) + SSO_DOMAIN_LIMITS.domainVerificationLifetime * 1000,
                  ).toISOString(),
                }
              : {}),
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow()
        if (outcome === 'positive' && !row.verified_at)
          await audit(db, p, row.id, 'sso_domain.verified')
        else
          await writeSsoAuditEvent(db, {
            ...auditActor(p),
            organizationId: p.organization.id,
            action: 'sso_domain.renewed',
            targetType: 'sso_domain',
            targetId: row.id,
            details: { outcome: outcome === 'positive' ? 'passed' : outcome },
          })
        return { domain: summary(updated, now) }
      },
    },
  ).catch(uniformDenial)
}
export async function deleteSsoDomain(
  deps: SsoDomainDeps,
  principal: Principal,
  headers: Headers,
  domainId: string,
  input: unknown,
) {
  const p = enabled(deps, principal)
  return runWithFreshProof(
    deps,
    {
      headers,
      userId: p.user.id,
      sessionId: p.sessionId,
      organizationId: p.organization.id,
      operation: 'deleteSsoDomain',
      input: boundInput(input, domainId),
      schema: generation.extend({ domainId: z.uuid() }),
    },
    {
      authorize: async (db) => {
        await authorizeDomain(deps, db, p, headers, domainId, input)
      },
      mutate: async (db) => {
        await db
          .updateTable('sso_domains')
          .set({ retired_at: sql`clock_timestamp()` })
          .where('id', '=', domainId)
          .execute()
        await audit(db, p, domainId, 'sso_domain.released')
        return { deleted: true as const }
      },
    },
  ).catch(uniformDenial)
}
