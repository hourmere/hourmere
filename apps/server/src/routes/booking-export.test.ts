import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb, type Database, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { Kysely, PostgresDialect } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runTool } from '../mcp/tools.ts'
import { productRoutes, productTools } from '../server.ts'
import { openApiDocument, productApp, syntheticSessionCookie } from './test-app.ts'

const query = '?from=2026-01-01T00%3A00%3A00Z&to=2027-01-01T00%3A00%3A00Z'
const path = '/api/v1/bookings/export.csv'
describe('booking export OpenAPI', () => {
  it('publishes CSV download and authorization failures', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    const operation = doc.paths[path]?.get
    expect(operation?.responses['200']?.content?.['text/csv']).toBeTruthy()
    expect(operation?.responses['403']).toBeTruthy()
    expect(operation?.responses['409']).toBeTruthy()
    expect(operation?.responses['404']).toMatchObject({
      description: expect.stringContaining('routing_forms_disabled'),
    })
    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({
        name: 'includeRoutingAnswers',
        in: 'query',
        required: false,
        schema: expect.objectContaining({ type: 'string', enum: ['true', 'false'] }),
        description: expect.stringContaining('Requires routing forms to be enabled'),
      }),
    )
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
  const composed = (db: Db, routingFormsEnabled?: boolean) =>
    productApp(
      db,
      principals,
      productRoutes({
        db,
        socialProviders: {},
        invitationMailLimits: { secret: 'synthetic-route-test-only' },
        ...(routingFormsEnabled === undefined ? {} : { routingFormsEnabled }),
      }),
    )

  it('serves routing CSV through the existing REST route and MCP pointer only when enabled', async () => {
    const user = await createTestUser(db)
    const read = {
      ...user.principal,
      kind: 'api_key',
      apiKeyId: randomUUID(),
      apiKeyScope: 'read',
    } as const
    const full = { ...read, apiKeyScope: 'full' } as const
    const bookings = { ...read, apiKeyScope: 'bookings' } as const
    for (const principal of [read, full, bookings]) principals.set(principal.apiKeyScope, principal)
    await createFixtures(db).booking(
      user.principal.organization.id,
      [user.id],
      '2026-05-01T00:00:00Z',
      '2026-05-01T01:00:00Z',
    )

    const statements: string[] = []
    const observed = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: owned.pool }),
      log(event) {
        if (event.level === 'query') statements.push(event.query.sql)
      },
    })
    const off = composed(observed)
    const on = composed(observed, true)
    const headers = { authorization: 'Bearer read' }
    const args = { from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }
    const disabled = await off.request(`${path}${query}&includeRoutingAnswers=true`, { headers })
    expect(disabled.status).toBe(404)
    expect(await disabled.json()).toEqual({ error: 'routing_forms_disabled' })
    expect(statements).toEqual([])

    const ordinary = await off.request(path + query, { headers })
    expect(ordinary.status).toBe(200)
    const bytes = new Uint8Array(await ordinary.arrayBuffer())
    const ordinaryStatements = statements.splice(0)
    expect(ordinaryStatements).not.toEqual([])
    expect(ordinaryStatements.join('\n')).not.toContain('booking_routing')
    const omitted = await off.request(`${path}${query}&includeRoutingAnswers=false`, { headers })
    expect(omitted.status).toBe(200)
    expect(new Uint8Array(await omitted.arrayBuffer())).toEqual(bytes)
    expect(statements.splice(0)).toEqual(ordinaryStatements)

    const tool = (routingFormsEnabled?: true) => {
      const found = productTools({ db: observed, routingFormsEnabled }).find(
        (item) => item.name === 'export_bookings',
      )
      if (!found) throw new Error('Missing export_bookings')
      return found
    }
    const call = (caller: typeof read | typeof bookings | typeof full = read) => ({
      caller,
      rateLimit() {},
    })
    const offResult = await runTool(
      tool(),
      { ...args, includeRoutingAnswers: true },
      call(),
      () => {},
    )
    expect(offResult).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: '{"error":"routing_forms_disabled"}' }],
    })
    expect(statements).toEqual([])
    const pointer = await runTool(
      tool(true),
      { ...args, includeRoutingAnswers: true },
      call(full),
      () => {},
    )
    expect(pointer.isError).not.toBe(true)
    const { downloadPath } = pointer.structuredContent as { downloadPath: string }
    expect(downloadPath).toContain('includeRoutingAnswers=true')

    for (const scope of ['read', 'full']) {
      const response = await on.request(downloadPath, {
        headers: { authorization: `Bearer ${scope}` },
      })
      expect(response.status).toBe(200)
      const [header, row] = (await response.text()).split('\r\n')
      expect(header).toMatch(
        /,routing_form_id,routing_form_version,routing_matched_rule_id,routing_resolved_rule_id,routing_answers$/,
      )
      expect(row).toMatch(/,,,,,$/)
    }
    const denied = await on.request(downloadPath, { headers: { authorization: 'Bearer bookings' } })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: 'insufficient_scope' })
    const deniedTool = await runTool(
      tool(true),
      { ...args, includeRoutingAnswers: true },
      call(bookings),
      () => {},
    )
    expect(deniedTool).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('insufficient_scope') }],
    })
  })
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
  it('permits only verified browser team administrators and preserves the team field boundary', async () => {
    const owner = await createTestUser(db),
      admin = await createTestUser(db),
      member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const id = await createFixtures(db).booking(
      team.id,
      [member.id],
      '2026-05-01T00:00:00Z',
      '2026-05-01T01:00:00Z',
    )
    await db
      .updateTable('bookings')
      .set({ title: 'PRIVATE_TITLE', responses: JSON.stringify({ q: 'PRIVATE_ANSWER' }) })
      .where('id', '=', id)
      .execute()
    for (const [label, user] of [
      ['owner', owner],
      ['admin', admin],
      ['member', member],
    ] as const) {
      const row = await db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token: randomUUID(),
          activeOrganizationId: team.id,
          expiresAt: new Date(Date.now() + 3_600_000),
          updatedAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      principals.set(`team-${label}`, { ...team.as(user), kind: 'session', sessionId: row.id })
      const response = await app.request(path + query, {
        headers: { cookie: syntheticSessionCookie(`team-${label}`) },
      })
      expect(response.status).toBe(label === 'member' ? 403 : 200)
      const body = await response.text()
      if (label !== 'member') {
        expect(body).toContain(id)
        expect(body).not.toMatch(/PRIVATE_|answers|location_option|source|created_at/)
        expect(body).not.toContain(member.email)

        const browser = { cookie: syntheticSessionCookie(`team-${label}`) }
        const omitted = await app.request(`${path}${query}&includeRoutingAnswers=false`, {
          headers: browser,
        })
        expect(omitted.status).toBe(200)
        expect(await omitted.text()).toBe(body)
        const optInPath = `${path}${query}&includeRoutingAnswers=true`
        const off = await app.request(optInPath, { headers: browser })
        expect(off.status).toBe(404)
        expect(await off.json()).toEqual({ error: 'routing_forms_disabled' })
        const on = await composed(db, true).request(optInPath, { headers: browser })
        expect(on.status).toBe(400)
        expect(await on.json()).toMatchObject({ error: 'invalid_request' })
      } else expect(JSON.parse(body).error).toBe('team_management_access_denied')
      for (const scope of ['read', 'full'] as const) {
        principals.set(`team-${label}-${scope}`, {
          ...team.as(user),
          kind: 'api_key',
          apiKeyId: randomUUID(),
          apiKeyScope: scope,
        })
        const denied = await get(`team-${label}-${scope}`)
        expect(denied.status).toBe(403)
        expect(await denied.json()).toMatchObject({ error: 'team_management_access_denied' })
      }
    }
    principals.set('uuid-owner', owner.principal)
    const invalid = await get('uuid-owner', `${query}&hostUserId=bad`)
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: 'invalid_request' })
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
      `${query}&includeRoutingAnswers=yes`,
      `${query}&timeZone=invalid`,
      `${query}&extra=1`,
      query.replace('2027-01-01', '2028-01-01'),
    ])
      expect((await get('user', suffix)).status).toBe(400)
  })
})
