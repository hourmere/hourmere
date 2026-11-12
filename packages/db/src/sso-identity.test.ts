import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationsDir } from './migrate.ts'
import {
  apiKey,
  bindingValues,
  DAY,
  identityFixture,
  identityMigration,
  identityTables,
  link,
  proofValues,
  type Row,
} from './sso-identity-fixtures.ts'
import { identityProtections } from './sso-identity-protections.ts'
import { checkLinkIdentityRace, checkReplayRace } from './sso-identity-races.ts'
import {
  accepted,
  at,
  count,
  digest,
  inRolledBackTransaction,
  insert,
  refused,
  updateRefused,
} from './sso-storage-fixtures.ts'
import { violation } from './sso-storage-protections.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

/** Constraints, standalone indexes and triggers the migration creates, by name. */
async function catalogObjects(pool: pg.Pool) {
  const tables = [...identityTables]
  const relations = `SELECT oid FROM pg_class WHERE relname = ANY($1) AND relnamespace='public'::regnamespace`
  const names = async (sql: string) =>
    (await pool.query<{ name: string }>(sql, [tables])).rows.map(({ name }) => name).sort()
  return {
    constraints: await names(
      `SELECT conname AS name FROM pg_constraint WHERE conrelid = ANY(${relations})`,
    ),
    indexes: await names(
      `SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = ANY(${relations})
        AND NOT EXISTS (SELECT FROM pg_constraint k WHERE k.conindid = i.indexrelid)`,
    ),
    triggers: await names(
      `SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = ANY(${relations})`,
    ),
  }
}

/**
 * What a later proof check would ask of a stored proof or binding: the claim, link and trust
 * generations it recorded are still the current ones, the claim is verified and unexpired, and
 * the row itself has not expired. Membership and the provider's state are left out here.
 */
async function live(
  db: pg.PoolClient,
  table: 'sso_browser_proofs' | 'sso_delegation_bindings',
  id: unknown,
) {
  const { rows } = await db.query<{ live: boolean }>(
    `SELECT r.expires_at > clock_timestamp()
        AND d.retired_at IS NULL AND d.generation = r.domain_generation
        AND d.verification_expires_at > clock_timestamp()
        AND l.retired_at IS NULL AND l.generation = r.link_generation
        AND r.trust_generation = coalesce(
          (SELECT trust_generation FROM sso_policies WHERE organization_id = r.organization_id), 1)
        AS live
    FROM ${table} r
    JOIN sso_domains d ON d.id = r.domain_id
    JOIN sso_identity_links l ON l.id = r.link_id
    WHERE r.id = $1`,
    [id],
  )
  return rows[0]?.live ?? false
}

