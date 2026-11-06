// Waitlist configuration and admission use exactly the REST schemas and shared services.
import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  DomainError,
  getEventTypeWaitlist,
  joinWaitlist,
  listEventTypeWaitlistEntries,
  removeEventTypeWaitlistEntry,
  resendWaitlistVerification,
  type ServiceContext,
  setEventTypeWaitlist,
  type WaitlistContext,
  WaitlistSettingsSchema,
} from '@hourmere/scheduling'
import { createRateLimiter, PUBLIC_RATE_LIMITS } from '../rate-limit.ts'
import { WaitlistEntryPage } from '../routes/event-types.ts'
import { WaitlistJoinBody, WaitlistResendBody } from '../routes/public.ts'
import { defineTool, type McpCaller, type Tool, type ToolCall } from './tools.ts'

const eventId = z.uuid().openapi({ description: 'Event type id from list_event_types' })
const Id = z.strictObject({ id: eventId })
const PageReference = {
  handle: z.string().min(1).max(64).optional(),
  teamSlug: z.string().min(1).max(64).optional(),
  slug: z.string().min(1).max(128),
}
const pageSelection = (args: { handle?: string; teamSlug?: string }) =>
  (args.handle === undefined) !== (args.teamSlug === undefined)
const pageMode = (args: unknown) =>
  typeof args === 'object' && args !== null && 'teamSlug' in args ? 'team' : 'personal'
const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

