import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  createOneTimeBookingLink,
  listOneTimeBookingLinks,
  revokeManagedOneTimeBookingLink,
  type ServiceContext,
} from '@hourmere/scheduling'
import {
  CreatedOneTimeLink,
  CreateOneTimeLink,
  createdOneTimeLinkResponse,
  OneTimeLink,
  OneTimeLinkList,
  OneTimeLinkListQuery,
} from '../routes/one-time-links.ts'
import { defineTool, type McpCaller, type Tool } from './tools.ts'

/** Link administration shares REST schemas and the service's ownership and expiry rules. */
export function oneTimeLinkTools({
  db,
  publicUrl = 'http://localhost',
}: {
  db: Db
  publicUrl?: string
}): Tool[] {
  const context = (principal: McpCaller): ServiceContext => ({
    db,
    principal,
    now: () => Temporal.Now.instant(),
  })
  const eventTypeId = z.uuid().openapi({ description: 'The event type id from list_event_types' })
  return [
    defineTool({
      name: 'create_one_time_link',
      title: 'Create a one-time booking link',
      description:
        'Creates a private link for one event type you can manage. Requires a bookings/full API key or an authorized MCP OAuth connection. The booking URL is shown only in this create response: copy it now and keep it private. List/get cannot recover it. expiresAt is an optional future RFC 3339 instant with an offset; omission or null means no expiry. Optional invitee name/email prefill is editable and does not prove identity. Requires a retained random idempotencyKey. Repeating the same key and normalized arguments returns one_time_link_already_created without another token; no response cache recovers the URL. Changed arguments return idempotency_key_reused. Retention or event deletion can remove the marker. Team links belong to the team after their creator leaves. Limits: 1000 active unexpired links per personal owner/team, and 200 per ordinary team member. No private labels are stored.',
      input: CreateOneTimeLink.extend({
        eventTypeId,
        idempotencyKey: z
          .string()
          .regex(/^[\x21-\x7e]{1,255}$/)
          .openapi({
            description:
              'Retain a new random key before the call. Same-key retries never return the secret URL again.',
          }),
      }),
      output: CreatedOneTimeLink,
      privateInput: () => true,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run(args, call) {
        const created = await createOneTimeBookingLink(context(call.caller), args)
        return createdOneTimeLinkResponse(created, publicUrl)
      },
    }),
    defineTool({
      name: 'list_one_time_links',
      title: 'List one-time booking links',
      description:
        'Lists safe metadata for an event type you can manage in this organization. Requires a read/full API key, or an authorized MCP OAuth connection. Returns state, event type, expiry, editable invitee prefill, creator and creation time, use time and consuming booking id. Never returns a booking URL, raw token or hash. Pages show newest links first by time-ordered UUIDv7 id; pass nextAfter as after with the same event type. Expiry uses database wall time. Team links remain visible to current team managers after their creator leaves.',
      input: OneTimeLinkListQuery.extend({
        eventTypeId,
        // HTTP query strings are coerced by REST; MCP advertises and accepts JSON integers.
        limit: z.number().int().min(1).max(100).optional(),
      }).strict(),
      output: OneTimeLinkList,
      privateInput: () => true,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run(args, call) {
        return listOneTimeBookingLinks(context(call.caller), args)
      },
    }),
    defineTool({
      name: 'revoke_one_time_link',
      title: 'Revoke a one-time booking link',
      description:
        'Revokes a link by eventTypeId and the id returned when it was created, or from list_one_time_links (read/full keys). Requires a bookings/full API key or an authorized MCP OAuth connection, and current permission to manage the event type. Returns safe metadata in link, or null for an unknown/unrelated id. Idempotent: used links retain their booking and state, revoked links never reactivate, and repeated revocation changes nothing. This withdraws an unused booking capability; confirm the intended link first.',
      input: z.strictObject({ eventTypeId, id: z.uuid() }),
      output: z.object({ link: OneTimeLink.nullable() }),
      privateInput: () => true,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run(args, call) {
        return { link: await revokeManagedOneTimeBookingLink(context(call.caller), args) }
      },
    }),
  ]
}
