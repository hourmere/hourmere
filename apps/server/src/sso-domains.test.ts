import { randomBytes, randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { proveMailbox, session } from '../../../packages/db/src/sso-identity-fixtures.ts'
import {
  insert,
  oidcProviderValues,
  type SsoFixture,
  ssoFixture,
} from '../../../packages/db/src/sso-storage-fixtures.ts'
import * as M from './sso-domains.ts'
import type { FreshProofResult } from './sso-fresh-proof.ts'
import { BROWSER_BINDING_COOKIE } from './sso-mailbox-proof.ts'
import { listSsoProviders } from './sso-reads.ts'

const ON = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const OFF = { ssoOidcEnabled: false, ssoSamlEnabled: false }
const publicUrl = 'http://localhost:4321'
let owned: TestDatabase
let db: Db
let f: SsoFixture
const sessions = new Map<string, string>()
const resolveTxt = vi.fn<(name: string) => Promise<string[][]>>()
const deps = (): M.SsoDomainDeps => ({ db, publicUrl, capabilities: ON, resolveTxt })
function principal(user = f.owner, team = f.team): Principal {
  return {
    kind: 'session',
    sessionId: sessions.get(user) as string,
    user: { id: user, name: 'Synthetic', email: 'synthetic@example.test' },
    organization: { id: team, name: 'Team', slug: 'team', personal: false },
  }
}
function headers(team = f.team) {
  return new Headers({
    origin: publicUrl,
    'X-Expected-Organization-Id': team,
    cookie: `${BROWSER_BINDING_COOKIE}=${randomBytes(32).toString('base64url')}`,
  })
}
async function prove(id: string) {
  const client = await owned.pool.connect()
  try {
    await proveMailbox(
      client,
      (await client.query('SELECT * FROM sso_attempts WHERE id=$1', [id])).rows[0],
    )
  } finally {
    client.release()
  }
}
async function ready<T>(
  call: (body: Record<string, unknown>) => Promise<FreshProofResult<T>>,
  body: Record<string, unknown>,
) {
  const challenge = await call(body)
  expect(challenge.status).toBe('proof_required')
  if (challenge.status !== 'proof_required') throw new Error('Expected proof')
  expect(challenge.body.proofMethods).toEqual(['mailbox'])
  await prove(challenge.body.attemptId)
  return { ...body, proofAttemptId: challenge.body.attemptId }
}
async function ceremony<T>(
  call: (body: Record<string, unknown>) => Promise<FreshProofResult<T>>,
  body: Record<string, unknown>,
): Promise<T> {
  const result = await call(await ready(call, body))
  expect(result.status).toBe('complete')
  if (result.status !== 'complete') throw new Error('Expected completion')
  return result.value
}
async function create(name = `${randomUUID()}.example.com`, p = principal(), options = deps()) {
  const h = headers(p.organization.id)
  return ceremony((body) => M.createSsoDomainChallenge(options, p, h, body), { domain: name })
}
async function verify(id: string, expectedGeneration = 1, p = principal(), options = deps()) {
  const h = headers(p.organization.id)
  return ceremony((body) => M.verifySsoDomain(options, p, h, id, body), { expectedGeneration })
}
async function expireClaim(id: string) {
  const client = await owned.pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(
      "UPDATE sso_domains SET verified_at=now()-interval '8 days', verification_expires_at=now()-interval '1 day' WHERE id=$1",
      [id],
    )
    await client.query('COMMIT')
  } finally {
    client.release()
  }
}
async function stored(id: string) {
  return db.selectFrom('sso_domains').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
}