describe.skipIf(!serverUrl)('SSO identity storage', () => {
  let owned: TestDatabase

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'sso_identity' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('names every constraint, index, trigger and trigger rule in a protection', async () => {
    const { constraints, indexes, triggers } = await catalogObjects(owned.pool)
    const source = await readFile(join(migrationsDir, identityMigration), 'utf8')
    // Every rule a guard raises names itself as the error's constraint.
    const rules = [...source.matchAll(/CONSTRAINT = '([a-z_]+)'/g)].map(([, rule]) => rule)
    const objects = [...new Set([...constraints, ...indexes, ...triggers, ...rules])].sort()
    expect(constraints.length).toBeGreaterThan(100)
    expect(indexes).toEqual([
      'sso_attempts_session_id',
      'sso_attempts_step_up_link_id',
      'sso_browser_proofs_domain_id',
      'sso_browser_proofs_link_id',
      'sso_browser_proofs_member_id',
      'sso_browser_proofs_session_id',
      'sso_delegation_bindings_domain_id',
      'sso_delegation_bindings_link_id',
      'sso_delegation_bindings_member_id',
      'sso_identity_links_live_identity',
      'sso_identity_links_live_user',
      'sso_identity_links_user_id',
    ])
    expect(triggers).toHaveLength(8)
    expect(new Set(rules).size).toBe(rules.length)
    expect(rules).toHaveLength(41)
    // Two FK target keys restate their primary keys; constraint coverage allow-lists them.
    const targets = ['sso_attempts_organization_id_id', 'sso_identity_links_owner']
    const covered = [
      ...new Set([
        ...Object.values(identityProtections).flatMap(({ objects }) => objects),
        ...targets,
      ]),
    ]
    expect(covered.sort()).toEqual(objects)
    for (const [name, { mutants }] of Object.entries(identityProtections))
      expect(mutants.length, name).toBeGreaterThan(0)
  })

  it.each(Object.keys(identityProtections))('enforces %s', async (name) => {
    const protection = identityProtections[name]
    if (!protection) throw new Error(`Missing protection ${name}`)
    await inRolledBackTransaction(owned.pool, async (db) =>
      protection.check(await identityFixture(db)),
    )
    expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
  })

  it('records what proofs and bindings relied on, and a lapsed claim never revives them', async () => {
    await inRolledBackTransaction(owned.pool, async (db) => {
      const f = await identityFixture(db)
      await insert(db, 'sso_policies', { organization_id: f.team, trust_generation: 2 })
      const proof = await insert(db, 'sso_browser_proofs', {
        ...proofValues(f),
        trust_generation: 2,
      })
      const binding = await insert(db, 'sso_delegation_bindings', {
        ...bindingValues(f, { api_key_id: await apiKey(db, f.member, f.team) }),
        trust_generation: 2,
      })
      for (const row of [proof, binding])
        expect(row).toMatchObject({
          trust_generation: 2,
          link_id: f.memberLink.id,
          link_generation: 1,
          domain_id: f.domain.id,
          domain_generation: 1,
        })
      expect(await live(db, 'sso_browser_proofs', proof.id)).toBe(true)
      expect(await live(db, 'sso_delegation_bindings', binding.id)).toBe(true)

      // A renewal before the lapse keeps the lease.
      await db.query('UPDATE sso_domains SET verification_expires_at=$2 WHERE id=$1', [
        f.domain.id,
        at(7 * DAY),
      ])
      expect(await live(db, 'sso_delegation_bindings', binding.id)).toBe(true)

      // The claim lapses: the proof and the lease end.
      await db.query('UPDATE sso_domains SET verification_expires_at=$2 WHERE id=$1', [
        f.domain.id,
        at(-1),
      ])
      expect(await live(db, 'sso_browser_proofs', proof.id)).toBe(false)
      expect(await live(db, 'sso_delegation_bindings', binding.id)).toBe(false)
      // Verifying the lapsed generation again is refused, so nothing can revive them...
      await updateRefused(
        db,
        'sso_domains',
        { id: f.domain.id },
        { verification_expires_at: at(7 * DAY) },
        violation('sso_domains_generation_lapse'),
      )
      // ...and a new generation leaves them on the old one, which they cannot be moved off.
      await db.query(
        `UPDATE sso_domains SET generation=2, challenge_digest=$2, challenge_expires_at=$3,
          verified_at=NULL, verification_expires_at=NULL WHERE id=$1`,
        [f.domain.id, digest(), at(DAY)],
      )
      await db.query(
        'UPDATE sso_domains SET verified_at=now(), verification_expires_at=$2 WHERE id=$1',
        [f.domain.id, at(7 * DAY)],
      )
      expect(await live(db, 'sso_browser_proofs', proof.id)).toBe(false)
      expect(await live(db, 'sso_delegation_bindings', binding.id)).toBe(false)
      await updateRefused(
        db,
        'sso_delegation_bindings',
        { id: binding.id },
        { domain_generation: 2 },
        violation('sso_reliance_immutable'),
      )
      // Rebinding replaces the binding, at the claim's new generation only.
      await accepted(db, 'DELETE FROM sso_delegation_bindings WHERE id=$1', [binding.id])
      const rebind = {
        ...bindingValues(f, { api_key_id: binding.api_key_id as string }),
        trust_generation: 2,
      }
      await refused(
        db,
        `INSERT INTO sso_delegation_bindings (${Object.keys(rebind).join(',')})
        VALUES (${Object.keys(rebind)
          .map((_, i) => `$${i + 1}`)
          .join(',')})`,
        Object.values(rebind),
        violation('sso_reliance_domain'),
      )
      const rebound = await insert(db, 'sso_delegation_bindings', {
        ...rebind,
        domain_generation: 2,
      })
      expect(await live(db, 'sso_delegation_bindings', rebound.id)).toBe(true)

      // Retiring the member's link ends the member's lease, and nobody else's.
      const adminLink = await link(f, f.admin)
      const admin = await insert(db, 'sso_delegation_bindings', {
        ...bindingValues(f, { api_key_id: await apiKey(db, f.admin, f.team) }, adminLink),
        member_id: f.adminMember,
        trust_generation: 2,
        domain_generation: 2,
      })
      await db.query(
        'UPDATE sso_identity_links SET retired_at=now(), generation=generation+1 WHERE id=$1',
        [f.memberLink.id],
      )
      expect(await live(db, 'sso_delegation_bindings', rebound.id)).toBe(false)
      expect(await live(db, 'sso_delegation_bindings', admin.id)).toBe(true)
      // A trust change ends every proof and lease of the team.
      await db.query(
        'UPDATE sso_policies SET trust_generation=3, policy_revision=2 WHERE organization_id=$1',
        [f.team],
      )
      expect(await live(db, 'sso_delegation_bindings', admin.id)).toBe(false)
    })
    expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
  })

  it('keeps admission tombstones in the shared table through member and account deletion', async () => {
    await inRolledBackTransaction(owned.pool, async (db) => {
      const f = await identityFixture(db)
      const email = (
        await db.query<{ email: string }>('SELECT email FROM auth."user" WHERE id=$1', [f.member])
      ).rows[0]?.email as string
      const tombstones: Row[] = [
        await insert(db, 'scim_membership_blocks', {
          organization_id: f.team,
          user_id: f.member,
          source: 'local',
          kind: 'removal',
        }),
        await insert(db, 'scim_membership_blocks', {
          organization_id: f.team,
          user_id: f.member,
          identity_email: email.toLowerCase(),
          source: 'local',
          kind: 'suspension',
        }),
      ]
      const blocks = () =>
        db.query<Row>(
          'SELECT id, user_id, identity_email, kind FROM scim_membership_blocks WHERE organization_id=$1 ORDER BY kind',
          [f.team],
        )
      await insert(db, 'sso_browser_proofs', proofValues(f))
      await insert(
        db,
        'sso_delegation_bindings',
        bindingValues(f, { api_key_id: await apiKey(db, f.member, f.team) }),
      )

      // The member leaves: their proofs and bindings end; both tombstones stay.
      await accepted(db, 'DELETE FROM auth.member WHERE id=$1', [f.memberMember])
      expect(await count(db, 'sso_browser_proofs', { user_id: f.member })).toBe(0)
      expect(await count(db, 'sso_delegation_bindings', { user_id: f.member })).toBe(0)
      // Ordered by kind: the removal, then the suspension.
      expect((await blocks()).rows.map(({ id }) => id)).toEqual(tombstones.map(({ id }) => id))
      await refused(db, 'DELETE FROM scim_membership_blocks WHERE id=$1', [tombstones[1]?.id], {
        code: '23514',
      })

      // The account is deleted: its links go, and the tombstones keep the team-local mailbox.
      await accepted(db, 'DELETE FROM auth."user" WHERE id=$1', [f.member])
      expect(await count(db, 'sso_identity_links', { user_id: f.member })).toBe(0)
      expect((await blocks()).rows).toEqual([
        {
          id: tombstones[0]?.id,
          user_id: null,
          identity_email: email.toLowerCase(),
          kind: 'removal',
        },
        {
          id: tombstones[1]?.id,
          user_id: null,
          identity_email: email.toLowerCase(),
          kind: 'suspension',
        },
      ])
      // Only the team's deletion removes them.
      await accepted(db, 'DELETE FROM auth.organization WHERE id=$1', [f.team])
      expect((await blocks()).rows).toEqual([])
    })
    expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
  })

  it('keeps (organization, provider, issuer, subject) unique under concurrent writers', async () => {
    await checkLinkIdentityRace(owned.pool)
    expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
  }, 30_000)

  it('consumes a replay key once under concurrent writers', async () => {
    await checkReplayRace(owned.pool)
    expect(owned.pool.totalCount).toBeLessThanOrEqual(3)
  }, 30_000)
})
