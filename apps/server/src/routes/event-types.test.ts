import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { createTestTeam, createTestUser, type TestUser } from '@hourmere/scheduling/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHUNK_SIZE, chunkedBody } from '../chunked-body.ts'
import { EVENT_TYPE_BODY_LIMIT } from './event-types.ts'
import {
  closedObjects,
  createTestApp,
  escapedJson,
  openApiDocument,
  productApp,
  responseAndRequestStrictness,
  type TestApp,
} from './test-app.ts'

const serverUrl = process.env.DATABASE_URL

describe('event type routes in the OpenAPI document', () => {
  it('documents open responses and strict request bodies, down to locations and questions', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    const paths = ['/api/v1/event-types', '/api/v1/event-types/{id}']
    expect(responseAndRequestStrictness(doc, paths)).toEqual({
      closedResponses: [],
      openRequests: [],
    })
    for (const [path, method] of [
      ['/api/v1/event-types', 'post'],
      ['/api/v1/event-types/{id}', 'patch'],
    ] as const) {
      const schema = doc.paths[path]?.[method]?.requestBody?.content?.['application/json']?.schema
      if (!schema) throw new Error(`no request body for ${method} ${path}`)
      expect(closedObjects(doc, schema)).toEqual([
        '$',
        ...[0, 1, 2, 3, 4].map((i) => `$.location|oneOf${i}`),
        '$.conferenceOrganizer',
        '$.questions[]',
        '$.hosts[]',
      ])
    }
  })

  it('lists every route as authenticated', async () => {
    const { paths } = await openApiDocument(productApp({} as Db))
    expect(Object.keys(paths['/api/v1/event-types'] ?? {})).toEqual(['get', 'post'])
    expect(Object.keys(paths['/api/v1/event-types/{id}'] ?? {})).toEqual(['get', 'patch', 'delete'])
    for (const path of ['/api/v1/event-types', '/api/v1/event-types/{id}']) {
      for (const operation of Object.values(paths[path] ?? {})) {
        expect(operation.security).toEqual([{ apiKey: [] }, { session: [] }])
        expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['401', '429']))
      }
    }
    expect(Object.keys(paths['/api/v1/event-types']?.post?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '400', '403', '409']),
    )
  })

  it('documents both role denials on every session event-type write', async () => {
    const { paths } = await openApiDocument(productApp({} as Db))
    for (const [path, method] of [
      ['/api/v1/event-types', 'post'],
      ['/api/v1/event-types/{id}', 'patch'],
      ['/api/v1/event-types/{id}', 'delete'],
      ['/api/v1/event-types/{id}/round-robin/activate', 'post'],
    ] as const) {
      const forbidden = paths[path]?.[method]?.responses['403']
      expect(forbidden).toHaveProperty('description', expect.stringContaining('insufficient_role'))
      expect(forbidden).toHaveProperty(
        'description',
        expect.stringContaining('team_management_access_denied'),
      )
    }
  })

  it('refuses an unknown caller without reading its streamed body', async () => {
    const sent = chunkedBody(JSON.stringify({ slug: 'intro', description: 'x'.repeat(1_900_000) }))
    const res = await productApp({} as Db).request('/api/v1/event-types', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...sent.init,
    })
    expect(res.status).toBe(401)
    // Not the 1.9 MB that the route's 2 MB limit would let through.
    expect(sent.pulled()).toBeLessThanOrEqual(CHUNK_SIZE)
  })
})

