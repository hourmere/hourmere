import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openApiDocument, productApp, syntheticSessionCookie } from './test-app.ts'

const query = '?from=2026-01-01T00%3A00%3A00Z&to=2027-01-01T00%3A00%3A00Z'
const path = '/api/v1/bookings/export.csv'
describe('booking export OpenAPI', () => {
  it('publishes CSV download and authorization failures', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    expect(doc.paths[path]?.get?.responses['200']?.content?.['text/csv']).toBeTruthy()
    expect(doc.paths[path]?.get?.responses['403']).toBeTruthy()
    expect(doc.paths[path]?.get?.responses['409']).toBeTruthy()
  })
})
describe.skipIf(!process.env.DATABASE_URL)('booking export REST', () => {
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
  const get = (token: string, suffix = query) =>
    app.request(path + suffix, { headers: { authorization: `Bearer ${token}` } })
  it('sets private download headers and optional UTF-8 BOM and enforces scope', async () => {
    const user = await createTestUser(db)
    for (const scope of ['full', 'read', 'bookings'] as const)
      principals.set(scope, {
        ...user.principal,
        kind: 'api_key',
        apiKeyId: 'test',
        apiKeyScope: scope,
      })
    await createFixtures(db).booking(
      user.principal.organization.id,
      [user.id],
      '2026-05-01T00:00:00Z',
      '2026-05-01T01:00:00Z',
    )
    for (const token of ['full', 'read']) {
      const response = await get(token, `${query}&bom=true`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
      expect(response.headers.get('content-disposition')).toContain(
        'attachment; filename="bookings.csv"',
      )
      expect(response.headers.get('cache-control')).toBe('no-store')
      const bytes = new Uint8Array(await response.arrayBuffer())
      expect([...bytes.slice(0, 3)]).toEqual([239, 187, 191])
      expect(new TextDecoder().decode(bytes)).not.toMatch(/manage_token|hash|credential/)
    }
    const plain = await get('full')
    expect(new Uint8Array(await plain.arrayBuffer())[0]).toBe(105)
    expect((await get('bookings')).status).toBe(403)
    expect((await app.request(path + query)).status).toBe(401)
  })
  it('binds browser downloads to their space and releases a locked HTTP body on abort', async () => {
    const user = await createTestUser(db)
    principals.set('browser', {
      user: user.principal.user,
      organization: user.principal.organization,
      kind: 'session',
      sessionId: randomUUID(),
    })
    const headers = { cookie: syntheticSessionCookie('browser') }
    const other = await createTestUser(db)
    const denied = await app.request(
      `${path}${query}&expectedOrganizationId=${other.principal.organization.id}`,
      { headers },
    )
    expect(denied.status).toBe(409)
    const abort = new AbortController()
    const response = await app.request(
      `${path}${query}&expectedOrganizationId=${user.principal.organization.id}`,
      { headers, signal: abort.signal },
    )
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    await reader?.read()
    abort.abort()
    await expect(reader?.read()).rejects.toThrow('aborted')
    await vi.waitFor(async () => {
      const retry = await app.request(path + query, { headers })
      if (retry.status !== 200) {
        await retry.text()
        expect(retry.status).toBe(200)
      }
      await retry.body?.cancel()
    })
  })
  it('rejects team members, stale spaces and invalid filters before sending CSV', async () => {
    const user = await createTestUser(db)
    principals.set('user', user.principal)
    const team = await createTestTeam(db, [{ user, role: 'member' }])
    principals.set('member', team.as(user))
    expect((await get('member')).status).toBe(403)
    expect((await get('user', `${query}&expectedOrganizationId=${team.id}`)).status).toBe(409)
    for (const suffix of [
      '',
      `${query}&bom=yes`,
      `${query}&timeZone=invalid`,
      `${query}&extra=1`,
      query.replace('2027-01-01', '2028-01-01'),
    ])
      expect((await get('user', suffix)).status).toBe(400)
  })
})
