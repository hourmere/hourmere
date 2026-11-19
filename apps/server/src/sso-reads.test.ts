import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type IdentityFixture,
  identityFixture,
  link,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { insert, oidcProviderValues } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { ssoReadTools } from './mcp/sso.ts'
import { type McpCaller, runTool } from './mcp/tools.ts'
import { ssoRoutes } from './routes/sso.ts'
import { openApiDocument, responseAndRequestStrictness } from './routes/test-app.ts'
import * as real from './sso-reads.ts'

const ON = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const OFF = { ssoOidcEnabled: false, ssoSamlEnabled: false }
let owned: TestDatabase
let db: Db
let f: IdentityFixture
let ownIds: string[]
const sentinel = 'synthetic-secret-raw-metadata-subject'
function principal(user = f.owner, team = f.team): Principal {
  return {
    kind: 'api_key',
    apiKeyId: randomUUID(),
    apiKeyScope: 'read',
    user: { id: user, name: 'Test', email: 'test@example.test' },
    organization: { id: team, name: 'Team', slug: 'team', personal: false },
  }
}
const deps = () => ({ db, capabilities: ON })
function app(p = principal(), capabilities = ON) {
  return createApp({
    publicUrl: 'http://localhost:4321',
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({ ok: true, principal: p, setCookie: [] }),
    routes: [ssoRoutes({ db, capabilities })],
  })
}
const get = (
  a: ReturnType<typeof app>,
  path: string,
  headers: Record<string, string> = { authorization: 'Bearer hm_synthetic' },
) => a.request(`/api/v1/team/sso/${path}`, { headers })
async function copy(change?: [string, string]): Promise<typeof real> {
  let source = readFileSync(new URL('./sso-reads.ts', import.meta.url), 'utf8')
  if (change) {
    expect(source.includes(change[0])).toBe(true)
    source = source.replace(...change)
  }
  const js = stripTypeScriptTypes(source).replace(
    /((?:from|import)\s*)'([^']+)'/g,
    (_, prefix: string, specifier: string) => `${prefix}'${import.meta.resolve(specifier)}'`,
  )
  return guardCopy(
    await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`),
  )
}

describe.skipIf(!process.env.DATABASE_URL)('SSO draft reads', () => {
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      f = await identityFixture(client)
      await client.query('UPDATE auth.session SET "activeOrganizationId"=$1 WHERE id=$2', [
        f.team,
        f.sessions[f.owner],
      ])
      ownIds = [f.provider.id as string]
      for (let i = 1; i < 103; i++) {
        const row = await insert(client, 'sso_providers', {
          ...oidcProviderValues(f.team),
          configuration: Buffer.concat([Buffer.from([1]), Buffer.alloc(29), Buffer.from(sentinel)]),
        })
        ownIds.push(row.id as string)
      }
      const retired = await insert(client, 'sso_providers', {
        ...oidcProviderValues(f.team),
        retired_at: new Date(),
      })
      expect(ownIds).not.toContain(retired.id)
      const retiredLink = await link(f, f.admin)
      await client.query(
        'UPDATE sso_identity_links SET retired_at=clock_timestamp(), generation=generation+1 WHERE id=$1',
        [retiredLink.id],
      )
      await link(f, f.otherOwner)
      await link(f, f.otherOwner, f.otherProvider)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('paginates beyond 101 with safe fields, no retired or foreign providers and no logged secret', async () => {
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const first = await real.listSsoProviders(deps(), principal(), { limit: 100 })
      const second = await real.listSsoProviders(deps(), principal(), {
        limit: 100,
        cursor: first.nextCursor as string,
      })
      expect(first.data).toHaveLength(100)
      expect(second.data).toHaveLength(3)
      expect(second.nextCursor).toBeNull()
      expect([...first.data, ...second.data].map((p) => p.id).sort()).toEqual(ownIds.toSorted())
      expect(first.data[0]).toMatchObject({
        validationStatus: 'unknown',
        testStatus: 'unknown',
      })
      expect(JSON.stringify([first, second, logs.mock.calls]).includes(sentinel)).toBe(false)
      expect(first.data.every((p) => !('configuration' in p) && !('subject' in p))).toBe(true)
      await expect(
        real.listSsoProviders(deps(), principal(f.otherOwner, f.otherTeam), {
          cursor: first.nextCursor as string,
        }),
      ).rejects.toMatchObject({ code: 'invalid_cursor' })
    } finally {
      logs.mockRestore()
    }
  })
  it('allows owners/admins with read/full keys and mcp:tools OAuth, uniformly refuses members, foreign users and bookings keys', async () => {
    for (const user of [f.owner, f.admin]) {
      const p = principal(user)
      for (const credential of [
        { kind: 'session' as const, sessionId: randomUUID() },
        { kind: 'api_key' as const, apiKeyId: randomUUID(), apiKeyScope: 'read' as const },
        { kind: 'api_key' as const, apiKeyId: randomUUID(), apiKeyScope: 'full' as const },
        {
          kind: 'oauth' as const,
          oauthConsentId: randomUUID(),
          clientId: 'client',
          scopes: ['mcp:tools'],
        },
      ]) {
        await expect(real.getSsoPolicy(deps(), { ...p, ...credential })).resolves.toMatchObject({
          requireSso: false,
          admission: 'invitation_only',
        })
      }
    }
    for (const p of [
      principal(f.member),
      principal(f.otherOwner),
      {
        ...principal(),
        kind: 'api_key' as const,
        apiKeyId: randomUUID(),
        apiKeyScope: 'bookings' as const,
      },
      {
        ...principal(),
        kind: 'oauth' as const,
        oauthConsentId: randomUUID(),
        clientId: 'client',
        scopes: [],
      },
    ]) {
      await expect(real.getSsoPolicy(deps(), p)).rejects.toMatchObject({
        code: 'team_management_access_denied',
      })
      await expect(real.listSsoProviders(deps(), p)).rejects.toMatchObject({
        code: 'team_management_access_denied',
      })
    }
  })
  it('serves the same service projections through REST and documents open status strings', async () => {
    const a = app()
    expect(await (await get(a, 'providers')).json()).toEqual(
      await real.listSsoProviders(deps(), principal()),
    )
    expect(await (await get(a, 'policy')).json()).toEqual(
      await real.getSsoPolicy(deps(), principal()),
    )
    for (const path of ['providers?limit=bad', 'providers?cursor=bad']) {
      const denied = await get(app(principal(f.member)), path)
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'team_management_access_denied' })
    }
    const response = await get(app(principal(f.member)), 'policy')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
  })
  it('gives active administration sessions only live opaque links for each current team provider', async () => {
    type ProviderPage = { data: { id: string; links?: unknown[] }[] }
    const browser: Principal = {
      ...principal(),
      kind: 'session',
      sessionId: f.sessions[f.owner] as string,
    }
    const page = await get(app(browser), 'providers?limit=100', {})
    expect(page.status).toBe(200)
    const providers = ((await page.json()) as ProviderPage).data
    expect(providers.map(({ id, links }) => ({ id, links }))).toEqual(
      ownIds
        .toSorted()
        .slice(0, 100)
        .map((id) => ({
          id,
          links:
            id === f.provider.id
              ? [{ id: f.memberLink.id, generation: f.memberLink.generation }]
              : [],
        })),
    )
    expect(JSON.stringify(providers)).not.toContain(String(f.memberLink.subject))
    expect(JSON.stringify(providers)).not.toContain(String(f.memberLink.proven_email))

    const unselected: Principal = {
      ...principal(f.admin),
      kind: 'session',
      sessionId: f.sessions[f.admin] as string,
    }
    const staleSession = await get(app(unselected), 'providers', {})
    expect(staleSession.status).toBe(200)
    const stalePage = (await staleSession.json()) as ProviderPage
    expect(stalePage.data.every((row) => row.links?.length === 0)).toBe(true)

    for (const caller of [browser, principal()]) {
      const response = await get(app(caller), 'providers')
      expect(response.status).toBe(200)
      const machinePage = (await response.json()) as ProviderPage
      expect(machinePage.data.every((row) => !('links' in row))).toBe(true)
    }
  })
  it('refuses personal spaces, unverified administrators and bookings keys on both REST reads', async () => {
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.coOwner)
      .execute()
    for (const p of [principal(f.coOwner), principal(f.personalUser, f.personal)]) {
      for (const read of [real.getSsoPolicy, real.listSsoProviders]) {
        await expect(read(deps(), p)).rejects.toMatchObject({
          code: 'team_management_access_denied',
        })
      }
    }
    const p: Principal = {
      ...principal(),
      kind: 'api_key',
      apiKeyId: randomUUID(),
      apiKeyScope: 'bookings',
    }
    for (const path of ['providers', 'policy']) {
      const response = await get(app(p), path)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'insufficient_scope' })
    }
  })
  it('reads configured policy values without changing them', async () => {
    await db
      .insertInto('sso_policies')
      .values({
        organization_id: f.otherTeam,
        require_sso: false,
        admission: 'jit',
        policy_revision: 7,
        trust_generation: 4,
      })
      .execute()
    const p = principal(f.otherOwner, f.otherTeam)
    const expected = { requireSso: false, admission: 'jit', policyRevision: 7, trustGeneration: 4 }
    expect(await real.getSsoPolicy(deps(), p)).toEqual(expected)
    expect(await (await get(app(p), 'policy')).json()).toEqual(expected)
    expect(await real.getSsoPolicy(deps(), p)).toEqual(expected)
  })
  it('returns identical REST, MCP and CLI output and keeps response objects/statuses open', async () => {
    const a = app()
    const tools = ssoReadTools(deps())
    const log = vi.fn()
    for (const [toolName, path, argv] of [
      ['list_sso_providers', 'providers', ['sso', 'providers', 'list']],
      ['get_sso_policy', 'policy', ['sso', 'policy']],
    ] as const) {
      const tool = tools.find((t) => t.name === toolName)
      if (!tool) throw new Error('missing tool')
      const expected = await (await get(a, path)).json()
      const result = await runTool(
        tool,
        {},
        { caller: principal() as McpCaller, rateLimit: () => {} },
        log,
      )
      expect(result.structuredContent).toEqual(expected)
      let output = ''
      const code = await runCli({
        argv: [...argv],
        env: { HOURMERE_URL: 'https://hourmere.example', HOURMERE_API_KEY: 'hm_synthetic' },
        stdin: (async function* () {})(),
        stdout: (text) => {
          output += text
        },
        stderr: () => {},
        fetch: async (_url, init) => {
          const request = JSON.parse(String(init?.body))
          expect(request.params.name).toBe(toolName)
          return Response.json({
            jsonrpc: '2.0',
            id: request.id,
            result: await runTool(
              tool,
              request.params.arguments,
              { caller: principal() as McpCaller, rateLimit: () => {} },
              log,
            ),
          })
        },
      })
      expect(code).toBe(0)
      expect(JSON.parse(output)).toEqual(expected)
      const denied = await runTool(
        tool,
        {},
        { caller: principal(f.member) as McpCaller, rateLimit: () => {} },
        log,
      )
      expect(denied.isError).toBe(true)
      const errorText = denied.content.find((item) => item.type === 'text')
      if (errorText?.type !== 'text') throw new Error('missing error text')
      expect(JSON.parse(errorText.text)).toEqual({ error: 'team_management_access_denied' })
      expect(JSON.stringify([result, output, denied, log.mock.calls]).includes(sentinel)).toBe(
        false,
      )
    }
    const doc = await openApiDocument(a)
    expect(
      responseAndRequestStrictness(doc, ['/api/v1/team/sso/providers', '/api/v1/team/sso/policy'])
        .closedResponses,
    ).toEqual([])
    expect(JSON.stringify(doc.components.schemas.SsoProviderPage)).not.toContain('"enum"')
  })
  it('refuses both REST reads and direct services before any lookup while Off', async () => {
    const trap = {
      selectFrom: () => {
        throw new Error('unexpected lookup')
      },
    } as unknown as Db
    for (const read of [real.getSsoPolicy, real.listSsoProviders])
      await expect(read({ db: trap, capabilities: OFF }, principal())).rejects.toMatchObject({
        code: 'sso_disabled',
      })
    for (const path of ['providers?cursor=bad&limit=bad', 'policy']) {
      const response = await get(app(principal(f.member), OFF), path)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('{"error":"sso_disabled"}')
    }
  })
  it('source-copy controls kill removed role, tenant and Off protections', async () => {
    const checks: Array<[[string, string], (module: typeof real) => Promise<void>]> = [
      [
        ["['owner', 'admin']", "['owner', 'admin', 'member']"],
        async (m) => {
          await expect(m.getSsoPolicy(deps(), principal(f.member))).rejects.toMatchObject({
            code: 'team_management_access_denied',
          })
        },
      ],
      [
        [
          ".where('organization_id', '=', principal.organization.id)\n    .where('retired_at'",
          ".where('retired_at'",
        ],
        async (m) => {
          const result = await m.listSsoProviders(deps(), principal(), { limit: 100 })
          const more = await m.listSsoProviders(deps(), principal(), {
            limit: 100,
            cursor: result.nextCursor as string,
          })
          expect([...result.data, ...more.data].map((p) => p.id).sort()).toEqual(ownIds.toSorted())
        },
      ],
      [
        ['  requireSsoEnabled(deps.capabilities)', '  // removed guard'],
        async (m) => {
          await expect(
            m.getSsoPolicy({ db, capabilities: OFF }, principal()),
          ).rejects.toMatchObject({ code: 'sso_disabled' })
        },
      ],
    ]
    for (const [change, verify] of checks) {
      await verify(await copy())
      const mutant = await copy(change)
      await expectKilled(mutant, () => verify(mutant))
    }
  })
})
