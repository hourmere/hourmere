import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  insert,
  lapsedDomainValues,
  oidcProviderValues,
  type SsoFixture,
  ssoFixture,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import {
  createDomainRetirementChallenge,
  notifyDomainRetirement,
  retireSsoDomain,
} from './sso-domain-retirement.ts'

let owned: TestDatabase
let db: Db
let f: SsoFixture
const publicUrl = 'https://hourmere.example.com'
const resolveTxt = vi.fn<(name: string) => Promise<string[][]>>()
const deps = () => ({ db, publicUrl, resolveTxt })
async function domain() {
  const client = await owned.pool.connect()
  try {
    return (
      await insert(client, 'sso_domains', lapsedDomainValues(f.team, `${randomUUID()}.example.com`))
    ).id as string
  } finally {
    client.release()
  }
}
async function challenge() {
  const id = await domain()
  return { domainId: id, ...(await createDomainRetirementChallenge(deps(), id, 1, f.otherTeam)) }
}

describe.skipIf(!process.env.DATABASE_URL)('offline SSO domain retirement', () => {
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    const client = await owned.pool.connect()
    try {
      f = await ssoFixture(client)
    } finally {
      client.release()
    }
  })
  afterAll(async () => {
    await owned?.drop()
  })
  it('retires only the expired generation, records proof provenance, audits, and notifies old owners without transferring trust', async () => {
    const c = await challenge()
    const client = await owned.pool.connect()
    try {
      const provider = await insert(client, 'sso_providers', {
        ...oidcProviderValues(f.team),
        enabled: true,
      })
      await insert(client, 'sso_identity_links', {
        organization_id: f.team,
        provider_id: provider.id,
        issuer: provider.issuer,
        subject: 'synthetic-retirement-subject',
        user_id: f.member,
        proven_email: 'member@example.test',
        email_proven_at: new Date().toISOString(),
      })
      await client.query(
        'INSERT INTO sso_policies (organization_id, require_sso) VALUES ($1,true)',
        [f.team],
      )
      await client.query(
        'INSERT INTO sso_provider_domains (organization_id,provider_id,domain_id) VALUES ($1,$2,$3)',
        [f.team, provider.id, c.domainId],
      )
    } finally {
      client.release()
    }
    const providers = await db.selectFrom('sso_providers').selectAll().execute()
    const identities = await db.selectFrom('sso_identity_links').selectAll().execute()
    const policies = await db.selectFrom('sso_policies').selectAll().execute()
    const before = await db
      .selectFrom('sso_domain_retirements')
      .selectAll()
      .where('id', '=', c.id)
      .executeTakeFirstOrThrow()
    expect(JSON.stringify(before)).not.toContain(c.txtValue)
    resolveTxt.mockResolvedValue([[c.txtValue.slice(0, 12), c.txtValue.slice(12)]])
    const membersBefore = await db.selectFrom('auth.member').selectAll().orderBy('id').execute()
    await expect(retireSsoDomain(deps(), c.id)).resolves.toEqual({ retired: true })
    const claim = await db
      .selectFrom('sso_domains')
      .selectAll()
      .where('id', '=', c.domainId)
      .executeTakeFirstOrThrow()
    expect(claim.retired_at).not.toBeNull()
    expect(claim.organization_id).toBe(f.team)
    expect(await db.selectFrom('sso_providers').selectAll().execute()).toEqual(providers)
    expect(await db.selectFrom('sso_identity_links').selectAll().execute()).toEqual(identities)
    expect(await db.selectFrom('sso_policies').selectAll().execute()).toEqual(policies)
    expect(await db.selectFrom('auth.member').selectAll().orderBy('id').execute()).toEqual(
      membersBefore,
    )
    const receipt = await db
      .selectFrom('sso_domain_retirements')
      .selectAll()
      .where('id', '=', c.id)
      .executeTakeFirstOrThrow()
    expect(receipt).toMatchObject({
      old_organization_id: f.team,
      requesting_organization_id: f.otherTeam,
      generation: 1,
    })
    expect(receipt.proved_at).not.toBeNull()
    expect(receipt.old_verified_at).not.toBeNull()
    expect(receipt.old_expires_at).not.toBeNull()
    const audit = await db
      .selectFrom('audit_events')
      .selectAll()
      .where('target_id', '=', c.domainId)
      .execute()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      action: 'sso_maintenance.domain_retired',
      actor_type: 'system',
      details: {},
    })
    const send = vi.fn().mockResolvedValue(undefined)
    expect(await notifyDomainRetirement({ ...deps(), mailer: { send } }, c.id)).toEqual({
      pending: false,
    })
    expect(send).toHaveBeenCalledTimes(2)
    const owners = await db
      .selectFrom('auth.user')
      .select('email')
      .where('id', 'in', [f.owner, f.coOwner])
      .execute()
    expect(send.mock.calls.map(([message]) => message.to).sort()).toEqual(
      owners.map((u) => u.email).sort(),
    )
    expect(send.mock.calls[0]?.[0]).toMatchObject({ sensitive: true })
    await retireSsoDomain(deps(), c.id)
    expect(await notifyDomainRetirement({ ...deps(), mailer: { send } }, c.id)).toEqual({
      pending: false,
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(
      await db
        .selectFrom('audit_events')
        .select('id')
        .where('target_id', '=', c.domainId)
        .execute(),
    ).toHaveLength(1)
  })
  it('refuses current authority, same or personal team, wrong generation, missing TXT and unknown DNS', async () => {
    const id = await domain()
    await expect(createDomainRetirementChallenge(deps(), id, 1, f.team)).rejects.toThrow('refused')
    await expect(createDomainRetirementChallenge(deps(), id, 1, f.personal)).rejects.toThrow(
      'refused',
    )
    await expect(createDomainRetirementChallenge(deps(), id, 2, f.otherTeam)).rejects.toThrow(
      'refused',
    )
    const c = await createDomainRetirementChallenge(deps(), id, 1, f.otherTeam)
    resolveTxt.mockResolvedValue([])
    await expect(retireSsoDomain(deps(), c.id)).rejects.toThrow('refused')
    resolveTxt.mockRejectedValue(new Error('private resolver detail'))
    await expect(retireSsoDomain(deps(), c.id)).rejects.toThrow('Domain retirement refused')
    const clockBeforeExpiry = async () => new Date(Date.now() - 30 * 86400_000).toISOString()
    await expect(
      createDomainRetirementChallenge({ ...deps(), now: clockBeforeExpiry }, id, 1, f.otherTeam),
    ).rejects.toThrow('refused')
    expect(
      (
        await db
          .selectFrom('sso_domains')
          .select('retired_at')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).retired_at,
    ).toBeNull()
  })
  it('refuses a replaced generation and the exact challenge deadline without DNS', async () => {
    const c = await challenge()
    resolveTxt.mockResolvedValue([[c.txtValue]])
    await expect(
      retireSsoDomain({ ...deps(), now: async () => c.expiresAt }, c.id),
    ).rejects.toThrow('refused')
    await db
      .updateTable('sso_domains')
      .set({
        generation: 2,
        challenge_digest: 'a'.repeat(64),
        challenge_expires_at: new Date(Date.now() + 86400_000).toISOString(),
        verified_at: null,
        verification_expires_at: null,
        last_checked_at: null,
        last_check_outcome: null,
        next_check_at: null,
      })
      .where('id', '=', c.domainId)
      .execute()
    await expect(retireSsoDomain(deps(), c.id)).rejects.toThrow('refused')
  })
  it('serializes retirement and replay while DNS is pending', async () => {
    const c = await challenge()
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const resolver = vi.fn(async () => {
      started()
      await barrier
      return [[c.txtValue]]
    })
    const first = retireSsoDomain({ ...deps(), resolveTxt: resolver }, c.id)
    await entered
    const second = retireSsoDomain({ ...deps(), resolveTxt: resolver }, c.id)
    release()
    await Promise.all([first, second])
    expect(resolver).toHaveBeenCalledTimes(1)
  })
  it('observes a concurrent foreground generation replacement after the domain lock', async () => {
    const c = await challenge()
    const stored = await db
      .selectFrom('sso_domains')
      .selectAll()
      .where('id', '=', c.domainId)
      .executeTakeFirstOrThrow()
    let entered!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const foreground = db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM auth.organization WHERE id=${f.team} FOR UPDATE`.execute(trx)
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sso-domain:${stored.name}`}, 0))`.execute(
        trx,
      )
      entered()
      await barrier
      await trx
        .updateTable('sso_domains')
        .set({
          generation: 2,
          challenge_digest: 'b'.repeat(64),
          challenge_expires_at: new Date(Date.now() + 86400_000).toISOString(),
          verified_at: null,
          verification_expires_at: null,
          last_checked_at: null,
          last_check_outcome: null,
          next_check_at: null,
        })
        .where('id', '=', c.domainId)
        .execute()
    })
    await ready
    const retirement = retireSsoDomain({ ...deps(), resolveTxt: async () => [[c.txtValue]] }, c.id)
    release()
    await foreground
    await expect(retirement).rejects.toThrow('refused')
    expect(
      (
        await db
          .selectFrom('sso_domains')
          .select('retired_at')
          .where('id', '=', c.domainId)
          .executeTakeFirstOrThrow()
      ).retired_at,
    ).toBeNull()
  })
  it('keeps failed notification pending for retry and skips former owners', async () => {
    await db
      .updateTable('auth.member')
      .set({ role: 'owner,admin' })
      .where('id', '=', f.ownerMember)
      .execute()
    const c = await challenge()
    resolveTxt.mockResolvedValue([[c.txtValue]])
    await retireSsoDomain(deps(), c.id)
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('mail failed'))
      .mockResolvedValue(undefined)
    await expect(notifyDomainRetirement({ ...deps(), mailer: { send } }, c.id)).rejects.toThrow(
      'mail failed',
    )
    expect(
      await db
        .selectFrom('sso_domain_retirement_notifications')
        .selectAll()
        .where('retirement_id', '=', c.id)
        .where('delivered_at', 'is', null)
        .execute(),
    ).toHaveLength(2)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('id', '=', f.coOwnerMember)
      .execute()
    expect(await notifyDomainRetirement({ ...deps(), mailer: { send } }, c.id)).toEqual({
      pending: false,
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(
      await db
        .selectFrom('sso_domain_retirement_notifications')
        .selectAll()
        .where('retirement_id', '=', c.id)
        .where('delivered_at', 'is', null)
        .execute(),
    ).toHaveLength(0)
  })
})