export function waitlistTools({
  db,
  secret,
  smtpConfigured,
  publicUrl = 'http://localhost',
  now,
}: {
  db: Db
  secret?: string | undefined
  smtpConfigured?: boolean | undefined
  publicUrl?: string | undefined
  now?: (() => Temporal.Instant) | undefined
}): Tool[] {
  // Join and explicit resend share the public booking-write budget per user, across keys.
  const admissionLimit = createRateLimiter(PUBLIC_RATE_LIMITS.book)
  const context = (principal: McpCaller): ServiceContext => ({
    db,
    principal,
    now: now ?? (() => Temporal.Now.instant()),
  })
  const publicContext = (call: ToolCall): WaitlistContext => {
    if (!secret) throw new DomainError('conflict', 'waitlist_unavailable')
    if (!smtpConfigured) throw new DomainError('conflict', 'waitlist_smtp_not_configured')
    return { db, secret, publicUrl, trustedIp: call.trustedIp, now }
  }
  return [
    defineTool({
      name: 'get_event_type_waitlist',
      title: 'Get event type waitlist settings',
      description:
        'Reads whether a waitlist is enabled. Requires a full or read API key and permission to manage this event type: its personal owner, or a team owner/admin. No entry or token is returned.',
      input: Id,
      output: WaitlistSettingsSchema,
      annotations: read,
      async run(args, call) {
        return getEventTypeWaitlist(context(call.caller), args.id)
      },
    }),
    defineTool({
      name: 'set_event_type_waitlist',
      title: 'Set event type waitlist settings',
      description:
        'Enables or disables the waitlist for an individual event type with one host. Give id and enabled. Requires full API key scope and permission to manage the event type. Disabling removes waiting eligibility, erases contact details and revokes pending work; re-enabling does not restore entries. Nothing is reserved: all eligible invitees may be notified and the first successful ordinary booking wins.',
      input: Id.extend(WaitlistSettingsSchema.shape),
      output: WaitlistSettingsSchema,
      annotations: { ...read, readOnlyHint: false, destructiveHint: true },
      async run({ id, ...settings }, call) {
        return setEventTypeWaitlist(context(call.caller), id, settings)
      },
    }),
    defineTool({
      name: 'list_waitlist_entries',
      title: 'List event type waitlist entries',
      description:
        'Lists a managed event type’s waitlist, including retained contact details, requested window, state and timestamps. Requires a full or read API key and the personal owner or a team owner/admin; ordinary team membership is insufficient. Page by exclusive nextAfter with the same id; maximum 100 entries. Never returns verification or removal tokens.',
      input: Id.extend({
        after: z.uuid().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      output: WaitlistEntryPage,
      annotations: read,
      privateDiagnostics: true,
      async run({ id, ...page }, call) {
        return listEventTypeWaitlistEntries(context(call.caller), id, page)
      },
    }),
    defineTool({
      name: 'remove_waitlist_entry',
      title: 'Remove a waitlist entry',
      description:
        'Removes entryId from the managed event type id, erases its contact details and stops future waitlist messages. Requires full API key scope and the personal owner or a team owner/admin. Confirm the removal with the user first. Repeating removal of the same retained entry succeeds. Sends no removal email and returns no token.',
      input: Id.extend({ entryId: z.uuid() }),
      output: z.object({ removed: z.literal(true) }),
      annotations: { ...read, readOnlyHint: false, destructiveHint: true },
      privateDiagnostics: true,
      async run(args, call) {
        return removeEventTypeWaitlistEntry(context(call.caller), args.id, args.entryId)
      },
    }),
    defineTool({
      name: 'join_waitlist',
      title: 'Join a booking waitlist',
      description:
        'Requests email confirmation for a waitlist only when its enabled personal or single-host team event has no available times in preferredWindow. Give exactly one of handle or teamSlug, plus slug, email, optional name/locale, preferredWindow UTC instants and IANA timeZone, and explicit consent:true. Tell the invitee that the personal event owner or authorized team owners/admins can see their email, optional name and requested period, and ask for their consent before submitting. Nothing is reserved; the first successful ordinary booking wins. An accepted response always means check your email to confirm; it does not reveal existing registrations or mail delivery. Email verification and configured SMTP are required even for signed-in callers; missing SMTP returns waitlist_smtp_not_configured and a full 100-entry event returns waitlist_full. Shares REST’s durable email, event and trusted connection-IP abuse controls. Join and resend also share a 10-call-per-minute budget per user across all keys, including duplicate, suppressed and service-rejected requests. Never returns tokens and never automatically retries.',
      input: WaitlistJoinBody.extend(PageReference).refine(pageSelection, {
        message: 'Give exactly one of handle or teamSlug',
      }),
      output: z.object({ accepted: z.literal(true) }),
      annotations: { ...read, readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      scopeModes: ['personal', 'team'],
      scopeMode: pageMode,
      privateInput: () => true,
      privateDiagnostics: true,
      async run(args, call) {
        call.rateLimit(admissionLimit)
        const { handle, teamSlug, ...input } = args
        return joinWaitlist(publicContext(call), {
          ...input,
          handle: (teamSlug ?? handle) as string,
          team: teamSlug !== undefined,
        })
      },
    }),
    defineTool({
      name: 'resend_waitlist_verification',
      title: 'Request another waitlist confirmation email',
      description:
        'Explicitly requests another confirmation email after the invitee asks for one. Give exactly one of handle or teamSlug, slug and email. Uses the same durable limits and trusted connection IP as joining, including the 15-minute minimum between emails. Shares joining’s 10-call-per-minute budget per user across all keys, including duplicate, suppressed and service-rejected requests. The accepted response does not reveal whether an entry exists, is verified or received mail. Requires configured SMTP; otherwise returns waitlist_smtp_not_configured. Does not change preferences or expiry. Never returns tokens and never automatically retries.',
      input: WaitlistResendBody.extend(PageReference).refine(pageSelection, {
        message: 'Give exactly one of handle or teamSlug',
      }),
      output: z.object({ accepted: z.literal(true) }),
      annotations: { ...read, readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      scopeModes: ['personal', 'team'],
      scopeMode: pageMode,
      privateInput: () => true,
      privateDiagnostics: true,
      async run(args, call) {
        call.rateLimit(admissionLimit)
        return resendWaitlistVerification(publicContext(call), {
          handle: (args.teamSlug ?? args.handle) as string,
          team: args.teamSlug !== undefined,
          slug: args.slug,
          email: args.email,
        })
      },
    }),
  ]
}
