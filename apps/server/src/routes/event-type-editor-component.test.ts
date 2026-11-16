import { createFixtures, createTestUser } from '@hourmere/scheduling/testing'

const testingLibraryModule = '@testing-library/react'
const { cleanup, waitFor } = await import(testingLibraryModule)

const userEventModule = '@testing-library/user-event'
const { default: userEvent } = await import(userEventModule)

import type { EventType } from '@hourmere/scheduling'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'

const languageModule = '../../../web/src/i18n/store.ts'
const { chooseLanguage } = await import(languageModule)
const fakeApiModule = '../../../web/src/test/fake-api.tsx'
const { fakeApi, json, ME, profile, renderApp, signedInAs } = await import(fakeApiModule)

// Keep the server modules in Vitest's Node transform pipeline while mounting React
// in a synthetic DOM. jsdom's browser pipeline rewrites import.meta.url in DB loaders.
const dom = await vi.hoisted(async () => {
  vi.resetModules()
  const jsdomModule = 'jsdom'
  const { JSDOM } = await import(jsdomModule)
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost:3000',
    pretendToBeVisual: true,
  })
  for (const name of [
    'window',
    'document',
    'navigator',
    'location',
    'localStorage',
    'HTMLElement',
    'HTMLAnchorElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'HTMLTextAreaElement',
    'HTMLDetailsElement',
    'Node',
    'Event',
    'MouseEvent',
    'MutationObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ] as const) {
    vi.stubGlobal(name, dom.window[name])
  }
  return dom
})

afterAll(() => {
  cleanup()
  vi.unstubAllGlobals()
  dom.window.close()
})

// Only session/frame discovery is scripted. The editor's GET/PATCH use the product
// REST routes and a disposable Postgres database, without starting a browser/server.
describe.skipIf(!process.env.DATABASE_URL)('React editor REST persistence', () => {
  let app: TestApp
  beforeAll(async () => {
    app = await createTestApp(process.env.DATABASE_URL as string)
  })
  afterAll(async () => {
    await app?.drop()
  })

  it('retains saved booking rules and named locations after a title-only component save', async () => {
    chooseLanguage('en')
    const owner = await createTestUser(app.db)
    const client = app.as(owner.principal)
    const scheduleId = await createFixtures(app.db).schedule(owner.id)
    const created = await client.post('/api/v1/event-types', {
      title: 'Original consultation',
      slug: 'original-consultation',
      durationMinutes: 45,
      allowedDurationsMinutes: [30, 45, 60],
      scheduleId,
      bufferAfterMinutes: 20,
      minimumNoticeMinutes: 180,
      allowGuests: true,
      locations: [
        { id: 'call', kind: 'phone', askInvitee: true, label: 'Call me', isDefault: true },
        { id: 'office', kind: 'in_person', address: '1 Main Street', label: 'Office' },
      ],
    })
    expect(created.status).toBe(201)
    const event = created.body as EventType
    const before = await app.db
      .selectFrom('event_types')
      .selectAll()
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow()
    const api = fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': async () => {
        const response = await client.get('/api/v1/schedules')
        return json(response.status, response.body)
      },
      [`GET /api/v1/event-types/${event.id}`]: async () => {
        const response = await client.get(`/api/v1/event-types/${event.id}`)
        return json(response.status, response.body)
      },
      [`PATCH /api/v1/event-types/${event.id}`]: async ({ body }: { body: unknown }) => {
        const response = await client.patch(`/api/v1/event-types/${event.id}`, body)
        expect(response.status).toBe(200)
        return json(response.status, response.body)
      },
    })
    const user = userEvent.setup()
    const view = renderApp(`/app/event-types/${event.id}`)
    const title = await view.findByLabelText('Title', { exact: true }, { timeout: 5000 })
    await user.clear(title)
    await user.type(title, 'Renamed consultation')
    await user.click(view.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.to(`PATCH /api/v1/event-types/${event.id}`)).toHaveLength(1))
    await waitFor(async () => {
      const stored = await client.get(`/api/v1/event-types/${event.id}`)
      expect(stored.status).toBe(200)
      expect(stored.body).toEqual({
        ...event,
        title: 'Renamed consultation',
        updatedAt: expect.any(String),
      })
    })
    const after = await app.db
      .selectFrom('event_types')
      .selectAll()
      .where('id', '=', event.id)
      .executeTakeFirstOrThrow()
    expect({ ...after, title: before.title, updated_at: before.updated_at }).toEqual(before)
  })
})
