// Test support for the SSO configuration storage (migration 0074): synthetic teams,
// members and rows, and statements that run inside a savepoint of the caller's transaction.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { expect } from 'vitest'
import { migrationsDir } from './migrate.ts'

export const ssoMigration = '0074_sso_configuration.sql'
export const ssoTables = [
  'sso_policies',
  'sso_providers',
  'sso_domains',
  'sso_provider_domains',
  'sso_recovery_nominations',
  'sso_recovery_owners',
] as const
export type SsoTable = (typeof ssoTables)[number]
export const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

/** Every migration before 0074: the predecessor schema, whatever lower numbers main has. */
export async function copySsoPredecessor(directory: string) {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file < ssoMigration)
    .sort()
  expect(files.length).toBeGreaterThan(60)
  expect(files).toContain('0072_routing_forms.sql')
  for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
  return files
}

export interface SsoFixture {
  db: pg.PoolClient
  team: string
  otherTeam: string
  personal: string
  owner: string
  admin: string
  member: string
  coOwner: string
  otherOwner: string
  personalUser: string
  ownerMember: string
  adminMember: string
  memberMember: string
  coOwnerMember: string
  otherOwnerMember: string
  personalMember: string
}

/** A synthetic database error, or undefined; the statement runs in its own savepoint. */
export async function failure(
  db: pg.PoolClient,
  sql: string,
  params: unknown[] = [],
  options: { withoutTriggers?: boolean } = {},
): Promise<(Error & { code?: string; constraint?: string; column?: string }) | undefined> {
  await db.query('SAVEPOINT sso_statement')
  try {
    // Disables triggers and foreign keys for this statement only, so that a column's NOT
    // NULL constraint is what answers, not a guard that runs first.
    if (options.withoutTriggers) await db.query('SET LOCAL session_replication_role = replica')
    await db.query(sql, params)
    // Rows written without triggers never stay, and the setting ends with the savepoint.
    if (options.withoutTriggers) await db.query('ROLLBACK TO SAVEPOINT sso_statement')
    await db.query('RELEASE SAVEPOINT sso_statement')
    return undefined
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT sso_statement')
    await db.query('RELEASE SAVEPOINT sso_statement')
    return error as Error
  }
}

export async function refused(
  db: pg.PoolClient,
  sql: string,
  params: unknown[],
  expected: { code: string; constraint?: string; column?: string },
  options: { withoutTriggers?: boolean } = {},
) {
  expect(await failure(db, sql, params, options), sql).toMatchObject(expected)
}

export async function accepted(db: pg.PoolClient, sql: string, params: unknown[] = []) {
  const error = await failure(db, sql, params)
  expect(error?.message, sql).toBeUndefined()
}

function insertSql(table: string, values: Record<string, unknown>) {
  const fields = Object.keys(values)
  return {
    sql: `INSERT INTO ${quote(table)} (${fields.map(quote).join(',')})
      VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`,
    params: Object.values(values),
  }
}

export async function insert(db: pg.PoolClient, table: string, values: Record<string, unknown>) {
  const { sql, params } = insertSql(table, values)
  return (await db.query<Record<string, unknown>>(`${sql} RETURNING *`, params)).rows[0] as Record<
    string,
    unknown
  >
}

/** Inserts in a savepoint and returns the row; a refusal fails the calling assertion. */
export async function insertedRow(
  db: pg.PoolClient,
  table: string,
  values: Record<string, unknown>,
) {
  const { sql, params } = insertSql(table, values)
  await db.query('SAVEPOINT sso_statement')
  try {
    const row = (await db.query<Record<string, unknown>>(`${sql} RETURNING *`, params)).rows[0]
    await db.query('RELEASE SAVEPOINT sso_statement')
    return row as Record<string, unknown>
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT sso_statement')
    await db.query('RELEASE SAVEPOINT sso_statement')
    expect((error as Error).message, sql).toBeUndefined()
    throw error
  }
}

