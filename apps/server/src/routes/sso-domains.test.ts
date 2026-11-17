import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  type IdentityFixture,
  identityFixture,
  proveMailbox,
} from '../../../../packages/db/src/sso-identity-fixtures.ts'
import { createApp } from '../app.ts'
import { ssoDomainRoutes } from './sso-domains.ts'
import { openApiDocument, responseAndRequestStrictness } from './test-app.ts'

const publicUrl = 'http://localhost:4321'
const ON = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const OFF = { ssoOidcEnabled: false, ssoSamlEnabled: false }
let owned: TestDatabase
let db: Db
let f: IdentityFixture
let txtRecords: string[][] = []
function principal(user = f.owner): Principal {
  return {
    kind: 'session',
    sessionId: f.sessions[user] as string,
    user: { id: user, name: 'Synthetic', email: 'synthetic@example.test' },
    organization: { id: f.team, name: 'Team', slug: 'team', personal: false },
  }
}
function app(p = principal(), capabilities = ON) {
  return createApp({
    publicUrl,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({ ok: true, principal: p, setCookie: [] }),
    routes: [ssoDomainRoutes({ db, capabilities, publicUrl, resolveTxt: async () => txtRecords })],
  })
}
const input = { domain: 'example.com' }
function request(
  a: ReturnType<typeof app>,
  method: string,
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
) {
  return a.request(`/api/v1/team/sso/domains${path}`, {
    method,
    headers: {
      origin: publicUrl,
      'content-type': 'application/json',
      'X-Expected-Organization-Id': f.team,
      ...extra,
    },
    body: JSON.stringify(body),
  })
}

