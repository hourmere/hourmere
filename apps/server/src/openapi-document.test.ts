import { WEBHOOK_EVENTS } from '@hourmere/webhooks'
import { describe, expect, it } from 'vitest'
import { openApiDocument } from './openapi-document.ts'

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