describe('SSO domain normalization', () => {
  it.each([
    ['ExAmPlE.COM.', 'example.com'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['XN--BCHER-KVA.DE.', 'xn--bcher-kva.de'],
    ['login.example.com', 'login.example.com'],
    ['例子。公司.cn。', 'xn--fsqu00a.xn--55qx5d.cn'],
  ])('normalizes %s to the exact name %s', (input, expected) => {
    expect(M.normalizeSsoDomain(input)).toBe(expected)
  })
  it.each([
    'com',
    'co.uk',
    'github.io',
    'localhost',
    'one.local',
    'one.internal',
    'one.invalid',
    '*.example.com',
    '127.0.0.1',
    '[::1]',
    'example.com..',
    ' example.com',
    'example.com/path',
    '%65xample.com',
    'example.com?x',
    'example.com#x',
    'example.com\\evil',
    'exa\tmple.com',
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(49)}.com`,
    'a..example.com',
    '-bad.example.com',
    'bad-.example.com',
    `${'a'.repeat(64)}.com`,
    'gmail.com',
    'GOOGLEMAIL.COM.',
    'sub.gmail.com',
    'outlook.com',
    'yahoo.com',
    'qq.com',
    'proton.me',
    'fastmail.com',
    'mail.com',
    'unknown.notarealtld',
    'xn--.com',
  ])('refuses %s', (input) => {
    expect(M.normalizeSsoDomain(input)).toBeUndefined()
  })
})

describe.skipIf(!process.env.DATABASE_URL)('SSO domain authority', () => {
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      f = await ssoFixture(client)
      for (const user of [f.owner, f.admin, f.member, f.otherOwner, f.personalUser]) {
        const id = await session(client, user)
        sessions.set(user, id)
        await client.query('UPDATE auth.session SET "activeOrganizationId"=$1 WHERE id=$2', [
          user === f.otherOwner ? f.otherTeam : user === f.personalUser ? f.personal : f.team,
          id,
        ])
      }
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('uses mailbox administration, stores only a bound digest and verifies split TXT chunks exactly', async () => {
    resolveTxt.mockReset()
    const c = await create('LOGIN.Example.COM.')
    expect(c.domain).toMatchObject({ name: 'login.example.com', generation: 1, status: 'pending' })
    expect(c.txtName).toBe('_hourmere-sso.login.example.com')
    expect(c.txtValue).toMatch(/^hourmere-sso=[A-Za-z0-9_-]{43}$/)
    const before = await stored(c.domain.id)
    expect(before.challenge_digest).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(before)).not.toContain(c.txtValue)
    expect(before.claimed_at).toBeNull()
    expect(resolveTxt).not.toHaveBeenCalled()
    resolveTxt.mockResolvedValue([[c.txtValue.slice(0, 20), c.txtValue.slice(20)]])
    const checked = await verify(c.domain.id)
    expect(checked.domain).toMatchObject({ generation: 1, status: 'verified' })
    expect(resolveTxt).toHaveBeenCalledWith(c.txtName)
    expect(
      Date.parse(checked.domain.verificationExpiresAt as string) -
        Date.parse(checked.domain.verifiedAt as string),
    ).toBe(604800000)
    const events = await db
      .selectFrom('audit_events')
      .selectAll()
      .where('target_id', '=', c.domain.id)
      .orderBy('id')
      .execute()
    expect(events.map((e) => e.action)).toEqual(['sso_domain.challenged', 'sso_domain.verified'])
    expect(JSON.stringify(events)).not.toContain(c.txtValue)
    expect(JSON.stringify(events)).not.toContain(c.domain.name)
  })

  it('rotates a lost challenge, invalidates its old generation and does not accept partial TXT values', async () => {
    const first = await create()
    const next = await create(first.domain.name)
    expect(next.domain.id).toBe(first.domain.id)
    expect(next.domain.generation).toBe(2)
    expect(next.txtValue).not.toBe(first.txtValue)
    await expect(
      M.verifySsoDomain(deps(), principal(), headers(), first.domain.id, { expectedGeneration: 1 }),
    ).rejects.toMatchObject({ code: 'sso_configuration_changed' })
    resolveTxt.mockResolvedValue([[first.txtValue], [`${next.txtValue}extra`]])
    expect((await verify(next.domain.id, 2)).domain.status).toBe('failed')
    expect((await stored(next.domain.id)).claimed_at).toBeNull()
    resolveTxt.mockResolvedValue([[next.txtValue]])
    expect((await verify(next.domain.id, 2)).domain.status).toBe('verified')
  })

  it('checks fresh proof again after waiting for the exact-domain lock on creation', async () => {
    const h = headers()
    const name = `${randomUUID()}.example.com`
    const body = await ready((body) => M.createSsoDomainChallenge(deps(), principal(), h, body), {
      domain: name,
    })
    const attempt = await db
      .selectFrom('sso_attempts')
      .select('expires_at')
      .where('id', '=', body.proofAttemptId)
      .executeTakeFirstOrThrow()
    let current = new Date().toISOString()
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `sso-domain:${name}`,
      ])
      const waiting = M.createSsoDomainChallenge(
        { ...deps(), now: async () => current },
        principal(),
        h,
        body,
      )
      await vi.waitFor(async () => {
        const { rows } = await owned.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'",
        )
        expect(rows.length).toBeGreaterThan(0)
      })
      current = new Date(new Date(attempt.expires_at).getTime() + 1).toISOString()
      await client.query('COMMIT')
      expect((await waiting).status).toBe('proof_required')
      expect(
        await db.selectFrom('sso_domains').select('id').where('name', '=', name).execute(),
      ).toEqual([])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('binds a challenge to its instance, organization, domain and generation', async () => {
    const c = await create()
    resolveTxt.mockResolvedValue([[c.txtValue]])
    const other = await create(c.domain.name, principal(f.otherOwner, f.otherTeam))
    expect(
      (await verify(other.domain.id, 1, principal(f.otherOwner, f.otherTeam))).domain.status,
    ).toBe('failed')
    const another = await create()
    expect((await verify(another.domain.id)).domain.status).toBe('failed')
    const options = { ...deps(), publicUrl: 'http://localhost:4322' }
    const h = headers()
    h.set('origin', options.publicUrl)
    const result = await ceremony(
      (body) => M.verifySsoDomain(options, principal(), h, c.domain.id, body),
      { expectedGeneration: 1 },
    )
    expect(result.domain.status).toBe('failed')
  })

  it('lets a contender verify first despite an older pending challenge and serializes the race', async () => {
    const first = await create()
    const p = principal(f.otherOwner, f.otherTeam)
    const contender = await create(first.domain.name, p)
    const h1 = headers(),
      h2 = headers(f.otherTeam)
    const firstCall = (body: Record<string, unknown>) =>
      M.verifySsoDomain(deps(), principal(), h1, first.domain.id, body)
    const contenderCall = (body: Record<string, unknown>) =>
      M.verifySsoDomain(deps(), p, h2, contender.domain.id, body)
    const firstBody = await ready(firstCall, { expectedGeneration: 1 })
    const contenderBody = await ready(contenderCall, { expectedGeneration: 1 })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    resolveTxt.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return [[contender.txtValue]]
    })
    resolveTxt.mockResolvedValue([[first.txtValue]])
    const winning = contenderCall(contenderBody)
    await entered.promise
    const losing = firstCall(firstBody)
    const rejected = expect(losing).rejects.toMatchObject({ code: 'sso_domain_unverified' })
    release.resolve()
    expect((await winning).status).toBe('complete')
    await rejected
    expect((await stored(contender.domain.id)).claimed_at).not.toBeNull()
    expect((await stored(first.domain.id)).claimed_at).toBeNull()
    // Even an expired claim remains exclusive. Seed elapsed time without altering its identity.
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL session_replication_role = replica')
      await client.query(
        "UPDATE sso_domains SET verified_at=now()-interval '8 days', verification_expires_at=now()-interval '1 day' WHERE id=$1",
        [contender.domain.id],
      )
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    await expect(verify(first.domain.id)).rejects.toMatchObject({ code: 'sso_domain_unverified' })
  })

  it('keeps DNS outage unknown and recovers the current unexpired generation without rotating it', async () => {
    const c = await create()
    resolveTxt.mockRejectedValue(new Error('resolver private diagnostic must not escape'))
    expect((await verify(c.domain.id)).domain.status).toBe('unknown')
    expect((await stored(c.domain.id)).verified_at).toBeNull()
    const client = await owned.pool.connect()
    let providerId: string
    try {
      await client.query('BEGIN')
      const provider = await insert(client, 'sso_providers', oidcProviderValues(f.team))
      providerId = provider.id as string
      await insert(client, 'sso_provider_domains', {
        organization_id: f.team,
        provider_id: providerId,
        domain_id: c.domain.id,
      })
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const inventory = await listSsoProviders(deps(), principal())
    expect(inventory.data.find((p) => p.id === providerId)?.domains).toEqual([
      { id: c.domain.id, name: c.domain.name, generation: 1, status: 'unknown' },
    ])

    resolveTxt.mockResolvedValue([[c.txtValue]])
    const positive = await verify(c.domain.id)
    resolveTxt.mockRejectedValue(new Error('outage'))
    const unknown = await verify(c.domain.id)
    expect(unknown.domain.status).toBe('unknown')
    expect(unknown.domain.verifiedAt).toBe(positive.domain.verifiedAt)
    expect(unknown.domain.verificationExpiresAt).toBe(positive.domain.verificationExpiresAt)
    resolveTxt.mockResolvedValue([])
    expect((await verify(c.domain.id)).domain.status).toBe('failed')
    resolveTxt.mockResolvedValue([[c.txtValue]])
    const recovered = await verify(c.domain.id)
    expect(recovered.domain).toMatchObject({
      status: 'verified',
      generation: 1,
      verifiedAt: positive.domain.verifiedAt,
    })
    const events = await db
      .selectFrom('audit_events')
      .select(['action', 'details'])
      .where('target_id', '=', c.domain.id)
      .orderBy('id')
      .execute()
    expect(events.filter((e) => e.action === 'sso_domain.renewed').map((e) => e.details)).toEqual([
      { outcome: 'unknown' },
      { outcome: 'unknown' },
      { outcome: 'failed' },
      { outcome: 'passed' },
    ])
  })

  it('refuses the exact challenge deadline including a DNS lookup that crosses it', async () => {
    const c = await create()
    const h = headers()
    const body = await ready(
      (body) => M.verifySsoDomain(deps(), principal(), h, c.domain.id, body),
      { expectedGeneration: 1 },
    )
    resolveTxt.mockResolvedValue([[c.txtValue]])
    const now = vi.fn().mockResolvedValue(c.expiresAt)
    now.mockResolvedValueOnce(new Date().toISOString())
    await expect(
      M.verifySsoDomain({ ...deps(), now }, principal(), h, c.domain.id, body),
    ).rejects.toMatchObject({ code: 'sso_domain_unverified' })
    const crossing = vi.fn().mockResolvedValue(c.expiresAt)
    crossing
      .mockResolvedValueOnce(new Date().toISOString())
      .mockResolvedValueOnce(new Date(Date.parse(c.expiresAt) - 1).toISOString())
    await expect(
      M.verifySsoDomain({ ...deps(), now: crossing }, principal(), h, c.domain.id, body),
    ).rejects.toMatchObject({ code: 'sso_domain_unverified' })
    expect((await stored(c.domain.id)).claimed_at).toBeNull()
  })

  it('requires a new challenge after verification expiry, while rotation keeps the old claim exclusive', async () => {
    const c = await create()
    resolveTxt.mockResolvedValue([[c.txtValue]])
    const checked = await verify(c.domain.id)
    const h = headers()
    const body = await ready(
      (body) => M.verifySsoDomain(deps(), principal(), h, c.domain.id, body),
      { expectedGeneration: 1 },
    )
    const now = vi.fn().mockResolvedValue(checked.domain.verificationExpiresAt)
    now.mockResolvedValueOnce(new Date().toISOString())
    await expect(
      M.verifySsoDomain({ ...deps(), now }, principal(), h, c.domain.id, body),
    ).rejects.toMatchObject({ code: 'sso_domain_unverified' })
    await expireClaim(c.domain.id)
    const rotated = await create(c.domain.name)
    expect(rotated.domain.generation).toBe(2)
    expect((await stored(c.domain.id)).claimed_at).not.toBeNull()
    const contender = await create(c.domain.name, principal(f.otherOwner, f.otherTeam))
    resolveTxt.mockResolvedValue([[contender.txtValue]])
    await expect(
      verify(contender.domain.id, 1, principal(f.otherOwner, f.otherTeam)),
    ).rejects.toMatchObject({ code: 'sso_domain_unverified' })
    resolveTxt.mockResolvedValue([[rotated.txtValue]])
    expect((await verify(rotated.domain.id, 2)).domain.status).toBe('verified')
  })

  it('retires exactly the current generation with proof and never moves personal accounts or membership', async () => {
    const before = await db.selectFrom('auth.member').selectAll().orderBy('id').execute()
    const personal = await db
      .selectFrom('personal_organizations')
      .selectAll()
      .orderBy('organization_id')
      .execute()
    const c = await create()
    resolveTxt.mockResolvedValue([[c.txtValue]])
    await verify(c.domain.id)
    const h = headers()
    await expect(
      M.deleteSsoDomain(deps(), principal(), h, c.domain.id, { expectedGeneration: 2 }),
    ).rejects.toMatchObject({ code: 'sso_configuration_changed' })
    expect(
      await ceremony((body) => M.deleteSsoDomain(deps(), principal(), h, c.domain.id, body), {
        expectedGeneration: 1,
      }),
    ).toEqual({ deleted: true })
    expect((await stored(c.domain.id)).retired_at).not.toBeNull()
    for (const call of [M.verifySsoDomain, M.deleteSsoDomain])
      await expect(
        call(deps(), principal(), h, c.domain.id, { expectedGeneration: 1 }),
      ).rejects.toMatchObject({ code: 'sso_not_found' })
    const newClaim = await create(c.domain.name, principal(f.otherOwner, f.otherTeam))
    resolveTxt.mockResolvedValue([[newClaim.txtValue]])
    expect(
      (await verify(newClaim.domain.id, 1, principal(f.otherOwner, f.otherTeam))).domain.status,
    ).toBe('verified')
    expect(await db.selectFrom('auth.member').selectAll().orderBy('id').execute()).toEqual(before)
    expect(
      await db
        .selectFrom('personal_organizations')
        .selectAll()
        .orderBy('organization_id')
        .execute(),
    ).toEqual(personal)
    expect(
      await db
        .selectFrom('audit_events')
        .select('action')
        .where('target_id', '=', c.domain.id)
        .orderBy('id')
        .execute(),
    ).toEqual([
      { action: 'sso_domain.challenged' },
      { action: 'sso_domain.verified' },
      { action: 'sso_domain.released' },
    ])
  })

  it('denies machine credentials, members, personal teams, cross-team IDs and changed roles uniformly', async () => {
    for (const p of [
      principal(f.member),
      {
        ...principal(f.personalUser, f.personal),
        organization: { ...principal().organization, id: f.personal, personal: true },
      },
      {
        ...principal(),
        kind: 'api_key' as const,
        apiKeyId: randomUUID(),
        apiKeyScope: 'full' as const,
      },
      {
        ...principal(),
        kind: 'oauth' as const,
        oauthConsentId: randomUUID(),
        clientId: 'client',
        scopes: ['mcp:tools'],
      },
    ])
      await expect(
        M.createSsoDomainChallenge(deps(), p, headers(p.organization.id), {
          domain: 'example.com',
        }),
      ).rejects.toMatchObject({ code: 'team_management_access_denied' })
    const c = await create()
    for (const call of [M.verifySsoDomain, M.deleteSsoDomain])
      await expect(
        call(deps(), principal(f.otherOwner, f.otherTeam), headers(f.otherTeam), c.domain.id, {
          expectedGeneration: 1,
        }),
      ).rejects.toMatchObject({ code: 'sso_not_found' })
    const h = headers()
    const p = principal(f.admin)
    const input = { domain: 'admin.example.com' }
    const body = await ready((body) => M.createSsoDomainChallenge(deps(), p, h, body), input)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('id', '=', f.adminMember)
      .execute()
    try {
      await expect(M.createSsoDomainChallenge(deps(), p, h, body)).rejects.toMatchObject({
        code: 'team_management_access_denied',
      })
    } finally {
      await db
        .updateTable('auth.member')
        .set({ role: 'admin' })
        .where('id', '=', f.adminMember)
        .execute()
    }
    const foreign = headers()
    foreign.set('origin', 'https://other.example.com')
    await expect(
      M.createSsoDomainChallenge(deps(), principal(), foreign, input),
    ).rejects.toMatchObject({ code: 'team_management_access_denied' })
  })

  it('keeps Off ahead of all lookup, writes and DNS regardless of supplied identifiers', async () => {
    const off = {
      ...deps(),
      capabilities: OFF,
      db: new Proxy({} as Db, {
        get: () => {
          throw new Error('Unexpected lookup')
        },
      }),
    }
    resolveTxt.mockReset()
    for (const call of [
      () => M.createSsoDomainChallenge(off, principal(), headers(), { domain: 'example.com' }),
      () => M.verifySsoDomain(off, principal(), headers(), 'bad', {}),
      () => M.deleteSsoDomain(off, principal(), headers(), 'bad', {}),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'sso_disabled' })
    expect(resolveTxt).not.toHaveBeenCalled()
  })
})
