import type { Db } from '@hourmere/db'
import { createTestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createTestApp,
  openApiDocument,
  PUBLIC_URL,
  productApp,
  responseAndRequestStrictness,
  type TestApp,
} from './test-app.ts'

const serverUrl = process.env.DATABASE_URL

describe('profile routes in the OpenAPI document', () => {
  it('documents open responses and strict request bodies', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    expect(responseAndRequestStrictness(doc, ['/api/v1/profile'])).toEqual({
      closedResponses: [],
      openRequests: [],
    })
  })

  it('lists every route as authenticated, with its error responses', async () => {
    const { paths } = await openApiDocument(productApp({} as Db))
    expect(Object.keys(paths['/api/v1/profile'] ?? {})).toEqual(['get', 'put'])
    for (const operation of Object.values(paths['/api/v1/profile'] ?? {})) {
      expect(operation.security).toEqual([{ apiKey: [] }, { session: [] }])
      expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['401', '429']))
    }
    expect(Object.keys(paths['/api/v1/profile']?.put?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '201', '400', '409']),
    )
  })
})

describe.skipIf(!serverUrl)('profile routes', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp(serverUrl as string)
  })

  afterAll(async () => {
    await t?.drop()
  })

  const valid = { handle: 'ada', timeZone: 'europe/berlin', locale: 'en-gb' }

  it('requires a caller', async () => {
    expect(await t.anonymous.get('/api/v1/profile')).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    })
    expect((await t.anonymous.put('/api/v1/profile', valid)).status).toBe(401)
  })

  it('answers 404 before onboarding, 201 on creation and 200 on replacement', async () => {
    const user = await createTestUser(t.db)
    const api = t.as(user.principal)
    expect(await api.get('/api/v1/profile')).toEqual({
      status: 404,
      body: { error: 'profile_not_found', message: 'Create a profile with PUT /api/v1/profile' },
    })

    const created = await api.put('/api/v1/profile', valid)
    expect(created.status).toBe(201)
    expect(created.body).toEqual({
      handle: 'ada',
      timeZone: 'Europe/Berlin',
      locale: 'en-GB',
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      updatedAt: expect.stringMatching(/Z$/),
    })
    expect(await api.get('/api/v1/profile')).toEqual({ status: 200, body: created.body })

    const replaced = await api.put('/api/v1/profile', { ...valid, handle: 'ada-l' })
    expect(replaced.status).toBe(200)
    expect(replaced.body).toMatchObject({ handle: 'ada-l' })
  })

  it.each<[string, Record<string, unknown>, number, string]>([
    ['a reserved handle', { handle: 'admin' }, 400, 'handle_reserved'],
    ['a reserved handle in capitals', { handle: 'SIGN-IN' }, 400, 'handle_reserved'],
    ["the web app's booking page", { handle: 'booking' }, 400, 'handle_reserved'],
    ["one of the app's top-level pages", { handle: 'event-types' }, 400, 'handle_reserved'],
    ['a static file at the root', { handle: 'robots.txt' }, 400, 'handle_reserved'],
    ['a malformed handle', { handle: 'Ada!' }, 400, 'invalid_handle'],
    ['an unknown time zone', { timeZone: 'Mars/Olympus' }, 400, 'invalid_time_zone'],
    ['a malformed locale', { locale: 'en_US' }, 400, 'invalid_locale'],
    ['a missing field', { locale: undefined }, 400, 'invalid_request'],
    ['a field of the wrong type', { handle: 42 }, 400, 'invalid_request'],
    ['an unknown field', { nickname: 'x' }, 400, 'invalid_request'],
  ])('refuses %s', async (_, change, status, error) => {
    const user = await createTestUser(t.db)
    const res = await t
      .as(user.principal)
      .put('/api/v1/profile', { ...valid, handle: `h-${user.id.slice(0, 8)}`, ...change })
    expect(res.status).toBe(status)
    expect(res.body).toMatchObject({ error })
  })

  it('keeps the default 64 KB body limit', async () => {
    const user = await createTestUser(t.db)
    const res = await t
      .as(user.principal)
      .put('/api/v1/profile', { ...valid, locale: 'x'.repeat(64 * 1024) })
    expect(res).toEqual({ status: 413, body: { error: 'payload_too_large' } })
  })

  it('answers 409 handle_taken for a handle another user has', async () => {
    const [a, b] = [await createTestUser(t.db), await createTestUser(t.db)]
    expect(
      (await t.as(a.principal).put('/api/v1/profile', { ...valid, handle: 'taken' })).status,
    ).toBe(201)
    expect(await t.as(b.principal).put('/api/v1/profile', { ...valid, handle: 'taken' })).toEqual({
      status: 409,
      body: { error: 'handle_taken', message: 'This handle is already taken' },
    })
  })

  it('refuses cookie-authenticated writes from another origin', async () => {
    const user = await createTestUser(t.db)
    const session = { ...user.principal, kind: 'session' as const, sessionId: 'session-1' }
    const foreign = await t.as(session, { origin: 'https://evil.example' }).put('/api/v1/profile', {
      ...valid,
      handle: 'cookie-user',
    })
    expect(foreign.status).toBe(403)
    expect(foreign.body).toMatchObject({ error: 'forbidden' })
    const own = await t.as(session, { origin: PUBLIC_URL }).put('/api/v1/profile', {
      ...valid,
      handle: 'cookie-user',
    })
    expect(own.status).toBe(201)
  })
})
