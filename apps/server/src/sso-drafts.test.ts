import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { proveMailbox, session } from '../../../packages/db/src/sso-identity-fixtures.ts'
import { type SsoFixture, ssoFixture } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { openSsoProviderConfiguration } from './sso-configuration.ts'
import * as real from './sso-drafts.ts'
import { BROWSER_BINDING_COOKIE } from './sso-mailbox-proof.ts'

const ON = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const OFF = { ssoOidcEnabled: false, ssoSamlEnabled: false }
const publicUrl = 'http://localhost:4321'
const secret = 'synthetic-provider-secret-do-not-echo'
const key = randomBytes(32)
let owned: TestDatabase
let db: Db
let f: SsoFixture
const sessions = new Map<string, string>()
const deps = () => ({ db, publicUrl, configurationKey: key, capabilities: ON })
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
const input = () => ({
  protocol: 'oidc',
  displayName: 'Synthetic IdP',
  domainIds: [],
  oidc: {
    issuer: 'https://issuer.example.com',
    clientId: 'synthetic-client',
    clientSecret: secret,
  },
})
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
async function ceremony<T>(
  call: (
    body: Record<string, unknown>,
  ) => Promise<import('./sso-fresh-proof.ts').FreshProofResult<T>>,
  body: Record<string, unknown>,
): Promise<T> {
  const challenge = await call(body)
  expect(challenge.status).toBe('proof_required')
  if (challenge.status !== 'proof_required') throw new Error('Expected proof')
  expect(challenge.body.proofMethods).toEqual(['mailbox'])
  await prove(challenge.body.attemptId)
  const result = await call({ ...body, proofAttemptId: challenge.body.attemptId })
  expect(result.status).toBe('complete')
  if (result.status !== 'complete') throw new Error('Expected completion')
  return result.value
}
async function create(M = real) {
  const h = headers()
  return (await ceremony((body) => M.createSsoProvider(deps(), principal(), h, body), input()))
    .provider
}
async function trust() {
  return (
    (
      await db
        .selectFrom('sso_policies')
        .select('trust_generation')
        .where('organization_id', '=', f.team)
        .executeTakeFirst()
    )?.trust_generation ?? 1
  )
}
async function sourceCopy(change: [string, string]): Promise<typeof real> {
  let source = readFileSync(new URL('./sso-drafts.ts', import.meta.url), 'utf8')
  expect(source).toContain(change[0])
  source = source.replace(...change)
  const js = stripTypeScriptTypes(source).replace(
    /((?:from|import)\s*)'([^']+)'/g,
    (_, prefix: string, specifier: string) => `${prefix}'${import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}

describe.skipIf(!process.env.DATABASE_URL)('SSO provider drafts', () => {
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      f = await ssoFixture(client)
      for (const user of [f.owner, f.admin, f.member, f.otherOwner]) {
        const id = await session(client, user)
        sessions.set(user, id)
        await client.query('UPDATE auth.session SET "activeOrganizationId"=$1 WHERE id=$2', [
          user === f.otherOwner ? f.otherTeam : f.team,
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

  it('creates the first disabled provider with mailbox proof, ciphertext-only storage and safe response/audit', async () => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const p = await create()
      expect(p).toMatchObject({
        enabled: false,
        revision: 1,
        hasClientSecret: true,
        testStatus: 'unknown',
      })
      const stored = await db
        .selectFrom('sso_providers')
        .selectAll()
        .where('id', '=', p.id)
        .executeTakeFirstOrThrow()
      expect(stored.configuration.includes(Buffer.from(secret))).toBe(false)
      expect(
        JSON.parse(
          openSsoProviderConfiguration(
            key,
            { organizationId: f.team, providerId: p.id, revision: 1 },
            stored.configuration,
          ),
        ).clientSecret,
      ).toBe(secret)
      const audit = await db
        .selectFrom('audit_events')
        .selectAll()
        .where('target_id', '=', p.id)
        .execute()
      expect(audit.map((e) => e.action)).toEqual(['sso_provider.created'])
      expect(JSON.stringify([p, audit, logs.mock.calls])).not.toContain(secret)
    } finally {
      logs.mockRestore()
    }
  })
  it('preserves omitted secrets; only trust edits and deletion advance trust; retired delete is idempotent', async () => {
    const p = await create()
    const h = headers()
    const initial = await trust()
    const renamed = await ceremony(
      (body) => real.updateSsoProvider(deps(), principal(), h, p.id, body),
      { expectedRevision: 1, displayName: 'Renamed' },
    )
    expect(renamed.provider.revision).toBe(2)
    expect(await trust()).toBe(initial)
    let row = await db
      .selectFrom('sso_providers')
      .selectAll()
      .where('id', '=', p.id)
      .executeTakeFirstOrThrow()
    expect(
      JSON.parse(
        openSsoProviderConfiguration(
          key,
          { organizationId: f.team, providerId: p.id, revision: 2 },
          row.configuration,
        ),
      ).clientSecret,
    ).toBe(secret)
    await ceremony((body) => real.updateSsoProvider(deps(), principal(), h, p.id, body), {
      expectedRevision: 2,
      oidc: { clientSecret: `${secret}-replacement` },
    })
    expect(await trust()).toBe(initial + 1)
    await ceremony((body) => real.deleteSsoProvider(deps(), principal(), h, p.id, body), {
      expectedRevision: 3,
    })
    expect(await trust()).toBe(initial + 2)
    await ceremony((body) => real.deleteSsoProvider(deps(), principal(), h, p.id, body), {
      expectedRevision: 3,
    })
    expect(await trust()).toBe(initial + 2)
    row = await db
      .selectFrom('sso_providers')
      .selectAll()
      .where('id', '=', p.id)
      .executeTakeFirstOrThrow()
    expect(row.retired_at).not.toBeNull()
    expect(row.enabled).toBe(false)
    await expect(
      real.updateSsoProvider(deps(), principal(), h, p.id, {
        expectedRevision: 4,
        displayName: 'Revive',
      }),
    ).rejects.toMatchObject({ code: 'sso_not_found' })
  })
  it('refuses members, foreign users, machine credentials, stale team context and bearer plus cookie', async () => {
    for (const p of [
      principal(f.member),
      principal(f.otherOwner),
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
    ]) {
      await expect(real.createSsoProvider(deps(), p, headers(), input())).rejects.toMatchObject({
        code: 'team_management_access_denied',
      })
    }
    await expect(
      real.createSsoProvider(deps(), principal(), headers(f.otherTeam), input()),
    ).rejects.toMatchObject({ code: 'team_management_access_denied' })
    const bearer = headers()
    bearer.set('authorization', 'Bearer synthetic')
    await expect(
      real.createSsoProvider(deps(), principal(), bearer, input()),
    ).rejects.toMatchObject({ code: 'team_management_access_denied' })
    const h = headers()
    await ceremony((body) => real.createSsoProvider(deps(), principal(f.admin), h, body), input())
  })
  it('checks role and active session context again after proof issuance', async () => {
    const h = headers()
    const p = principal(f.admin)
    const challenge = await real.createSsoProvider(deps(), p, h, input())
    if (challenge.status !== 'proof_required') throw new Error('Expected proof')
    await prove(challenge.body.attemptId)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('id', '=', f.adminMember)
      .execute()
    try {
      await expect(
        real.createSsoProvider(deps(), p, h, {
          ...input(),
          proofAttemptId: challenge.body.attemptId,
        }),
      ).rejects.toMatchObject({ code: 'team_management_access_denied' })
    } finally {
      await db
        .updateTable('auth.member')
        .set({ role: 'admin' })
        .where('id', '=', f.adminMember)
        .execute()
    }
    await db
      .updateTable('auth.session')
      .set({ activeOrganizationId: f.otherTeam })
      .where('id', '=', sessions.get(f.admin) as string)
      .execute()
    try {
      await expect(
        real.createSsoProvider(deps(), p, h, {
          ...input(),
          proofAttemptId: challenge.body.attemptId,
        }),
      ).rejects.toMatchObject({ code: 'organization_context_changed' })
    } finally {
      await db
        .updateTable('auth.session')
        .set({ activeOrganizationId: f.team })
        .where('id', '=', sessions.get(f.admin) as string)
        .execute()
    }
  })
  it('serializes concurrent edits and refuses identity replacement and foreign provider IDs', async () => {
    const p = await create()
    const h = headers()
    const bodies = [
      { expectedRevision: 1, displayName: 'One' },
      { expectedRevision: 1, displayName: 'Two' },
    ]
    const ready = []
    for (const body of bodies) {
      const result = await real.updateSsoProvider(deps(), principal(), h, p.id, body)
      if (result.status !== 'proof_required') throw new Error('Expected proof')
      await prove(result.body.attemptId)
      ready.push({ ...body, proofAttemptId: result.body.attemptId })
    }
    const results = await Promise.allSettled(
      ready.map((body) => real.updateSsoProvider(deps(), principal(), h, p.id, body)),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'sso_configuration_changed' },
    })
    await expect(
      real.updateSsoProvider(deps(), principal(), h, p.id, {
        expectedRevision: 2,
        oidc: { issuer: 'https://other.example.com' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      real.deleteSsoProvider(
        deps(),
        principal(f.otherOwner, f.otherTeam),
        headers(f.otherTeam),
        p.id,
        { expectedRevision: 2 },
      ),
    ).rejects.toMatchObject({ code: 'sso_not_found' })
  })
  it('binds a proof retry to its provider and refuses foreign domains without writing', async () => {
    const first = await create()
    const second = await create()
    const h = headers()
    const body = { expectedRevision: 1, displayName: 'Bound rename' }
    const challenge = await real.updateSsoProvider(deps(), principal(), h, first.id, body)
    if (challenge.status !== 'proof_required') throw new Error('Expected proof')
    await prove(challenge.body.attemptId)
    const crossed = await real.updateSsoProvider(deps(), principal(), h, second.id, {
      ...body,
      proofAttemptId: challenge.body.attemptId,
    })
    expect(crossed.status).toBe('proof_required')
    expect(
      (
        await db
          .selectFrom('sso_providers')
          .select('revision')
          .where('id', '=', second.id)
          .executeTakeFirstOrThrow()
      ).revision,
    ).toBe(1)
    await expect(
      real.createSsoProvider(deps(), principal(), h, { ...input(), domainIds: [randomUUID()] }),
    ).rejects.toMatchObject({ code: 'sso_not_found' })
    await expect(
      real.updateSsoProvider(deps(), principal(), h, first.id, { ...body, providerId: second.id }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })
  it('keeps Off ahead of lookup and rejects SAML, unknown fields and null replacement secrets', async () => {
    const off = {
      ...deps(),
      capabilities: OFF,
      db: new Proxy({} as Db, {
        get: () => {
          throw new Error('Unexpected lookup')
        },
      }),
    }
    for (const call of [
      () => real.createSsoProvider(off, principal(), headers(), input()),
      () => real.updateSsoProvider(off, principal(), headers(), 'bad', {}),
      () => real.deleteSsoProvider(off, principal(), headers(), 'bad', {}),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'sso_disabled' })
    await expect(
      real.createSsoProvider(deps(), principal(), headers(), { protocol: 'saml' }),
    ).rejects.toMatchObject({ code: 'sso_disabled' })
    await expect(
      real.createSsoProvider(deps(), principal(), headers(), {
        ...input(),
        callbackUrl: 'https://bad.example.com',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      real.createSsoProvider(deps(), principal(), headers(), {
        ...input(),
        oidc: { ...input().oidc, clientSecret: null },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })
  it('source-copy mutation kills removal of the transaction-time role check', async () => {
    const mutant2 = await sourceCopy([
      'await authorize(deps, db, p, headers)',
      '// removed authority check',
    ])
    async function assertion(M: typeof real) {
      await expect(
        M.createSsoProvider(deps(), principal(f.member), headers(), input()),
      ).rejects.toMatchObject({ code: 'team_management_access_denied' })
    }
    await assertion(real)
    await expect(assertion(mutant2)).rejects.toThrow()
  })
  it('source-copy mutation kills removal of trust invalidation', async () => {
    const mutant = await sourceCopy([
      'if (trustChanged) await changeTrust(db, p.organization.id)',
      '// removed trust invalidation',
    ])
    const p = await create()
    const h = headers()
    const previous = await trust()
    await ceremony((body) => mutant.updateSsoProvider(deps(), principal(), h, p.id, body), {
      expectedRevision: 1,
      oidc: { clientSecret: `${secret}-mutant` },
    })
    const awaitTrustValue = await trust()
    expect(() => expect(awaitTrustValue).toBe(previous + 1)).toThrow()
    expect(awaitTrustValue).toBe(previous)
  })
})