export function tryInsert(db: pg.PoolClient, table: string, values: Record<string, unknown>) {
  const { sql, params } = insertSql(table, values)
  return failure(db, sql, params)
}

export function insertRefused(
  db: pg.PoolClient,
  table: string,
  values: Record<string, unknown>,
  expected: { code: string; constraint?: string; column?: string },
  options: { withoutTriggers?: boolean } = {},
) {
  const { sql, params } = insertSql(table, values)
  return refused(db, sql, params, expected, options)
}

export async function insertAccepted(
  db: pg.PoolClient,
  table: string,
  values: Record<string, unknown>,
) {
  const { sql, params } = insertSql(table, values)
  await accepted(db, sql, params)
}

function updateSql(table: string, where: Record<string, unknown>, values: Record<string, unknown>) {
  const set = Object.keys(values)
  const keys = Object.keys(where)
  return {
    sql: `UPDATE ${quote(table)} SET ${set.map((field, i) => `${quote(field)}=$${i + 1}`).join(',')}
      WHERE ${keys.map((field, i) => `${quote(field)}=$${set.length + i + 1}`).join(' AND ')}`,
    params: [...Object.values(values), ...Object.values(where)],
  }
}

export function tryUpdate(
  db: pg.PoolClient,
  table: string,
  where: Record<string, unknown>,
  values: Record<string, unknown>,
) {
  const { sql, params } = updateSql(table, where, values)
  return failure(db, sql, params)
}

export async function updateRefused(
  db: pg.PoolClient,
  table: string,
  where: Record<string, unknown>,
  values: Record<string, unknown>,
  expected: { code: string; constraint?: string },
) {
  const { sql, params } = updateSql(table, where, values)
  await refused(db, sql, params, expected)
}

export async function updateAccepted(
  db: pg.PoolClient,
  table: string,
  where: Record<string, unknown>,
  values: Record<string, unknown>,
) {
  const { sql, params } = updateSql(table, where, values)
  await accepted(db, sql, params)
}

export async function count(db: pg.PoolClient, table: string, where: Record<string, unknown>) {
  const keys = Object.keys(where)
  return Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${quote(table)}
        WHERE ${keys.map((field, i) => `${quote(field)}=$${i + 1}`).join(' AND ')}`,
        Object.values(where),
      )
    ).rows[0]?.n,
  )
}

/** Version 1, a random 96-bit IV, a 128-bit tag and ciphertext, as the helpers write it. */
export const sealed = () => Buffer.concat([Buffer.from([1]), randomBytes(12 + 16 + 40)])
export const digest = () => createHash('sha256').update(randomBytes(32)).digest('hex')
export const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()
const DAY = 86_400

export const policyValues = (organization: string) => ({ organization_id: organization })

export const oidcProviderValues = (organization: string) => ({
  organization_id: organization,
  protocol: 'oidc',
  display_name: 'Synthetic Entra ID',
  issuer: `https://login.example.test/${randomUUID()}/v2.0`,
  client_id: `client-${randomUUID()}`,
  configuration: sealed(),
})

export const samlProviderValues = (organization: string) => ({
  organization_id: organization,
  protocol: 'saml',
  display_name: 'Synthetic AD FS',
  issuer: `https://adfs.example.test/${randomUUID()}/services/trust`,
  configuration: sealed(),
})

export const domainName = () => `team-${randomUUID().slice(0, 8)}.example.test`

/** A pending challenge: it reserves nothing. */
export const pendingDomainValues = (organization: string, name = domainName()) => ({
  organization_id: organization,
  name,
  challenge_digest: digest(),
  challenge_expires_at: at(DAY),
})

/** A claim verified at its first generation, unexpired, last recheck positive. */
export const claimedDomainValues = (organization: string, name = domainName()) => ({
  ...pendingDomainValues(organization, name),
  claimed_at: at(-DAY),
  verified_at: at(-DAY),
  verification_expires_at: at(6 * DAY),
  last_checked_at: at(-60),
  last_check_outcome: 'positive',
  next_check_at: at(DAY),
})