describe.skipIf(!serverUrl)('event type routes', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp(serverUrl as string)
  })

  afterAll(async () => {
    await t?.drop()
  })

  const api = (user: TestUser) => t.as(user.principal)
  const body = (overrides: Record<string, unknown> = {}) => ({
    slug: 'intro',
    title: 'Intro call',
    durationMinutes: 30,
    ...overrides,
  })
  const idOf = (answer: { body: unknown }) => (answer.body as { id: string }).id

  it('assigns collective team hosts through REST and restricts the paged member directory', async () => {
    const owner = await createTestUser(t.db)
    const member = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const ownerApi = t.as(team.as(owner))
    const memberApi = t.as(team.as(member))
    const created = await ownerApi.post(
      '/api/v1/event-types',
      body({ schedulingType: 'collective', hosts: [{ userId: owner.id }, { userId: member.id }] }),
    )
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      schedulingType: 'collective',
      hosts: [expect.any(Object), expect.any(Object)],
      scheduleId: null,
    })
    expect((await memberApi.get('/api/v1/event-type-hosts')).status).toBe(403)
    const first = await ownerApi.get('/api/v1/event-type-hosts?limit=1')
    expect(first.status).toBe(200)
    const page = first.body as {
      data: { id: string; memberId: string; name: string }[]
      nextAfter: string
    }
    expect(page.data).toHaveLength(1)
    const membership = await t.db
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', team.id)
      .where('userId', '=', page.data[0]?.id as string)
      .executeTakeFirstOrThrow()
    expect(page.data[0]?.memberId).toBe(membership.id)
    expect(JSON.stringify(first.body)).not.toContain('@')
    expect(
      (await ownerApi.get(`/api/v1/event-type-hosts?limit=1&after=${page.nextAfter}`)).status,
    ).toBe(200)
    expect(
      (
        await memberApi.patch(`/api/v1/event-types/${idOf(created)}`, {
          hosts: [{ userId: member.id }],
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await ownerApi.patch(`/api/v1/event-types/${idOf(created)}`, {
          hosts: [{ userId: owner.id }, { userId: owner.id.toUpperCase() }],
        })
      ).body,
    ).toMatchObject({ error: 'invalid_hosts' })
    expect(
      (await ownerApi.patch(`/api/v1/event-types/${idOf(created)}`, { title: 'Updated interview' }))
        .body,
    ).toMatchObject({
      schedulingType: 'collective',
      hosts: (created.body as { hosts: unknown }).hosts,
    })
  })

  it('requires a caller', async () => {
    expect((await t.anonymous.get('/api/v1/event-types')).status).toBe(401)
    expect((await t.anonymous.post('/api/v1/event-types', body())).status).toBe(401)
  })

  it('creates, lists, reads, changes and deletes event types', async () => {
    const user = await createTestUser(t.db)
    const created = await api(user).post(
      '/api/v1/event-types',
      body({
        location: { kind: 'phone', number: '+14155550123' },
        questions: [{ id: 'company', label: 'Company', type: 'short_text' }],
      }),
    )
    expect(created.status).toBe(201)
    expect(created.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      organizationId: user.principal.organization.id,
      ownerUserId: user.id,
      slug: 'intro',
      title: 'Intro call',
      description: null,
      durationMinutes: 30,
      slotStepMinutes: null,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minimumNoticeMinutes: 0,
      bookingWindowDays: null,
      maxBookingsPerDay: null,
      schedulingType: 'individual',
      roundRobinActive: false,
      conferenceOrganizer: null,
      hosts: [{ userId: user.id }],
      location: { kind: 'phone', number: '+14155550123' },
      questions: [{ id: 'company', label: 'Company', type: 'short_text', required: false }],
      isActive: true,
      isHidden: false,
      allowGuests: false,
      position: 0,
      scheduleId: null,
      createdAt: expect.stringMatching(/Z$/),
      updatedAt: expect.stringMatching(/Z$/),
    })
    const id = idOf(created)
    expect(await api(user).get('/api/v1/event-types')).toEqual({
      status: 200,
      body: { data: [created.body] },
    })
    expect(await api(user).get(`/api/v1/event-types/${id}`)).toEqual({
      status: 200,
      body: created.body,
    })

    const changed = await api(user).patch(`/api/v1/event-types/${id}`, {
      title: 'Renamed',
      location: null,
      maxBookingsPerDay: 2,
    })
    expect(changed).toMatchObject({
      status: 200,
      body: { title: 'Renamed', location: null, maxBookingsPerDay: 2, slug: 'intro' },
    })

    expect(await api(user).delete(`/api/v1/event-types/${id}`)).toEqual({ status: 204, body: null })
    expect(await api(user).get(`/api/v1/event-types/${id}`)).toEqual({
      status: 404,
      body: { error: 'event_type_not_found' },
    })
    expect((await api(user).get('/api/v1/event-types')).body).toEqual({ data: [] })
  })

  it('answers 409 slug_taken for a slug used on the same page', async () => {
    const user = await createTestUser(t.db)
    await api(user).post('/api/v1/event-types', body())
    expect(await api(user).post('/api/v1/event-types', body())).toEqual({
      status: 409,
      body: {
        error: 'slug_taken',
        message: 'Another event type on this page already uses this slug',
      },
    })
  })

  it('defaults guest recipients off and persists explicit opt-in through REST', async () => {
    const user = await createTestUser(t.db)
    const created = await api(user).post('/api/v1/event-types', body())
    expect(created).toMatchObject({ status: 201, body: { allowGuests: false } })
    const id = idOf(created)
    expect(await api(user).patch(`/api/v1/event-types/${id}`, { allowGuests: true })).toMatchObject(
      { status: 200, body: { allowGuests: true } },
    )
    expect(
      (await api(user).patch(`/api/v1/event-types/${id}`, { title: 'Renamed' })).body,
    ).toMatchObject({ allowGuests: true })
    expect((await api(user).get(`/api/v1/event-types/${id}`)).body).toMatchObject({
      allowGuests: true,
    })
    for (const allowGuests of [null, 'true', 0, {}, []]) {
      expect((await api(user).patch(`/api/v1/event-types/${id}`, { allowGuests })).status).toBe(400)
      expect(
        (await api(user).post('/api/v1/event-types', body({ slug: 'bad', allowGuests }))).status,
      ).toBe(400)
    }
    expect(
      (await api(user).patch(`/api/v1/event-types/${id}`, { allowGuests: false })).body,
    ).toMatchObject({ allowGuests: false })
  })

  it('persists hidden state through REST reads and unrelated edits, and rejects invalid shapes', async () => {
    const user = await createTestUser(t.db)
    const created = await api(user).post('/api/v1/event-types', body({ isHidden: true }))
    expect(created).toMatchObject({ status: 201, body: { isHidden: true, isActive: true } })
    const id = idOf(created)
    expect(await api(user).get(`/api/v1/event-types/${id}`)).toEqual({
      status: 200,
      body: created.body,
    })
    expect(
      (await api(user).patch(`/api/v1/event-types/${id}`, { title: 'Still unlisted' })).body,
    ).toMatchObject({ isHidden: true })
    expect((await api(user).get('/api/v1/event-types')).body).toMatchObject({
      data: [{ id, isHidden: true }],
    })
    for (const isHidden of [null, 'true', 0, {}, []]) {
      expect((await api(user).patch(`/api/v1/event-types/${id}`, { isHidden })).status).toBe(400)
      expect(
        (await api(user).post('/api/v1/event-types', body({ slug: 'invalid', isHidden }))).status,
      ).toBe(400)
    }
    expect(
      (await api(user).patch(`/api/v1/event-types/${id}`, { isHidden: false })).body,
    ).toMatchObject({ isHidden: false })
  })

  it("answers 404 for another organization's event types", async () => {
    const [owner, other] = [await createTestUser(t.db), await createTestUser(t.db)]
    const id = idOf(await api(owner).post('/api/v1/event-types', body()))
    for (const res of [
      await api(other).get(`/api/v1/event-types/${id}`),
      await api(other).patch(`/api/v1/event-types/${id}`, { title: 'X' }),
      await api(other).delete(`/api/v1/event-types/${id}`),
      await api(owner).get('/api/v1/event-types/not-a-uuid'),
    ]) {
      expect(res).toEqual({ status: 404, body: { error: 'event_type_not_found' } })
    }
  })

  it('lets team members read and owners or admins write', async () => {
    const [admin, member] = [await createTestUser(t.db), await createTestUser(t.db)]
    const team = await createTestTeam(t.db, [
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const asAdmin = t.as(team.as(admin))
    const asMember = t.as(team.as(member))
    const created = await asAdmin.post('/api/v1/event-types', body({ slug: 'team-call' }))
    expect(created).toMatchObject({
      status: 201,
      body: { organizationId: team.id, ownerUserId: null },
    })
    const id = idOf(created)
    expect(await asMember.get(`/api/v1/event-types/${id}`)).toEqual({
      status: 200,
      body: created.body,
    })
    const refused = {
      status: 403,
      body: {
        error: 'insufficient_role',
        message: "Only the organization's owners and admins can manage its event types",
      },
    }
    expect(await asMember.post('/api/v1/event-types', body({ slug: 'mine' }))).toEqual(refused)
    expect(await asMember.patch(`/api/v1/event-types/${id}`, { title: 'X' })).toEqual(refused)
    expect(await asMember.delete(`/api/v1/event-types/${id}`)).toEqual(refused)
    expect((await asAdmin.delete(`/api/v1/event-types/${id}`)).status).toBe(204)
  })

  it("answers 400 invalid_schedule_id for a schedule that is not the host's", async () => {
    const [user, other] = [await createTestUser(t.db), await createTestUser(t.db)]
    const schedule = await api(other).post('/api/v1/schedules', {
      name: 'Theirs',
      timeZone: 'UTC',
      weeklyHours: {},
    })
    const res = await api(user).post('/api/v1/event-types', body({ scheduleId: idOf(schedule) }))
    expect(res).toEqual({
      status: 400,
      body: {
        error: 'invalid_schedule_id',
        message: "scheduleId must be one of the host's schedules",
      },
    })

    const own = await api(user).post('/api/v1/schedules', {
      name: 'Mine',
      timeZone: 'UTC',
      weeklyHours: {},
    })
    const ok = await api(user).post('/api/v1/event-types', body({ scheduleId: idOf(own) }))
    expect(ok).toMatchObject({ status: 201, body: { scheduleId: idOf(own) } })
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['a duration out of bounds', { durationMinutes: 0 }, 'invalid_event_type'],
    ['a notice beyond a year', { minimumNoticeMinutes: 525601 }, 'invalid_event_type'],
    ['a fractional duration', { durationMinutes: 1.5 }, 'invalid_request'],
    ['a malformed slug', { slug: 'Intro Call' }, 'invalid_slug'],
    [
      'a phone number not in E.164',
      { location: { kind: 'phone', number: '555-0123' } },
      'invalid_location',
    ],
    ['an unknown location kind', { location: { kind: 'skype' } }, 'invalid_request'],
    [
      'a select question without options',
      { questions: [{ id: 'q', label: 'Q', type: 'select' }] },
      'invalid_questions',
    ],
    [
      'an unknown question type',
      { questions: [{ id: 'q', label: 'Q', type: 'date' }] },
      'invalid_request',
    ],
    ['an unknown field', { color: 'blue' }, 'invalid_request'],
    ['a missing title', { title: undefined }, 'invalid_request'],
  ])('refuses %s with 400', async (_, change, error) => {
    const user = await createTestUser(t.db)
    const res = await api(user).post('/api/v1/event-types', body(change))
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ error, message: expect.any(String) })
  })

  it('names the offending rule and its bounds in the message', async () => {
    const user = await createTestUser(t.db)
    expect(await api(user).post('/api/v1/event-types', body({ bufferAfterMinutes: 1441 }))).toEqual(
      {
        status: 400,
        body: {
          error: 'invalid_event_type',
          message: 'bufferAfterMinutes must be a whole number from 0 to 1440, got 1441',
        },
      },
    )
  })

  it('accepts the largest legal event type, fully escaped, within its declared body limit', async () => {
    const user = await createTestUser(t.db)
    const pad = (text: string, length: number) => text.padEnd(length, 'x')
    const largest = {
      title: pad('T', 200),
      description: pad('D', 5000),
      location: { kind: 'link', url: `https://example.com/${'a'.repeat(1980)}` },
      questions: Array.from({ length: 20 }, (_, q) => ({
        id: pad(`q${q}_`, 64),
        label: pad(`Question ${q} `, 200),
        type: 'multi_select',
        required: false,
        options: Array.from({ length: 50 }, (_, o) => pad(`${q}-${o}-`, 200)),
      })),
    }
    const create = escapedJson({ ...body({ slug: pad('s', 64) }), ...largest })
    expect(create.length).toBeGreaterThan(1_200_000)
    expect(create.length).toBeLessThan(EVENT_TYPE_BODY_LIMIT)
    const created = await api(user).raw('POST', '/api/v1/event-types', create)
    expect(created.status).toBe(201)
    expect((created.body as { questions: unknown[] }).questions).toHaveLength(20)
    const changed = await api(user).raw(
      'PATCH',
      `/api/v1/event-types/${idOf(created)}`,
      escapedJson({ ...largest, title: pad('U', 200) }),
    )
    expect(changed.status).toBe(200)

    const tooLarge = JSON.stringify(body({ description: 'x'.repeat(EVENT_TYPE_BODY_LIMIT) }))
    expect(await api(user).raw('POST', '/api/v1/event-types', tooLarge)).toEqual({
      status: 413,
      body: { error: 'payload_too_large' },
    })
  })

  it('counts streamed bodies against the declared limit', async () => {
    const user = await createTestUser(t.db)
    const token = `hm_${randomUUID()}`
    const app = productApp(t.db, new Map([[token, user.principal]]))
    const send = (json: string, headers: Record<string, string> = {}) =>
      app.request('/api/v1/event-types', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...headers,
        },
        ...chunkedBody(json).init,
      })
    // Under the limit (padded with whitespace, which JSON ignores): handled as usual.
    const fits = JSON.stringify(body({ slug: 'streamed' })).padEnd(1_900_000, ' ')
    const created = await send(fits)
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ slug: 'streamed' })
    const tooLarge = JSON.stringify(body({ description: 'x'.repeat(EVENT_TYPE_BODY_LIMIT) }))
    const refused = await send(tooLarge)
    expect(refused.status).toBe(413)
    expect(await refused.json()).toEqual({ error: 'payload_too_large' })
    // A Content-Length smaller than the body does not get it past the limit.
    const lying = await send(tooLarge, { 'content-length': '100' })
    expect(lying.status).toBe(413)
    expect(await lying.json()).toEqual({ error: 'payload_too_large' })
  })
})
