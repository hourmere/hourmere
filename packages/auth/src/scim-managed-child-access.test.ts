import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { scimSuspended } from '@hourmere/db/scim-suspension'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isMember } from './organizations.ts'
import { liveSsoDelegations, lockSsoDelegation } from './sso-delegation-access.ts'
import { ssoRecoveryTeamsFor } from './sso-recovery-membership.ts'
import { checkTeamManagementMembership } from './team-management.ts'
import {
  liveBrowserProofQuery,
  lockTeamSsoPolicy,
  lockTeamSsoProof,
  ssoHardOff,
  teamSsoAccess,
  withScimResources,
} from './team-sso.ts'

const databaseUrl = process.env.DATABASE_URL
const GROUP_STORAGE = 'scim_team_managed_memberships'
const off = ssoHardOff
const on = withScimResources(ssoHardOff, true)

class Denied extends Error {}
const denied = (): never => {
  throw new Denied()
}

describe.skipIf(!databaseUrl)('directory-managed child suspension in auth checks', () => {
  let owned: TestDatabase
  let db: Db
  let child: string
  let suspended: string
  let active: string

  async function user(name: string) {
    const { id } = await db
      .insertInto('auth.user')
      .values({ name, email: `${randomUUID()}@example.test`, emailVerified: true })
      .returning('id')
      .executeTakeFirstOrThrow()
    return id
  }
  async function team(members: [string, string][]) {
    const { id } = await db
      .insertInto('auth.organization')
      .values({ name: 'Managed access team', slug: randomUUID(), createdAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow()
    for (const [userId, role] of members)
      await db
        .insertInto('auth.member')
        .values({ organizationId: id, userId, role, createdAt: new Date() })
        .execute()
    return id
  }

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_child_auth' })
    db = createDb(owned.pool)
    const owner = await user('Child owner')
    suspended = await user('Suspended directory member')
    active = await user('Active directory member')
    child = await team([
      [owner, 'owner'],
      [suspended, 'member'],
      [active, 'member'],
    ])
    const parent = await team([[await user('Parent owner'), 'owner']])
    const { id: connectionId } = await db
      .insertInto('scim_connections')
      .values({ organization_id: parent })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { id: mappingId } = await db
      .insertInto('scim_team_mappings')
      .values({
        parent_organization_id: parent,
        child_organization_id: child,
        connection_id: connectionId,
        external_id: 'roster',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    // Both memberships are Group-sourced; only one source User was deactivated.
    await sql`INSERT INTO scim_team_managed_memberships
      (member_id, mapping_id, child_organization_id, user_id, suspended_at)
      SELECT id, ${mappingId}, "organizationId", "userId",
        CASE WHEN "userId" = ${suspended} THEN clock_timestamp() END
      FROM auth.member
      WHERE "organizationId" = ${child} AND "userId" IN (${suspended}, ${active})`.execute(db)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  it('refuses membership checks with provisioning enabled or disabled', async () => {
    expect(await isMember(db, suspended, child)).toBe(false)
    expect(await isMember(db, suspended, child, false)).toBe(false)
    expect(await isMember(db, suspended, child, true)).toBe(false)
    expect(await isMember(db, active, child, false)).toBe(true)
    expect(await isMember(db, active, child, true)).toBe(true)

    const read = (userId: string, capability?: boolean) =>
      checkTeamManagementMembership(db, userId, child, false, false, true, false, false, capability)
    await expect(read(suspended)).rejects.toThrow()
    await expect(read(suspended, true)).rejects.toThrow()
    expect(await read(active, true)).toMatchObject({ role: 'member' })
  })

  it('refuses SSO reads, proofs and delegations with provisioning enabled or disabled', async () => {
    const identity = (userId: string) => ({ sessionId: randomUUID(), userId })
    expect(await teamSsoAccess({ db, capabilities: off }, identity(suspended), child)).toEqual({
      allowed: false,
      policy: null,
      suspended: true,
    })
    expect(await teamSsoAccess({ db, capabilities: on }, identity(suspended), child)).toEqual({
      allowed: false,
      policy: null,
      suspended: true,
    })
    expect(await teamSsoAccess({ db, capabilities: on }, identity(active), child)).toEqual({
      allowed: true,
      policy: null,
    })

    expect((await lockTeamSsoPolicy(db, child, suspended)).suspended).toBe(true)
    expect((await lockTeamSsoPolicy(db, child, suspended, false, undefined, true)).suspended).toBe(
      true,
    )

    const proof = (capabilities: typeof off, userId: string) =>
      db
        .transaction()
        .execute((trx) => lockTeamSsoProof({ capabilities }, trx, identity(userId), child, denied))
    await expect(proof(off, suspended)).rejects.toBeInstanceOf(Denied)
    await expect(proof(on, suspended)).rejects.toBeInstanceOf(Denied)
    expect(await proof(on, active)).toBeUndefined()

    const delegation = (capabilities: typeof off, userId: string) =>
      db
        .transaction()
        .execute((trx) =>
          lockSsoDelegation(
            trx,
            capabilities,
            { organizationId: child, userId, kind: 'api_key', credentialId: randomUUID() },
            denied,
          ),
        )
    await expect(delegation(off, suspended)).rejects.toBeInstanceOf(Denied)
    await expect(delegation(on, suspended)).rejects.toBeInstanceOf(Denied)
    expect(await delegation(on, active)).toBeUndefined()
  })

  it('reads Group storage in the embedded statements with provisioning enabled or disabled', () => {
    const identity = { sessionId: randomUUID(), userId: suspended }
    const compiled = (fragment: ReturnType<typeof sql>) =>
      db.selectNoFrom(sql`${fragment}`.as('fragment')).compile().sql
    for (const [without, withCapability] of [
      [
        compiled(liveBrowserProofQuery(identity, child, 1, off)),
        compiled(liveBrowserProofQuery(identity, child, 1, on)),
      ],
      [
        compiled(liveSsoDelegations('api_key', off).live),
        compiled(liveSsoDelegations('api_key', on).live),
      ],
      [
        compiled(liveSsoDelegations('oauth_grant', off).live),
        compiled(liveSsoDelegations('oauth_grant', on).live),
      ],
      [
        db.selectNoFrom(ssoRecoveryTeamsFor(db, suspended, identity.sessionId).as('t')).compile()
          .sql,
        db
          .selectNoFrom(ssoRecoveryTeamsFor(db, suspended, identity.sessionId, true).as('t'))
          .compile().sql,
      ],
    ] as const) {
      expect(without).toBe(withCapability)
      expect(withCapability).toContain(GROUP_STORAGE)
      expect(withCapability).toContain('managed_source.suspended_at IS NOT NULL')
    }
  })

  it('detects a source copy that drops an existing child suspension on rollback', async () => {
    const modulePath = new URL(import.meta.resolve('@hourmere/db/scim-suspension'))
    const readChildSuspension = `  return sql<boolean>\`(\${suspended} OR EXISTS (`
    const source = readFileSync(modulePath, 'utf8')
    expect(source).toContain(readChildSuspension)
    const require = createRequire(modulePath)
    const copy = stripTypeScriptTypes(
      source.replace(
        readChildSuspension,
        `  if (!_managedChildren) return suspended\n${readChildSuspension}`,
      ),
    ).replace(
      /from '([^']+)'/g,
      (_, specifier: string) =>
        `from '${specifier.startsWith('.') ? new URL(specifier, modulePath).href : pathToFileURL(require.resolve(specifier)).href}'`,
    )
    const mutated: typeof import('@hourmere/db/scim-suspension') = await import(
      `data:text/javascript;base64,${Buffer.from(copy).toString('base64')}`
    )
    const assertSuspended = async (predicate: typeof scimSuspended) => {
      const row = await db
        .selectNoFrom(predicate(child, suspended, false).as('suspended'))
        .executeTakeFirstOrThrow()
      expect(row.suspended).toBe(true)
    }
    await assertSuspended(scimSuspended)
    await expect(assertSuspended(mutated.scimSuspended)).rejects.toMatchObject({
      actual: false,
      expected: true,
    })
  })
})