/** A claim whose verification lapsed an hour ago: suspended, still exclusive. */
export const lapsedDomainValues = (organization: string, name = domainName()) => ({
  ...claimedDomainValues(organization, name),
  claimed_at: at(-8 * DAY),
  verified_at: at(-8 * DAY),
  verification_expires_at: at(-3600),
})

export const nominationValues = (
  f: SsoFixture,
  nominee: { user: string; member: string; organization?: string } = {
    user: f.coOwner,
    member: f.coOwnerMember,
  },
) => ({
  organization_id: nominee.organization ?? f.team,
  member_id: nominee.member,
  user_id: nominee.user,
  nominated_by_user_id: f.owner,
  expires_at: at(3 * DAY),
})

export const recoveryOwnerValues = (
  f: SsoFixture,
  owner: { user: string; member: string; organization?: string } = {
    user: f.owner,
    member: f.ownerMember,
  },
) => ({
  organization_id: owner.organization ?? f.team,
  member_id: owner.member,
  user_id: owner.user,
  nominated_by_user_id: f.coOwner,
})

/** Two teams, a personal organization and members of every role, in the open transaction. */
export async function ssoFixture(db: pg.PoolClient): Promise<SsoFixture> {
  const users = (
    await db.query<{ id: string }>(
      `INSERT INTO auth."user" (name,email,"emailVerified")
      SELECT 'Synthetic SSO person ' || n, 'sso-' || n || '-' || $1 || '@example.test', true
      FROM generate_series(1,6) n ORDER BY n RETURNING id`,
      [randomUUID()],
    )
  ).rows.map(({ id }) => id)
  const [owner, admin, member, coOwner, otherOwner, personalUser] = users as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  const organizations = (
    await db.query<{ id: string }>(
      `INSERT INTO auth.organization (name,slug,"createdAt")
      SELECT name, name || '-' || $1, now() FROM unnest(ARRAY['sso-team','sso-other','sso-personal']) WITH ORDINALITY AS o (name, n)
      ORDER BY n RETURNING id`,
      [randomUUID().slice(0, 8)],
    )
  ).rows.map(({ id }) => id)
  const [team, otherTeam, personal] = organizations as [string, string, string]
  await db.query('INSERT INTO personal_organizations (user_id,organization_id) VALUES ($1,$2)', [
    personalUser,
    personal,
  ])
  const memberships = [
    [team, owner, 'owner'],
    [team, admin, 'admin'],
    [team, member, 'member'],
    // Better Auth stores several roles as one comma-separated value.
    [team, coOwner, 'admin, owner'],
    [otherTeam, otherOwner, 'owner'],
    [personal, personalUser, 'owner'],
  ]
  const members: string[] = []
  for (const [organization, user, role] of memberships)
    members.push(
      (
        await db.query<{ id: string }>(
          `INSERT INTO auth.member ("organizationId","userId",role,"createdAt")
          VALUES ($1,$2,$3,now()) RETURNING id`,
          [organization, user, role],
        )
      ).rows[0]?.id as string,
    )
  const [ownerMember, adminMember, memberMember, coOwnerMember, otherOwnerMember, personalMember] =
    members as [string, string, string, string, string, string]
  return {
    db,
    team,
    otherTeam,
    personal,
    owner,
    admin,
    member,
    coOwner,
    otherOwner,
    personalUser,
    ownerMember,
    adminMember,
    memberMember,
    coOwnerMember,
    otherOwnerMember,
    personalMember,
  }
}

/** Runs `body` in a transaction that is always rolled back. */
export async function inRolledBackTransaction<T>(
  pool: pg.Pool,
  body: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    return await body(db)
  } finally {
    await db.query('ROLLBACK').catch(() => {})
    db.release()
  }
}