describe.skipIf(!process.env.DATABASE_URL)('SSO domain REST writes', () => {
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      f = await identityFixture(client)
      await client.query(
        'UPDATE auth.session SET "activeOrganizationId"=$1 WHERE "userId" = ANY($2::uuid[])',
        [f.team, [f.owner, f.admin, f.member, f.otherOwner]],
      )
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('documents strict browser-only writes and open safe responses', async () => {
    const doc = await openApiDocument(app())
    for (const [method, path, id] of [
      ['post', '/api/v1/team/sso/domains', 'createSsoDomainChallenge'],
      ['post', '/api/v1/team/sso/domains/{domainId}/verify', 'verifySsoDomain'],
      ['delete', '/api/v1/team/sso/domains/{domainId}', 'deleteSsoDomain'],
    ] as const) {
      const operation = doc.paths[path]?.[method]
      expect((operation as { operationId?: string })?.operationId).toBe(id)
      expect(operation?.security).toEqual([{ session: [] }])
      expect(operation?.requestBody).toBeDefined()
    }
    expect(
      responseAndRequestStrictness(doc, [
        '/api/v1/team/sso/domains',
        '/api/v1/team/sso/domains/{domainId}',
        '/api/v1/team/sso/domains/{domainId}/verify',
      ]),
    ).toMatchObject({ closedResponses: [], openRequests: [] })
  })
  it('refuses machine credentials including bearer plus cookie with one uniform denial', async () => {
    for (const p of [
      principal(),
      ...(['full', 'read', 'bookings'] as const).map((apiKeyScope) => ({
        ...principal(),
        kind: 'api_key' as const,
        apiKeyId: randomUUID(),
        apiKeyScope,
      })),
    ]) {
      for (const [method, path, body] of [
        ['POST', '', input],
        ['POST', `/${randomUUID()}/verify`, { expectedGeneration: 1 }],
        ['DELETE', `/${randomUUID()}`, { expectedGeneration: 1 }],
      ] as const) {
        const response = await request(app(p), method, path, body, {
          authorization: 'Bearer hm_synthetic',
          cookie: 'session=synthetic',
        })
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
      }
    }
  })
  it('rejects missing exact Origin, members, foreign users and unknown request fields', async () => {
    for (const p of [principal(f.member), principal(f.otherOwner)]) {
      const response = await request(app(p), 'POST', '', input)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'team_management_access_denied' })
    }
    const origin = await request(app(), 'POST', '', input, { origin: '', referer: publicUrl })
    expect(await origin.json()).toEqual({ error: 'team_management_access_denied' })
    const unknown = await request(app(), 'POST', '', {
      ...input,
      'unexpected-secret-marker': true,
    })
    expect(unknown.status).toBe(400)
    expect(JSON.stringify(await unknown.json())).not.toContain('unexpected-secret-marker')
  })
  it('requires mailbox fresh proof, creates a one-time challenge and challenges generation-bound verification', async () => {
    const a = app()
    const response = await request(a, 'POST', '', input)
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const challenge = (await response.json()) as { attemptId: string; proofMethods: string[] }
    expect(challenge.proofMethods).toEqual(['mailbox'])
    const cookie = response.headers.get('set-cookie')?.split(';')[0] as string
    const client = await owned.pool.connect()
    try {
      const attempt = (
        await client.query('SELECT * FROM sso_attempts WHERE id=$1', [challenge.attemptId])
      ).rows[0]
      await proveMailbox(client, attempt)
    } finally {
      client.release()
    }
    const done = await request(
      a,
      'POST',
      '',
      { ...input, proofAttemptId: challenge.attemptId },
      { cookie },
    )
    expect(done.status).toBe(201)
    expect(done.headers.get('cache-control')).toBe('no-store')
    const result = (await done.json()) as {
      domain: { id: string; generation: number }
      txtValue: string
    }
    expect(result).toMatchObject({
      domain: { name: 'example.com', generation: 1, status: 'pending' },
      txtName: '_hourmere-sso.example.com',
    })
    expect(result.txtValue.length).toBeGreaterThan(32)
    const verify = await request(
      a,
      'POST',
      `/${result.domain.id}/verify`,
      { expectedGeneration: 1 },
      { cookie },
    )
    expect(verify.status).toBe(403)
    const verifyChallenge = (await verify.json()) as { attemptId: string }
    const verifyCookie = verify.headers.get('set-cookie')?.split(';')[0] ?? cookie
    const proofClient = await owned.pool.connect()
    try {
      const attempt = (
        await proofClient.query('SELECT * FROM sso_attempts WHERE id=$1', [
          verifyChallenge.attemptId,
        ])
      ).rows[0]
      await proveMailbox(proofClient, attempt)
    } finally {
      proofClient.release()
    }
    txtRecords = [[result.txtValue]]
    const verified = await request(
      a,
      'POST',
      `/${result.domain.id}/verify`,
      {
        expectedGeneration: 1,
        proofAttemptId: verifyChallenge.attemptId,
      },
      { cookie: verifyCookie },
    )
    expect(verified.status).toBe(200)
    expect(await verified.json()).toMatchObject({
      domain: {
        id: result.domain.id,
        status: 'verified',
        generation: 1,
        verifiedAt: expect.any(String),
      },
    })
    const deletion = await request(a, 'DELETE', `/${result.domain.id}`, { expectedGeneration: 1 })
    expect(deletion.status).toBe(403)
    const deleteChallenge = (await deletion.json()) as { attemptId: string }
    const deleteCookie = deletion.headers.get('set-cookie')?.split(';')[0] as string
    const deleteClient = await owned.pool.connect()
    try {
      const attempt = (
        await deleteClient.query('SELECT * FROM sso_attempts WHERE id=$1', [
          deleteChallenge.attemptId,
        ])
      ).rows[0]
      await proveMailbox(deleteClient, attempt)
    } finally {
      deleteClient.release()
    }
    const deleted = await request(
      a,
      'DELETE',
      `/${result.domain.id}`,
      {
        expectedGeneration: 1,
        proofAttemptId: deleteChallenge.attemptId,
      },
      { cookie: deleteCookie },
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ deleted: true })
  })
  it('omits invalid secret keys, URL queries and unexpected failure details from diagnostics', async () => {
    const secret = 'synthetic-secret-diagnostic-marker'
    const logs = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
    ]
    try {
      const invalid = await request(app(), 'POST', `?${secret}`, { ...input, [secret]: true })
      expect(await invalid.json()).toEqual({ error: 'invalid_request' })
      const a = createApp({
        publicUrl,
        checkDb: async () => {},
        authHandler: async () => new Response(),
        resolveCaller: async () => {
          throw new Error(secret)
        },
        routes: [
          ssoDomainRoutes({
            db,
            capabilities: ON,
            publicUrl,
          }),
        ],
      })
      const failed = await request(a, 'POST', `?${secret}`, input)
      expect(failed.status).toBe(500)
      expect(
        JSON.stringify([await failed.json(), ...logs.map((log) => log.mock.calls)]),
      ).not.toContain(secret)
    } finally {
      for (const log of logs) log.mockRestore()
    }
  })
  it('keeps all operations Off before validation', async () => {
    for (const [method, path] of [
      ['POST', ''],
      ['POST', '/not-an-id/verify'],
      ['DELETE', '/not-an-id'],
    ]) {
      const response = await request(app(principal(), OFF), method as string, path as string, {
        unexpected: true,
      })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'sso_disabled' })
    }
  })
})
