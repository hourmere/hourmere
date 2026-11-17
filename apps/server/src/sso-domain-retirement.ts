import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { writeSsoAuditEvent } from '@hourmere/db/audit'
import type { Mailer } from '@hourmere/mail'
import { resolveSsoDomainTxt, SSO_TRANSPORT_LIMITS } from '@hourmere/outbound/sso'
import { sql } from 'kysely'
import { z } from 'zod'
import { databaseClock } from './sso-mailbox-proof.ts'

export interface DomainRetirementDeps {
  db: Db
  publicUrl: string
  resolveTxt?: (name: string) => Promise<string[][]>
  now?: (db: Db) => Promise<string>
}
const invalid = () => new Error('Domain retirement refused')
const uuid = z.uuid()
const milliseconds = (value: string | Date) => new Date(value).getTime()
const digest = (origin: string, id: string, team: string, value: string) =>
  createHash('sha256')
    .update(JSON.stringify([new URL(origin).origin, id, team, value]))
    .digest('hex')
async function lock(db: Db, name: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sso-domain:${name}`}, 0))`.execute(db)
}
async function lockedClaim(db: Db, id: string) {
  const before = await db
    .selectFrom('sso_domains')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst()
  if (!before) throw invalid()
  // Match interactive administration's organization-before-domain lock order.
  await sql`SELECT id FROM auth.organization WHERE id=${before.organization_id} FOR UPDATE`.execute(
    db,
  )
  await lock(db, before.name)
  return db.selectFrom('sso_domains').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}
function expired(
  row: {
    retired_at: unknown
    generation: number
    claimed_at: unknown
    verification_expires_at: string | Date | null
  },
  generation: number,
  now: string,
) {
  return (
    !row.retired_at &&
    row.generation === generation &&
    row.claimed_at &&
    row.verification_expires_at &&
    milliseconds(row.verification_expires_at) <= Date.parse(now)
  )
}

/** Offline operator ceremony. This removes trust and intentionally has no SSO capability gate. */
export async function createDomainRetirementChallenge(
  deps: DomainRetirementDeps,
  domainId: string,
  generation: number,
  requestingTeamId: string,
) {
  if (
    !uuid.safeParse(domainId).success ||
    !uuid.safeParse(requestingTeamId).success ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  )
    throw invalid()
  return deps.db.transaction().execute(async (db) => {
    const row = await lockedClaim(db, domainId)
    const now = await (deps.now ?? databaseClock)(db)
    if (!expired(row, generation, now) || row.organization_id === requestingTeamId) throw invalid()
    const team = await db
      .selectFrom('auth.organization as o')
      .leftJoin('personal_organizations as p', 'p.organization_id', 'o.id')
      .select('o.id')
      .where('o.id', '=', requestingTeamId)
      .where('p.organization_id', 'is', null)
      .executeTakeFirst()
    if (!team) throw invalid()
    const id = (await sql<{ id: string }>`SELECT uuidv7() AS id`.execute(db)).rows[0]?.id as string
    const txtValue = `hourmere-sso-retire=${randomBytes(32).toString('base64url')}`
    const expiresAt = new Date(Date.parse(now) + 86400_000).toISOString()
    await db
      .insertInto('sso_domain_retirements')
      .values({
        id,
        domain_id: domainId,
        generation,
        old_organization_id: row.organization_id,
        requesting_organization_id: requestingTeamId,
        challenge_digest: digest(deps.publicUrl, id, requestingTeamId, txtValue),
        created_at: now,
        expires_at: expiresAt,
      })
      .execute()
    return { id, txtName: `_hourmere-sso.${row.name}`, txtValue, expiresAt }
  })
}

