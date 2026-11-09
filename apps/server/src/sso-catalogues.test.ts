import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import type { Principal } from '@hourmere/auth'
import { createDb, createPool } from '@hourmere/db'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { COMMANDS, REST_COMMANDS } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'
import { openApiDocument } from './openapi-document.ts'
import { productTools } from './server.ts'

// Frozen before the hard-off implementation, from main at 14fbe9c96f5f0340a927a6dec9d7dc8102891e47.
// This step adds only instance capabilities, not routes, tools or commands.
describe('SSO hard-off preserves the published catalogues', () => {
  it('keeps the published OpenAPI paths', async () => {
    const document = (await openApiDocument()) as { paths: Record<string, unknown> }
    expect(Object.keys(document.paths).sort()).toMatchInlineSnapshot(`
      [
        "/api/health",
        "/api/v1/analytics/bookings",
        "/api/v1/book/{token}",
        "/api/v1/book/{token}/bookings",
        "/api/v1/book/{token}/slots",
        "/api/v1/bookings",
        "/api/v1/bookings/export.csv",
        "/api/v1/bookings/manage",
        "/api/v1/bookings/manage/cancel",
        "/api/v1/bookings/manage/reschedule",
        "/api/v1/bookings/manage/slots",
        "/api/v1/bookings/{id}",
        "/api/v1/bookings/{id}/attendees",
        "/api/v1/bookings/{id}/attendees/{attendeeId}/no-show",
        "/api/v1/bookings/{id}/calendar-copy/retry",
        "/api/v1/bookings/{id}/cancel",
        "/api/v1/bookings/{id}/conference/retry",
        "/api/v1/bookings/{id}/organization",
        "/api/v1/bookings/{id}/request-reschedule",
        "/api/v1/bookings/{id}/reschedule",
        "/api/v1/bookings/{id}/slots",
        "/api/v1/branding",
        "/api/v1/branding/logo",
        "/api/v1/branding/logo/{hash}",
        "/api/v1/calendar-connections",
        "/api/v1/calendar-connections/google/authorize",
        "/api/v1/calendar-connections/microsoft/authorize",
        "/api/v1/calendar-connections/{id}",
        "/api/v1/calendar-connections/{id}/refresh",
        "/api/v1/calendar-destination",
        "/api/v1/calendars/{id}",
        "/api/v1/calendars/{id}/sync",
        "/api/v1/conference-connections",
        "/api/v1/conference-connections/zoom/authorize",
        "/api/v1/conference-connections/zoom/authorize-meetings",
        "/api/v1/conference-connections/{id}",
        "/api/v1/conference-connections/{id}/authorize-meetings",
        "/api/v1/conference-connections/{id}/reconnect",
        "/api/v1/conference-connections/{id}/refresh",
        "/api/v1/event-type-hosts",
        "/api/v1/event-types",
        "/api/v1/event-types/{eventTypeId}/one-time-links",
        "/api/v1/event-types/{eventTypeId}/one-time-links/{id}",
        "/api/v1/event-types/{id}",
        "/api/v1/event-types/{id}/notifications",
        "/api/v1/event-types/{id}/round-robin/activate",
        "/api/v1/event-types/{id}/waitlist",
        "/api/v1/event-types/{id}/waitlist/entries",
        "/api/v1/event-types/{id}/waitlist/entries/{entryId}",
        "/api/v1/instance",
        "/api/v1/instance/embed",
        "/api/v1/mcp-oauth/connections",
        "/api/v1/mcp-oauth/connections/{id}",
        "/api/v1/mcp-oauth/consent",
        "/api/v1/mcp-oauth/request",
        "/api/v1/mcp-oauth/select",
        "/api/v1/me",
        "/api/v1/open-time-snippets",
        "/api/v1/organizations/{organizationId}/provisioning-tokens",
        "/api/v1/organizations/{organizationId}/provisioning-tokens/{id}",
        "/api/v1/organizations/{organizationId}/provisioning-tokens/{id}/rotate",
        "/api/v1/profile",
        "/api/v1/profile/name",
        "/api/v1/public/teams/{handle}/{slug}",
        "/api/v1/public/teams/{handle}/{slug}/bookings",
        "/api/v1/public/teams/{handle}/{slug}/slots",
        "/api/v1/public/teams/{handle}/{slug}/waitlist",
        "/api/v1/public/teams/{handle}/{slug}/waitlist/resend",
        "/api/v1/public/{handle}",
        "/api/v1/public/{handle}/{slug}",
        "/api/v1/public/{handle}/{slug}/bookings",
        "/api/v1/public/{handle}/{slug}/slots",
        "/api/v1/public/{handle}/{slug}/waitlist",
        "/api/v1/public/{handle}/{slug}/waitlist/resend",
        "/api/v1/readiness/self",
        "/api/v1/schedules",
        "/api/v1/schedules/default",
        "/api/v1/schedules/{id}",
        "/api/v1/schedules/{id}/availability",
        "/api/v1/schedules/{id}/overrides",
        "/api/v1/schedules/{id}/overrides/{date}",
        "/api/v1/team/bookings",
        "/api/v1/team/bookings/{id}",
        "/api/v1/team/bookings/{id}/cancel",
        "/api/v1/team/invitations",
        "/api/v1/team/invitations/{invitationId}",
        "/api/v1/team/invitations/{invitationId}/cancel",
        "/api/v1/team/member-removals/{operationId}",
        "/api/v1/team/members/{memberUserId}/departure-impact",
        "/api/v1/team/members/{memberUserId}/removal",
        "/api/v1/team/members/{memberUserId}/removal-handling",
        "/api/v1/teams/{teamId}/leave",
        "/api/v1/teams/{teamId}/member-readiness",
        "/api/v1/teams/{teamId}/readiness",
        "/api/v1/webhooks",
        "/api/v1/webhooks/{id}",
        "/api/v1/webhooks/{id}/deliveries",
        "/api/v1/webhooks/{id}/rotate-secret",
      ]
    `)
  })

  it('keeps the MCP tools advertised to a full-scope caller', async () => {
    // tools/list never accesses the database; this pool is never connected.
    const db = createDb(createPool('postgres://catalogue@127.0.0.1:9/catalogue'))
    const principal: Principal = {
      kind: 'api_key',
      apiKeyScope: 'full',
      apiKeyId: '00000000-0000-7000-8000-000000000001',
      user: { id: '00000000-0000-7000-8000-000000000002', name: 'Ada', email: 'ada@example.com' },
      organization: {
        id: '00000000-0000-7000-8000-000000000003',
        name: 'Ada',
        slug: 'ada',
        personal: true,
      },
    }
    const client = new Client({ name: 'catalogue-test', version: '1.0.0' })
    try {
      const app = createApp({
        checkDb: async () => {},
        authHandler: async () => new Response(null, { status: 404 }),
        resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
        publicUrl: 'http://localhost',
        mcp: mcpEndpoint({ tools: productTools({ db }) }),
      })
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
          fetch: async (input, init) => app.request(input, init),
          requestInit: { headers: { authorization: 'Bearer hm_catalogue' } },
        }),
      )
      expect(
        (await client.listTools()).tools.map((tool) => tool.name).sort(),
      ).toMatchInlineSnapshot(`
        [
          "cancel_booking",
          "create_booking",
          "create_event_type",
          "create_one_time_link",
          "export_bookings",
          "find_available_slots",
          "get_booking_attendees",
          "get_branding",
          "get_event_type",
          "get_event_type_waitlist",
          "get_profile",
          "get_schedule",
          "get_schedule_availability",
          "join_waitlist",
          "list_bookings",
          "list_calendar_connections",
          "list_conference_connections",
          "list_event_types",
          "list_one_time_links",
          "list_schedules",
          "list_waitlist_entries",
          "remove_waitlist_entry",
          "request_reschedule",
          "reschedule_booking",
          "resend_waitlist_verification",
          "retry_calendar_copy",
          "retry_conference",
          "revoke_one_time_link",
          "save_schedule_availability",
          "set_attendee_no_show",
          "set_branding",
          "set_event_type_notifications",
          "set_event_type_waitlist",
          "update_event_type",
          "whoami",
        ]
      `)
    } finally {
      await client.close()
      await db.destroy()
    }
  })

  it('publishes the new instance capabilities as optional booleans on an open object', async () => {
    const document = (await openApiDocument()) as {
      components: {
        schemas: {
          Instance: {
            properties: Record<string, unknown>
            required?: string[]
            additionalProperties?: unknown
          }
        }
      }
    }
    const instance = document.components.schemas.Instance
    expect(instance.additionalProperties).not.toBe(false)
    for (const field of ['ssoOidcEnabled', 'ssoSamlEnabled']) {
      expect(instance.properties[field]).toMatchObject({ type: 'boolean' })
      expect(instance.required ?? []).not.toContain(field)
    }
  })

  it('keeps the CLI command registry', () => {
    expect({ ...COMMANDS, ...REST_COMMANDS }).toMatchInlineSnapshot(`
      {
        "book": "create_booking",
        "booking-attendees": "get_booking_attendees",
        "branding get": "get_branding",
        "branding set": "set_branding",
        "branding upload": "POST /api/v1/branding/logo",
        "cancel": "cancel_booking",
        "catalog": "list_event_types",
        "create-event": "create_event_type",
        "event": "get_event_type",
        "event-waitlist": "get_event_type_waitlist",
        "export": "export_bookings",
        "join-waitlist": "join_waitlist",
        "list": "list_bookings",
        "one-time-links create": "create_one_time_link",
        "one-time-links list": "list_one_time_links",
        "one-time-links revoke": "revoke_one_time_link",
        "open-time-snippet": "generate_open_time_snippet",
        "profile": "get_profile",
        "remove-waitlist-entry": "remove_waitlist_entry",
        "request-reschedule": "request_reschedule",
        "reschedule": "reschedule_booking",
        "resend-waitlist-verification": "resend_waitlist_verification",
        "retry-calendar-copy": "retry_calendar_copy",
        "retry-meeting": "retry_conference",
        "save-availability": "save_schedule_availability",
        "schedule": "get_schedule",
        "schedule-availability": "get_schedule_availability",
        "schedules": "list_schedules",
        "set-event-notifications": "set_event_type_notifications",
        "set-event-waitlist": "set_event_type_waitlist",
        "set-no-show": "set_attendee_no_show",
        "slots": "find_available_slots",
        "update-event": "update_event_type",
        "waitlist-entries": "list_waitlist_entries",
        "whoami": "whoami",
      }
    `)
  })

  it('keeps the existing web router and path definitions unchanged', async () => {
    // The existing app-routes.test.tsx exercises these routes in jsdom. Freeze the
    // definitions here as well, without importing browser modules into a server test.
    const webFiles = await readdir(new URL('../../web/src/', import.meta.url))
    for (const [file, digest] of [
      ['App.tsx', '3b357198f2876e1f5c18ea0f00fc90a0f7b4283cc34991326dfee4fcd02b1566'],
      ['paths.ts', '6607d87ebd83ad71d86a45471d56d4ba230ae7fa1385f6aa06e719d94b877530'],
    ]) {
      // Catch casing mistakes even on case-insensitive developer filesystems.
      expect(webFiles).toContain(file)
      const source = await readFile(new URL(`../../web/src/${file}`, import.meta.url))
      expect(createHash('sha256').update(source).digest('hex')).toBe(digest)
    }
  })
})
