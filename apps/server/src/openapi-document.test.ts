import { API_KEY_MCP_OPERATIONS, API_KEY_REST_OPERATIONS } from '@hourmere/auth'
import { WEBHOOK_EVENTS } from '@hourmere/webhooks'
import { describe, expect, it } from 'vitest'
import { openApiDocument, openApiRouteInventory } from './openapi-document.ts'
import { teamWriteTool } from './sso-write-routes.ts'

const honoId = (id: string) => id.replace(/\{(\w+)\}/g, ':$1')

it('attaches the team proof middleware to every private team read in the server inventory', async () => {
  const { routes, teamReadRoutes } = await openApiRouteInventory()
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
  // Workflow run history is a team read like the other workflow reads.
  for (const read of [
    'GET /api/v1/workflows',
    'GET /api/v1/workflows/:id',
    'GET /api/v1/workflows/:id/runs',
  ])
    expect(teamReadRoutes).toContain(read)
  // Routing continuations authorize by capability token, not by a team session.
  for (const route of [
    'POST /api/v1/routing-continuations/resolve',
    'POST /api/v1/routing-continuations/slots',
    'POST /api/v1/routing-continuations/bookings',
  ])
    expect(teamReadRoutes).not.toContain(route)
})

it('attaches the team proof middleware to every private team write in the server inventory', async () => {
  const { routes, teamWriteRoutes } = await openApiRouteInventory()
  const excluded = new Set([
    ...API_KEY_REST_OPERATIONS.filter(
      (op) =>
        op.authentication === 'optional_key' ||
        op.authentication === 'public_metadata' ||
        op.operationClass.endsWith('_read'),
    ).map((op) => honoId(op.id)),
    'ALL /api/v1/*',
    'ALL /api/v1/public/meeting-polls/*',
    // These POSTs only read data.
    'POST /api/v1/routing-forms/:id/preview',
    'POST /api/v1/mcp-oauth/request',
    // These write a caller-owned profile, availability schedule or integration.
    'PATCH /api/v1/profile/name',
    'PUT /api/v1/profile',
    'POST /api/v1/schedules/default',
    'POST /api/v1/schedules',
    'PUT /api/v1/schedules/:id/availability',
    'PATCH /api/v1/schedules/:id',
    'DELETE /api/v1/schedules/:id',
    'PUT /api/v1/schedules/:id/overrides/:date',
    'DELETE /api/v1/schedules/:id/overrides/:date',
    'POST /api/v1/calendar-connections/google/authorize',
    'POST /api/v1/calendar-connections/microsoft/authorize',
    'PATCH /api/v1/calendars/:id',
    'POST /api/v1/calendars/:id/sync',
    'PUT /api/v1/calendar-destination',
    'DELETE /api/v1/calendar-connections/:id',
    'POST /api/v1/calendar-connections/:id/refresh',
    'POST /api/v1/calendar-connections/caldav/discover',
    'POST /api/v1/calendar-connections/caldav',
    'POST /api/v1/conference-connections/zoom/authorize',
    'POST /api/v1/conference-connections/:id/reconnect',
    'POST /api/v1/conference-connections/zoom/authorize-meetings',
    'POST /api/v1/conference-connections/:id/authorize-meetings',
    'POST /api/v1/conference-connections/:id/refresh',
    'DELETE /api/v1/conference-connections/:id',
    // Delegation enforcement covers the existing OAuth consent ceremony.
    'POST /api/v1/mcp-oauth/select',
    'POST /api/v1/mcp-oauth/consent',
    'DELETE /api/v1/mcp-oauth/connections/:id',
    // Independent proof is available before a member has a live SSO proof.
    'POST /api/v1/team/sso/providers/:providerId/link',
    'DELETE /api/v1/team/sso/providers/:providerId/link',
    'POST /api/v1/team/sso/recovery/:enrollmentId/accept',
    'POST /api/v1/team/sso/recovery/use',
    // A current member may withdraw their delegated authority after browser proof expires.
    'DELETE /api/v1/team/sso/delegations/:bindingId',
  ])
  const privateWrites = new Set<string>()
  for (const { method, path } of routes) {
    const id = `${method} ${path}`
    if (
      (path === '/api/v1' || path.startsWith('/api/v1/')) &&
      !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
      !excluded.has(id)
    )
      privateWrites.add(id)
  }
  expect(new Set(teamWriteRoutes)).toEqual(privateWrites)
  // Routing continuations authorize by capability token, not by a team session.
  for (const route of [
    'POST /api/v1/routing-continuations/resolve',
    'POST /api/v1/routing-continuations/slots',
    'POST /api/v1/routing-continuations/bookings',
  ]) {
    expect(routes.map(({ method, path }) => `${method} ${path}`)).toContain(route)
    expect(teamWriteRoutes).not.toContain(route)
  }
  // A new route must use the guarded transaction in its committing service as well as
  // the request middleware. Keep this list explicit so new writes surface in review.
  expect(privateWrites).toEqual(
    new Set([
      'POST /api/v1/organizations/:organizationId/provisioning-tokens',
      'POST /api/v1/organizations/:organizationId/provisioning-tokens/:id/rotate',
      'DELETE /api/v1/organizations/:organizationId/provisioning-tokens/:id',
      'POST /api/v1/webhooks',
      'PATCH /api/v1/webhooks/:id',
      'DELETE /api/v1/webhooks/:id',
      'POST /api/v1/webhooks/:id/rotate-secret',
      'PATCH /api/v1/branding',
      'POST /api/v1/branding/logo',
      'PUT /api/v1/audit-log/settings',
      'POST /api/v1/team/sso/delegations',
      'POST /api/v1/team/sso/recovery',
      'POST /api/v1/team/sso/domains',
      'POST /api/v1/team/sso/domains/:domainId/verify',
      'DELETE /api/v1/team/sso/domains/:domainId',
      'POST /api/v1/team/sso/providers',
      'POST /api/v1/team/sso/providers/:providerId/test',
      'POST /api/v1/team/sso/providers/:providerId/activation',
      'PUT /api/v1/team/sso/policy',
      'PATCH /api/v1/team/sso/providers/:providerId',
      'DELETE /api/v1/team/sso/providers/:providerId',
      'DELETE /api/v1/team/sso/providers/:providerId/links/:linkId',
      'POST /api/v1/slack-destinations',
      'PATCH /api/v1/slack-destinations/:id',
      'DELETE /api/v1/slack-destinations/:id',
      'POST /api/v1/slack-destinations/:id/test',
      'PUT /api/v1/event-types/:id/waitlist',
      'DELETE /api/v1/event-types/:id/waitlist/entries/:entryId',
      'PUT /api/v1/event-types/:id/notifications',
      'POST /api/v1/event-types',
      'POST /api/v1/event-types/:id/duplicate',
      'PATCH /api/v1/event-types/:id',
      'POST /api/v1/event-types/:id/round-robin/activate',
      'DELETE /api/v1/event-types/:id',
      'POST /api/v1/meeting-polls',
      'POST /api/v1/meeting-polls/:id/close',
      'POST /api/v1/meeting-polls/:id/cancel',
      'POST /api/v1/meeting-polls/:id/invitations',
      'POST /api/v1/meeting-polls/:id/invitations/:voterId/resend',
      'DELETE /api/v1/meeting-polls/:id/voters/:voterId',
      'POST /api/v1/meeting-polls/:id/remove-unverified',
      'POST /api/v1/meeting-polls/:id/rotate-link',
      'DELETE /api/v1/meeting-polls/:id',
      'POST /api/v1/meeting-polls/:id/finalize',
      'POST /api/v1/event-types/:eventTypeId/one-time-links',
      'DELETE /api/v1/event-types/:eventTypeId/one-time-links/:id',
      'POST /api/v1/routing-forms',
      'PATCH /api/v1/routing-forms/:id',
      'DELETE /api/v1/routing-forms/:id',
      'POST /api/v1/routing-forms/:id/publish',
      'POST /api/v1/group-occurrences/:id/cancel',
      'PATCH /api/v1/bookings/:id/attendees/:attendeeId/no-show',
      'POST /api/v1/bookings/:id/request-reschedule',
      'POST /api/v1/bookings/:id/conference/retry',
      'POST /api/v1/bookings/:id/calendar-copy/retry',
      'POST /api/v1/bookings/:id/reschedule',
      'POST /api/v1/bookings/:id/cancel',
      'POST /api/v1/team/bookings/:id/cancel',
      'POST /api/v1/team/bookings/:id/handoff-offers',
      'POST /api/v1/team/bookings/:id/handoff-offers/:offerId/withdraw',
      'POST /api/v1/team/bookings/:id/handoff-offers/:offerId/resend',
      'POST /api/v1/team/bookings/:id/handoff-offers/:offerId/apply',
      'POST /api/v1/team/bookings/bulk-cancellations/preview',
      'POST /api/v1/team/bookings/bulk-cancellations/:id/confirm',
      'POST /api/v1/team/invitations/:invitationId/cancel',
      'POST /api/v1/team/members/:memberUserId/removal',
      'POST /api/v1/teams/:teamId/leave',
      'POST /api/v1/workflows',
      'PATCH /api/v1/workflows/:id',
      'DELETE /api/v1/workflows/:id',
      // Authorizes as a write and reads live team configuration, but persists nothing.
      'POST /api/v1/workflows/preview',
    ]),
  )

  // Registry parity also pins a mixed tool's independent host and manage-token modes.
  for (const operation of API_KEY_MCP_OPERATIONS) {
    const protectedWrite = operation.rest.some((id) => privateWrites.has(honoId(id)))
    expect(teamWriteTool(operation.tool, operation.mode), operation.id).toBe(protectedWrite)
  }
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

  it('documents the webhook delivery cursor and its validation error', async () => {
    const doc = (await openApiDocument()) as {
      paths: Record<
        string,
        { get: { parameters: unknown[]; responses: Record<string, { description: string }> } }
      >
    }
    const operation = doc.paths['/api/v1/webhooks/{id}/deliveries']?.get
    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({
        name: 'after',
        in: 'query',
        required: false,
        schema: expect.objectContaining({
          type: 'string',
          description: expect.stringContaining('nextAfter UUID'),
        }),
      }),
    )
    expect(operation?.responses[400]?.description).toContain('invalid_cursor')
  })

  it("lists every route group's paths, without a database", async () => {
    const doc = (await openApiDocument()) as { openapi: string; paths: Record<string, unknown> }
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/health',
        '/api/webhooks/stripe',
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
