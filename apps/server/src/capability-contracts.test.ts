import { readFile } from 'node:fs/promises'
import { createDb, createPool } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { CROSS_ORIGIN_WRITE } from './openapi.ts'
import { openApiDocument } from './openapi-document.ts'
import { productTools } from './server.ts'

const rootFile = (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'
interface Operation {
  security?: Record<string, string[]>[]
  responses: Record<string, { description?: string }>
}
type Paths = Record<string, Partial<Record<Method, Operation>>>

describe('REST and MCP capability contract', () => {
  it.each<[Method, string]>([
    ['patch', '/api/v1/calendars/{id}'],
    ['post', '/api/v1/calendars/{id}/sync'],
    ['put', '/api/v1/calendar-destination'],
    ['post', '/api/v1/calendar-connections/{id}/refresh'],
  ])('documents both cookie-write 403 cases for %s %s', async (method, path) => {
    const { paths } = (await openApiDocument()) as { paths: Paths }
    const description = paths[path]?.[method]?.responses['403']?.description
    expect(description).toContain(CROSS_ORIGIN_WRITE)
    expect(description).toContain('session_required')
  })

  it('gives every registered MCP mutation an existing public REST mutation', async () => {
    // Use the same registry as the running server, without connecting to a database.
    const db = createDb(createPool('postgres://synthetic@127.0.0.1:9/parity-contract'))
    try {
      const tools = productTools({ db })
      const mutations = tools.filter((tool) => !tool.annotations.readOnlyHint)
      const equivalents: Record<string, [Method, string][]> = {
        create_booking: [
          ['post', '/api/v1/public/{handle}/{slug}/bookings'],
          ['post', '/api/v1/public/teams/{handle}/{slug}/bookings'],
        ],
        // The current REST equivalent is the invitee-token mode. The missing host-ID
        // reschedule route is a separate follow-up; this guard covers tools, not modes.
        reschedule_booking: [['post', '/api/v1/bookings/manage/reschedule']],
        cancel_booking: [
          ['post', '/api/v1/bookings/manage/cancel'],
          ['post', '/api/v1/bookings/{id}/cancel'],
        ],
        retry_conference: [['post', '/api/v1/bookings/{id}/conference/retry']],
        retry_calendar_copy: [['post', '/api/v1/bookings/{id}/calendar-copy/retry']],
      }
      expect(mutations.map((tool) => tool.name).sort()).toEqual(Object.keys(equivalents).sort())
      const { paths } = (await openApiDocument()) as { paths: Paths }
      for (const tool of mutations) {
        for (const [method, path] of equivalents[tool.name] ?? []) {
          expect(method, tool.name).not.toBe('get')
          const operation = paths[path]?.[method]
          expect(operation, `${tool.name} must have REST ${method.toUpperCase()} ${path}`).toEqual(
            expect.any(Object),
          )
          expect(Object.keys(operation?.responses ?? {}), `${tool.name} REST success`).toEqual(
            expect.arrayContaining([expect.stringMatching(/^2\d\d$/)]),
          )
        }
      }
    } finally {
      await db.destroy()
    }
  })

  it('documents API-key access to settings and browser consent for credential operations', async () => {
    const { paths } = (await openApiDocument()) as { paths: Paths }
    const settings: [Method, string][] = [
      ['get', '/api/v1/calendar-connections'],
      ['get', '/api/v1/conference-connections'],
      ['patch', '/api/v1/calendars/{id}'],
      ['post', '/api/v1/calendars/{id}/sync'],
      ['put', '/api/v1/calendar-destination'],
      ['post', '/api/v1/calendar-connections/{id}/refresh'],
      ['post', '/api/v1/event-types'],
      ['patch', '/api/v1/event-types/{id}'],
    ]
    for (const [method, path] of settings) {
      expect(paths[path]?.[method]?.security ?? [], `${method} ${path}`).toContainEqual({
        apiKey: [],
      })
    }
    const credentials: [Method, string][] = [
      ['post', '/api/v1/calendar-connections/google/authorize'],
      ['post', '/api/v1/calendar-connections/microsoft/authorize'],
      ['delete', '/api/v1/calendar-connections/{id}'],
      ['post', '/api/v1/conference-connections/zoom/authorize'],
      ['post', '/api/v1/conference-connections/zoom/authorize-meetings'],
      ['post', '/api/v1/conference-connections/{id}/authorize-meetings'],
      ['post', '/api/v1/conference-connections/{id}/reconnect'],
      ['post', '/api/v1/conference-connections/{id}/refresh'],
      ['delete', '/api/v1/conference-connections/{id}'],
    ]
    for (const [method, path] of credentials) {
      expect(paths[path]?.[method]?.security, `${method} ${path}`).toEqual([{ session: [] }])
    }
  })
})

describe('repository and website capability documentation', () => {
  it.each(['docs/mcp.md', 'docs/cli.md', 'tools/cli/README.md'])(
    '%s explains host reschedule links and their visibility boundary',
    async (path) => {
      const doc = (await rootFile(path)).replace(/\s+/g, ' ')
      for (const statement of [
        /optional `rescheduledToId`.*immediate successor/,
        /same organization that the caller also hosts/,
        /null when none is available/,
        /outside the current page or filters/,
        /Public\/manage responses omit it/,
        /predecessor's `status` remains `cancelled`/,
        /`rescheduledFromId`/,
      ]) {
        expect(statement.test(doc), `${path} must describe ${statement}`).toBe(true)
      }
    },
  )

  it.each(['docs/mcp.md', 'apps/site/src/content/docs/docs/mcp.md'])(
    '%s describes optional MCP OAuth without contradicting API-key or cookie authentication',
    async (path) => {
      const doc = (await rootFile(path)).replace(/\s+/g, ' ')
      for (const statement of [
        /MCP_OAUTH_ENABLED=true/,
        /default is `false`/i,
        /API keys keep working/i,
        /Session cookies never authenticate MCP/i,
      ]) {
        expect(statement.test(doc), `${path} must describe ${statement}`).toBe(true)
      }
      expect(
        /no OAuth 2\.1 connector flow|OAuth-only client cannot connect|API keys only, never session/i.test(
          doc,
        ),
        `${path} must not deny available OAuth authentication`,
      ).toBe(false)
    },
  )

  it.each(['docs/mcp.md', 'apps/site/src/content/docs/docs/mcp.md'])(
    '%s describes the same integration ownership and consent boundaries',
    async (path) => {
      const doc = (await rootFile(path)).replace(/\s+/g, ' ')
      for (const statement of [
        /`list_calendar_connections`/,
        /`list_conference_connections`/,
        /API keys and enabled MCP OAuth grants/,
        /user's own API keys can change calendar conflict selection, the writeback destination, refresh the calendar list and sync now through REST/,
        /select their own meeting-mode Zoom connection on event types they actually host/,
        /same organization.*(?:permissions|ownership checks)/,
        /OAuth authorization, code exchange and disconnect require a live browser session/,
        /explicit Zoom credential refresh remains session-only/i,
        /MCP OAuth grants do not authenticate REST requests/,
      ]) {
        expect(statement.test(doc), `${path} must describe ${statement}`).toBe(true)
      }
    },
  )
})
