import { API_KEY_REST_OPERATIONS } from '@hourmere/auth'
import { WEBHOOK_EVENTS } from '@hourmere/webhooks'
import { describe, expect, it } from 'vitest'
import { openApiDocument, openApiRouteInventory } from './openapi-document.ts'

it('attaches the team proof middleware to every private team read in the server inventory', async () => {
  const { routes, teamReadRoutes } = await openApiRouteInventory()
  const honoId = (id: string) => id.replace(/\{(\w+)\}/g, ':$1')
  const excluded = new Set([
    ...API_KEY_REST_OPERATIONS.filter((operation) =>
      ['optional_key', 'public_metadata'].includes(operation.authentication),
    ).map((operation) => honoId(operation.id)),
    // These projections are account-owned or instance-wide.
    'GET /api/v1/profile',
    'GET /api/v1/schedules',
    'GET /api/v1/schedules/:id',
    'GET /api/v1/schedules/:id/availability',
    'GET /api/v1/schedules/:id/overrides',
    'GET /api/v1/calendar-connections',
    'GET /api/v1/conference-connections',
    'GET /api/v1/instance/embed',
    'GET /api/v1/mcp-oauth/connections',
  ])
  const privateReads = new Set(['POST /api/v1/routing-forms/:id/preview'])
  for (const operation of API_KEY_REST_OPERATIONS) {
    const id = honoId(operation.id)
    if (
      operation.method === 'POST' &&
      operation.operationClass.endsWith('_read') &&
      !excluded.has(id)
    )
      privateReads.add(id)
  }
  for (const { method, path } of routes) {
    const id = `${method} ${path}`
    if (path.startsWith('/api/v1/') && ['GET', 'HEAD'].includes(method) && !excluded.has(id))
      privateReads.add(id)
  }
  expect(new Set(teamReadRoutes)).toEqual(privateReads)
})

describe('openApiDocument', () => {
  it("publishes the caller's nullable personal organization separately from the active one", async () => {
    const doc = (await openApiDocument()) as {
      components: { schemas: { Me: { properties: Record<string, unknown>; required: string[] } } }
    }
    const me = doc.components.schemas.Me
    expect(me.properties.personalOrganizationId).toMatchObject({
      type: ['string', 'null'],
      format: 'uuid',
    })
    expect(me.required).toContain('personalOrganizationId')
  })

  it('documents open webhook response enums and requires a UUID booking ID on deliveries', async () => {
    type Schema = { properties: Record<string, unknown>; required: string[] }
    const { components } = (await openApiDocument()) as {
      components: { schemas: { Webhook: Schema; WebhookDelivery: Schema } }
    }
    const { Webhook, WebhookDelivery } = components.schemas
    expect(Webhook.properties.events).toMatchObject({
      description: expect.stringContaining('Open enum'),
      items: { enum: WEBHOOK_EVENTS },
    })
    expect(WebhookDelivery.properties.eventType).toMatchObject({
      description: expect.stringContaining('Open enum'),
      enum: WEBHOOK_EVENTS,
    })
    expect(WebhookDelivery.properties.bookingId).toMatchObject({ type: 'string', format: 'uuid' })
    expect(WebhookDelivery.required).toContain('bookingId')
  })

  it("lists every route group's paths, without a database", async () => {
    const doc = (await openApiDocument()) as { openapi: string; paths: Record<string, unknown> }
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/health',
        '/api/v1/me',
        '/api/v1/readiness/self',
        '/api/v1/teams/{teamId}/readiness',
        '/api/v1/instance',
        '/api/v1/profile',
        '/api/v1/schedules',
        '/api/v1/event-types',
        '/api/v1/public/{handle}/{slug}',
        '/api/v1/bookings',
        '/api/v1/calendar-connections',
        '/api/v1/calendar-connections/google/authorize',
      ]),
    )
  })
})