export async function retireSsoDomain(deps: DomainRetirementDeps, challengeId: string) {
  if (!uuid.safeParse(challengeId).success) throw invalid()
  return deps.db.transaction().execute(async (db) => {
    const before = await db
      .selectFrom('sso_domain_retirements')
      .selectAll()
      .where('id', '=', challengeId)
      .executeTakeFirst()
    if (!before) throw invalid()
    const row = await lockedClaim(db, before.domain_id)
    const challenge = await db
      .selectFrom('sso_domain_retirements')
      .selectAll()
      .where('id', '=', challengeId)
      .forUpdate()
      .executeTakeFirstOrThrow()
    if (challenge.retired_at) return { retired: true as const }
    let now = await (deps.now ?? databaseClock)(db)
    const eligible = () =>
      expired(row, challenge.generation, now) &&
      milliseconds(challenge.expires_at) > Date.parse(now)
    if (!eligible()) throw invalid()
    let matched = false
    try {
      const answers = await boundedLookup(deps, `_hourmere-sso.${row.name}`)
      matched = answers.some((parts) =>
        timingSafeEqual(
          Buffer.from(
            digest(
              deps.publicUrl,
              challenge.id,
              challenge.requesting_organization_id,
              parts.join(''),
            ),
            'hex',
          ),
          Buffer.from(challenge.challenge_digest, 'hex'),
        ),
      )
    } catch {
      throw invalid()
    }
    now = await (deps.now ?? databaseClock)(db)
    if (!matched || !eligible()) throw invalid()
    await db.updateTable('sso_domains').set({ retired_at: now }).where('id', '=', row.id).execute()
    await db
      .updateTable('sso_domain_retirements')
      .set({
        proved_at: now,
        retired_at: now,
        old_verified_at: row.verified_at,
        old_expires_at: row.verification_expires_at,
      })
      .where('id', '=', challenge.id)
      .execute()
    await writeSsoAuditEvent(db, {
      organizationId: row.organization_id,
      actor: { type: 'system', id: 'sso-domain-retirement' },
      credential: { type: 'none' },
      action: 'sso_maintenance.domain_retired',
      targetType: 'sso_domain',
      targetId: row.id,
      details: {},
    })
    const owners = await db
      .selectFrom('auth.member')
      .select('userId')
      .where('organizationId', '=', row.organization_id)
      .where(sql<boolean>`'owner' = ANY(regexp_split_to_array(role, '[[:space:]]*,[[:space:]]*'))`)
      .execute()
    if (owners.length)
      await db
        .insertInto('sso_domain_retirement_notifications')
        .values(owners.map((owner) => ({ retirement_id: challenge.id, user_id: owner.userId })))
        .execute()
    return { retired: true as const }
  })
}

/** Durable per-owner delivery; retrying may duplicate a delivery after an SMTP/commit crash. */
export async function notifyDomainRetirement(
  deps: DomainRetirementDeps & { mailer: Mailer },
  challengeId: string,
) {
  if (!uuid.safeParse(challengeId).success) throw invalid()
  const record = await deps.db
    .selectFrom('sso_domain_retirements')
    .select('retired_at')
    .where('id', '=', challengeId)
    .executeTakeFirst()
  if (!record?.retired_at) throw invalid()
  const pending = await deps.db
    .selectFrom('sso_domain_retirement_notifications')
    .select('user_id')
    .where('retirement_id', '=', challengeId)
    .where('delivered_at', 'is', null)
    .limit(100)
    .execute()
  for (const item of pending)
    await deps.db.transaction().execute(async (db) => {
      const notice = await db
        .selectFrom('sso_domain_retirement_notifications')
        .selectAll()
        .where('retirement_id', '=', challengeId)
        .where('user_id', '=', item.user_id)
        .where('delivered_at', 'is', null)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst()
      if (!notice) return
      const retirement = await db
        .selectFrom('sso_domain_retirements')
        .selectAll()
        .where('id', '=', challengeId)
        .executeTakeFirstOrThrow()
      const owner = await db
        .selectFrom('auth.member')
        .innerJoin('auth.user', 'auth.user.id', 'auth.member.userId')
        .select(['auth.user.email', 'auth.user.emailVerified'])
        .where('auth.member.userId', '=', item.user_id)
        .where('auth.member.organizationId', '=', retirement.old_organization_id)
        .where(
          sql<boolean>`'owner' = ANY(regexp_split_to_array(auth.member.role, '[[:space:]]*,[[:space:]]*'))`,
        )
        .executeTakeFirst()
      if (owner?.emailVerified)
        await deps.mailer.send(
          {
            to: owner.email,
            sensitive: true,
            subject: 'SSO domain retired / SSO 域名已退役',
            text: 'An operator retired an expired SSO domain claim belonging to your team after verifying a new DNS proof. No identities, memberships or trust were transferred. Contact your instance operator for assistance.\n\n实例运维人员验证了新的 DNS 证明后，已将您团队的过期 SSO 域名声明退役。未转移任何身份、成员资格或信任。如需帮助，请联系实例运维人员。',
          },
          { signal: AbortSignal.timeout(10_000) },
        )
      await db
        .updateTable('sso_domain_retirement_notifications')
        .set({ delivered_at: await (deps.now ?? databaseClock)(db) })
        .where('retirement_id', '=', challengeId)
        .where('user_id', '=', item.user_id)
        .execute()
    })
  const remaining = await deps.db
    .selectFrom('sso_domain_retirement_notifications')
    .select('user_id')
    .where('retirement_id', '=', challengeId)
    .where('delivered_at', 'is', null)
    .limit(1)
    .executeTakeFirst()
  return { pending: remaining !== undefined }
}

async function boundedLookup(deps: DomainRetirementDeps, name: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (deps.resolveTxt ?? resolveSsoDomainTxt)(name),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(invalid()), SSO_TRANSPORT_LIMITS.ssoConnectTimeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
