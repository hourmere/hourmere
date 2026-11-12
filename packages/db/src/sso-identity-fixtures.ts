// Test support for the SSO identity storage (migration 0075): a team whose enabled provider
// serves a verified domain claim, sessions, API keys and MCP OAuth grants, identity links, and
// values for every new table. Statements run inside the caller's transaction.
import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { expect } from 'vitest'
import { migrationsDir } from './migrate.ts'
import {
  at,
  claimedDomainValues,
  digest,
  insert,
  oidcProviderValues,
  quote,
  type SsoFixture,
  ssoFixture,
} from './sso-storage-fixtures.ts'

export const identityMigration = '0075_sso_identity.sql'
export const identityTables = [
  'sso_identity_links',
  'sso_attempts',
  'sso_mailbox_tokens',
  'sso_replay_cache',
  'sso_browser_proofs',
  'sso_delegation_bindings',
] as const
export type IdentityTable = (typeof identityTables)[number]
export type Row = Record<string, unknown>

/** Every migration before 0075, including the SSO configuration storage of 0074. */
export async function copyIdentityPredecessor(directory: string) {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file < identityMigration)
    .sort()
  expect(files).toContain('0074_sso_configuration.sql')
  for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
  return files
}

export const HOUR = 3600
export const DAY = 86_400

export interface IdentityFixture extends SsoFixture {
  /** An enabled OIDC provider of the team, serving `domain`. */
  provider: Row
  /** A verified, unexpired claim of the team at generation 1. */
  domain: Row
  /** An enabled provider of the other team, serving `otherDomain`. */
  otherProvider: Row
  otherDomain: Row
  /** One current session per person, by user ID. */
  sessions: Record<string, string>
  /** The member's live link at `provider`. */
  memberLink: Row
}

/**
 * Inserts with triggers and foreign keys off and keeps the row: state that the guards only
 * allow to arise with time (an expired attempt or token, an expired proof) is seeded directly,
 * as the design's implementation sequence does for state a later step writes.
 */
export async function seeded(db: pg.PoolClient, table: string, values: Row): Promise<Row> {
  const fields = Object.keys(values)
  // A refused row aborts the caller's transaction, and its own error propagates.
  await db.query('SET LOCAL session_replication_role = replica')
  const row = (
    await db.query<Row>(
      `INSERT INTO ${quote(table)} (${fields.map(quote).join(',')})
      VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      Object.values(values),
    )
  ).rows[0] as Row
  await db.query('SET LOCAL session_replication_role = origin')
  return row
}

export async function session(db: pg.PoolClient, user: string, expiresAt = at(7 * DAY)) {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO auth.session ("expiresAt",token,"updatedAt","userId")
      VALUES ($1,$2,now(),$3) RETURNING id`,
      [expiresAt, randomBytes(24).toString('base64url'), user],
    )
  ).rows[0]?.id as string
}

/** An API key of `user`; `organization` null leaves it a personal key. */
export async function apiKey(
  db: pg.PoolClient,
  user: string,
  organization: string | null,
  expiresAt: string | null = null,
) {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO auth.apikey ("configId","referenceId",key,"expiresAt","createdAt","updatedAt",metadata)
      VALUES ('default',$1,$2,$3,now(),now(),$4) RETURNING id`,
      [
        user,
        randomBytes(32).toString('hex'),
        expiresAt,
        JSON.stringify(
          organization ? { scope: 'full', organizationId: organization } : { scope: 'full' },
        ),
      ],
    )
  ).rows[0]?.id as string
}

export async function oauthGrant(db: pg.PoolClient, user: string, organization: string) {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO mcp_oauth_grants (user_id,organization_id,client_id) VALUES ($1,$2,$3) RETURNING id`,
      [user, organization, `synthetic-client-${randomUUID()}`],
    )
  ).rows[0]?.id as string
}

