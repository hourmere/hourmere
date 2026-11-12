import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import * as Branding from '@hourmere/scheduling'
import { createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as OpenApi from '../openapi.ts'
import * as Team from '../team-management.ts'
import type { brandingRoutes } from './branding.ts'
import {
  openApiDocument,
  productApp,
  responseAndRequestStrictness,
  syntheticSessionCookie,
} from './test-app.ts'

describe('branding OpenAPI', () => {
  it('keeps response objects open and requests strict', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    expect(
      responseAndRequestStrictness(doc, [
        '/api/v1/branding',
        '/api/v1/branding/logo',
        '/api/v1/branding/logo/{hash}',
      ]),
    ).toEqual({ closedResponses: [], openRequests: [] })
  })
})
describe.skipIf(!process.env.DATABASE_URL)('branding REST', () => {
  let owned: TestDatabase
  let db: Db
  const principals = new Map<string, Principal>()
  let app: ReturnType<typeof productApp>
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    app = productApp(db, principals)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  const token = (principal: Principal) => {
    const key = randomUUID()
    principals.set(key, principal)
    return key
  }
  it('limits raw uploads and serves only normalized images with safe headers', async () => {
    const user = await createTestUser(db),
      key = token(user.principal),
      headers = { authorization: `Bearer ${key}`, 'content-type': 'image/png' }
    expect((await app.request('/api/v1/branding')).status).toBe(401)
    const oversized = await app.request('/api/v1/branding/logo', {
      method: 'POST',
      headers,
      body: new Uint8Array(524289),
    })
    expect(oversized.status).toBe(413)
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
      .png()
      .toBuffer()
    for (const [body, contentType] of [
      [bytes, 'image/jpeg'],
      [Buffer.from('<html>hello</html>'), 'image/png'],
      [Buffer.from('<svg/>'), 'image/svg+xml'],
    ] as const) {
      const response = await app.request('/api/v1/branding/logo', {
        method: 'POST',
        headers: { ...headers, 'content-type': contentType },
        body: new Uint8Array(body),
      })
      expect(response.status).toBe(400)
    }
    const uploaded = await app.request('/api/v1/branding/logo', {
      method: 'POST',
      headers,
      body: new Uint8Array(Buffer.concat([bytes, Buffer.from('<script>bad()</script>')])),
    })
    expect(uploaded.status).toBe(200)
    const view = (await uploaded.json()) as { brandLogo: string }
    // Refused uploads record nothing; the accepted one is attributed to the exact key.
    expect(
      await db
        .selectFrom('audit_events')
        .select(['action', 'actor_type', 'credential_id', 'details', 'request_id'])
        .where('organization_id', '=', user.principal.organization.id)
        .execute(),
    ).toEqual([
      {
        action: 'organization.branding_updated',
        actor_type: 'api_key',
        credential_id: user.principal.kind === 'api_key' ? user.principal.apiKeyId : '',
        details: { logo: 'uploaded' },
        request_id: expect.any(String),
      },
    ])
    const result = await app.request(`/api/v1/branding/logo/${view.brandLogo}`, { headers })
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toBe('image/png')
    expect(result.headers.get('x-content-type-options')).toBe('nosniff')
    expect(result.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(result.headers.get('cache-control')).toBe('private, no-store')
    expect(Buffer.from(await result.arrayBuffer()).includes(Buffer.from('<script>'))).toBe(false)
    const other = await createTestUser(db)
    expect(
      (
        await app.request(`/api/v1/branding/logo/${view.brandLogo}`, {
          headers: { authorization: `Bearer ${token(other.principal)}` },
        })
      ).status,
    ).toBe(404)
  })
  it('enforces chunked limits and kills copied HTTP limit and CSP regressions', async () => {
    const user = await createTestUser(db),
      key = token(user.principal)
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'image/png' }
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .png()
      .toBuffer()
    const view = await Branding.uploadBrandLogo(
      { db, principal: user.principal, now: () => Temporal.Now.instant() },
      bytes,
      'image/png',
    )
    const source = readFileSync(new URL('./branding.ts', import.meta.url), 'utf8')
    const copy = (before?: string, after?: string) => {
      if (before) expect(source).toContain(before)
      const body = stripTypeScriptTypes(
        (before ? source.replace(before, after ?? '') : source).replace(
          /^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm,
          '',
        ),
      ).replace(/\bexport /g, '')
      const bindings = { createRoute, z, ...Branding, ...OpenApi, ...Team }
      return new Function(...Object.keys(bindings), `${body};return brandingRoutes`)(
        ...Object.values(bindings),
      ) as typeof brandingRoutes
    }
    const verify = async (factory: typeof brandingRoutes, kind: string) => {
      const application = productApp(db, principals, [factory({ db })])
      if (kind === 'csp') {
        const response = await application.request(`/api/v1/branding/logo/${view.brandLogo}`, {
          headers,
        })
        expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
      } else {
        const response = await application.request('/api/v1/branding/logo', {
          method: 'POST',
          headers,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(300000))
              controller.enqueue(new Uint8Array(300000))
              controller.close()
            },
          }),
          duplex: 'half',
        } as RequestInit)
        expect(response.status).toBe(413)
      }
    }
    for (const [kind, before, after] of [
      ['csp', `"default-src 'none'; sandbox"`, `"default-src 'self'"`],
      [
        'limit',
        'callerWithBodyLimit(caller, BRAND_LOGO_MAX_BYTES)',
        'callerWithBodyLimit(caller, 2 * BRAND_LOGO_MAX_BYTES)',
      ],
    ] as const) {
      await verify(copy(), kind)
      await expect(verify(copy(before, after), kind)).rejects.toMatchObject({
        name: 'AssertionError',
      })
      await verify(copy(), kind)
    }
  })
  it('requires session write context and rejects stale organization or unauthorized roles', async () => {
    const user = await createTestUser(db),
      member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const sessionId = randomUUID(),
      sessionToken = randomUUID()
    await db
      .insertInto('auth.session')
      .values({
        id: sessionId,
        token: sessionToken,
        userId: user.id,
        expiresAt: new Date(Date.now() + 3600000),
        updatedAt: new Date(),
        activeOrganizationId: team.id,
      })
      .execute()
    const principal: Principal = {
      kind: 'session',
      sessionId,
      user: user.principal.user,
      organization: team.as(user).organization,
    }
    const key = token(principal)
    const headers = {
      cookie: syntheticSessionCookie(key),
      origin: 'http://localhost:3000',
      'content-type': 'application/json',
    }
    const patch = (extra: Record<string, string> = {}) =>
      app.request('/api/v1/branding', {
        method: 'PATCH',
        headers: { ...headers, ...extra },
        body: JSON.stringify({ brandPrimaryColor: '#123456' }),
      })
    expect((await patch()).status).toBe(409)
    expect((await patch({ 'x-expected-organization-id': team.id })).status).toBe(200)
    expect(
      (await patch({ 'x-expected-organization-id': user.principal.organization.id })).status,
    ).toBe(409)
    const response = await app.request('/api/v1/branding', {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${token(team.as(member))}`,
        'content-type': 'application/json',
      },
      body: '{}',
    })
    expect(response.status).toBe(403)
  })
})