export const mailboxOf = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.test`

export const linkValues = (
  f: IdentityFixture,
  user = f.member,
  provider: Row = f.provider,
): Row => ({
  organization_id: provider.organization_id,
  provider_id: provider.id,
  issuer: provider.issuer,
  subject: `synthetic-subject-${randomUUID()}`,
  user_id: user,
  proven_email: mailboxOf('linked'),
  email_proven_at: at(-60),
})

export const link = (f: IdentityFixture, user = f.member, provider: Row = f.provider) =>
  insert(f.db, 'sso_identity_links', linkValues(f, user, provider))

const attemptBase = (f: IdentityFixture) => ({
  organization_id: f.team,
  browser_binding_digest: digest(),
  input_digest: digest(),
  expires_at: at(540),
})

/** A pre-session sign-in at the provider's current revision. */
export const signInValues = (f: IdentityFixture, provider: Row = f.provider): Row => ({
  ...attemptBase(f),
  organization_id: provider.organization_id,
  kind: 'sign_in',
  provider_id: provider.id,
  provider_revision: provider.revision,
  operation: 'sign_in',
})

/** A provider test by the owner in the owner's session. */
export const testValues = (f: IdentityFixture, provider: Row = f.provider): Row => ({
  ...attemptBase(f),
  kind: 'test',
  provider_id: provider.id,
  provider_revision: provider.revision,
  user_id: f.owner,
  session_id: f.sessions[f.owner],
  operation: 'testSsoProvider',
})

/** A self-link by the member in the member's session. */
export const linkAttemptValues = (f: IdentityFixture, provider: Row = f.provider): Row => ({
  ...attemptBase(f),
  kind: 'link',
  provider_id: provider.id,
  provider_revision: provider.revision,
  user_id: f.member,
  session_id: f.sessions[f.member],
  operation: 'linkSsoAccount',
})

/** A fresh proof for one write by the owner; mailbox by default. */
export const freshProofValues = (
  f: IdentityFixture,
  methods: { mailbox?: boolean; sso?: boolean } = { mailbox: true },
): Row => ({
  ...attemptBase(f),
  kind: 'fresh_proof',
  user_id: f.owner,
  session_id: f.sessions[f.owner],
  operation: 'createSsoProvider',
  requires_mailbox: methods.mailbox ?? false,
  requires_sso: methods.sso ?? false,
  mailbox: methods.mailbox ? mailboxOf('owner') : null,
})

export const tokenValues = (attempt: Row, expiresIn = 240): Row => ({
  token_digest: digest(),
  organization_id: attempt.organization_id,
  attempt_id: attempt.id,
  expires_at: at(expiresIn),
})

export const replayValues = (f: IdentityFixture, provider: Row = f.provider): Row => ({
  organization_id: provider.organization_id,
  provider_id: provider.id,
  kind: 'saml_assertion',
  key_digest: digest(),
  retain_until: at(600),
})

/** What a proof or binding of the member relied on, all current. */
export const relianceValues = (f: IdentityFixture, linkRow: Row = f.memberLink): Row => ({
  organization_id: f.team,
  user_id: linkRow.user_id,
  member_id: f.memberMember,
  provider_id: linkRow.provider_id,
  link_id: linkRow.id,
  link_generation: linkRow.generation,
  trust_generation: 1,
  domain_id: f.domain.id,
  domain_generation: f.domain.generation,
})

export const proofValues = (f: IdentityFixture, linkRow: Row = f.memberLink): Row => ({
  ...relianceValues(f, linkRow),
  session_id: f.sessions[linkRow.user_id as string],
  expires_at: at(8 * HOUR - 60),
})

export const bindingValues = (
  f: IdentityFixture,
  credential: { api_key_id: string } | { oauth_grant_id: string },
  linkRow: Row = f.memberLink,
): Row => ({
  ...relianceValues(f, linkRow),
  ...credential,
  expires_at: at(30 * DAY - 60),
})

function insertSql(table: string, values: Row) {
  const fields = Object.keys(values)
  return {
    sql: `INSERT INTO ${quote(table)} (${fields.map(quote).join(',')})
      VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`,
    params: Object.values(values),
  }
}

/** Asserts that a statement is accepted, then undoes it so the next one starts from the same rows. */
export async function tried(db: pg.PoolClient, sql: string, params: unknown[] = []) {
  await db.query('SAVEPOINT sso_identity_probe')
  try {
    await expect(db.query(sql, params), sql).resolves.toBeDefined()
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT sso_identity_probe')
    await db.query('RELEASE SAVEPOINT sso_identity_probe')
  }
}

export function triedInsert(db: pg.PoolClient, table: string, values: Row) {
  const { sql, params } = insertSql(table, values)
  return tried(db, sql, params)
}

export function triedUpdate(db: pg.PoolClient, table: string, where: Row, values: Row) {
  const set = Object.keys(values)
  const keys = Object.keys(where)
  return tried(
    db,
    `UPDATE ${quote(table)} SET ${set.map((field, i) => `${quote(field)}=$${i + 1}`).join(',')}
    WHERE ${keys.map((field, i) => `${quote(field)}=$${set.length + i + 1}`).join(' AND ')}`,
    [...Object.values(values), ...Object.values(where)],
  )
}

/** Attempt, token, consumption and proof: a recorded mailbox proof on an attempt. */
export async function proveMailbox(db: pg.PoolClient, attempt: Row) {
  const token = await insert(db, 'sso_mailbox_tokens', tokenValues(attempt))
  await db.query('UPDATE sso_mailbox_tokens SET consumed_at=now() WHERE token_digest=$1', [
    token.token_digest,
  ])
  await db.query(
    'UPDATE sso_attempts SET mailbox_proven_at=now(), mailbox_proof_expires_at=$2 WHERE id=$1',
    [attempt.id, token.expires_at],
  )
  return token
}

/** The SSO fixture plus providers, claims, sessions and the member's link. */
export async function identityFixture(db: pg.PoolClient): Promise<IdentityFixture> {
  const f = await ssoFixture(db)
  const sessions: Record<string, string> = {}
  for (const user of [f.owner, f.admin, f.member, f.coOwner, f.otherOwner, f.personalUser])
    sessions[user] = await session(db, user)
  const serving = async (organization: string) => {
    const provider = await insert(db, 'sso_providers', {
      ...oidcProviderValues(organization),
      enabled: true,
    })
    const domain = await insert(db, 'sso_domains', claimedDomainValues(organization))
    await insert(db, 'sso_provider_domains', {
      organization_id: organization,
      provider_id: provider.id,
      domain_id: domain.id,
    })
    return { provider, domain }
  }
  const team = await serving(f.team)
  const other = await serving(f.otherTeam)
  const fixture: IdentityFixture = {
    ...f,
    provider: team.provider,
    domain: team.domain,
    otherProvider: other.provider,
    otherDomain: other.domain,
    sessions,
    memberLink: {},
  }
  fixture.memberLink = await link(fixture)
  return fixture
}
