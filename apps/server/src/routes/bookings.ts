import { createRoute, z } from '@hono/zod-openapi'
import { retryBookingConference, retryConferenceMirror } from '@hourmere/calendars'
import type { Db } from '@hourmere/db'
import {
  type BookingNotifier,
  cancelHostBooking,
  cancelManagedBooking,
  exportBookingsCsv,
  getHostBooking,
  getManagedBookingDetails,
  LOCATION_KINDS,
  listHostBookingSlots,
  listHostBookings,
  listManagedSlots,
  MAX_PAGE_SIZE,
  MAX_SLOT_RANGE_DAYS,
  type PublicContext,
  RescheduleRequestNoteSchema,
  ResponsesSchema,
  requestReschedule,
  rescheduleHostBooking,
  rescheduleManagedBooking,
  resolveBookingOrganization,
  type ServiceContext,
} from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { CallerEnv } from '../caller.ts'
import { localeDescription } from '../i18n/locale-description.ts'
import { authenticated, ErrorBody, json, Question, type RouteModule } from '../openapi.ts'
import { createRateLimiter, PUBLIC_RATE_LIMITS, type RateLimit, rateLimit } from '../rate-limit.ts'
import { publicBookingAuditOrigin } from '../rest-scopes.ts'
import { bookingWriteAccess, EXPECTED_ORGANIZATION_HEADER } from '../team-management.ts'

// Schemas shared with the public routes (public.ts).

/** Whether Temporal (and so every service) can read it: e.g. at most nine fractional digits. */
const isTemporalInstant = (value: string) => {
  try {
    Temporal.Instant.from(value)
    return true
  } catch {
    return false
  }
}

export const Instant = z.iso
  .datetime({ offset: true })
  .refine(isTemporalInstant, 'must be an instant with at most nine fractional digits')
  .openapi({
    description:
      'An instant (RFC 3339, up to nine fractional digits; stored with microsecond precision). Responses always use UTC with a Z suffix.',
    example: '2026-11-02T09:00:00.000Z',
  })

export const LocationKind = z.enum(LOCATION_KINDS)

/** A bookable time: public slots and the times a booking can move to. */
export const Slot = z.object({ start: Instant, end: Instant }).openapi('Slot')

/** A selected length is checked against the event type's current allowed list by the service. */
export const SelectedDurationMinutes = z.number().int().min(1).max(1440).openapi({
  description:
    "Selected meeting length in whole minutes, from the event type's allowedDurationsMinutes. Omitted uses the default for a new booking, or preserves the original booking length when rescheduling.",
})

const SlotRange = z.object({
  start: Instant,
  end: Instant,
  durationMinutes: z.coerce.number().pipe(SelectedDurationMinutes).optional(),
})

const ExpectedOrganizationHeaders = z.object({
  'x-expected-organization-id': z.string().optional().openapi({
    description:
      'Browser host actions bind this to the organization where the action opened. When supplied by a browser session, mismatched, removed or stale organization context returns 409 organization_context_changed. Optional for older clients and ignored for API keys.',
  }),
})

export const BookingLocation = z.looseObject({ kind: LocationKind }).openapi('BookingLocation', {
  description:
    'Where the meeting happens. Details depend on the kind: `number` (phone), `address` (in_person), `url` (link)',
})

const Attendee = z
  .object({
    name: z.string(),
    email: z.string(),
    timeZone: z.string().openapi({ description: 'IANA time zone' }),
    locale: z.string().nullable().openapi({ description: localeDescription }),
    isBooker: z.boolean().openapi({
      description: 'The invitee who made the booking; the others are guests they added',
    }),
  })
  .openapi('Attendee')

export const Responses = ResponsesSchema.openapi('Responses', {
  description:
    "Answers to the event type's questions, keyed by question id: text for short_text, long_text and phone; one option for select; a list of options for multi_select; true or false for checkbox",
})

export const Booking = z
  .object({
    id: z.uuid(),
    eventTypeId: z.uuid().nullable(),
    status: z.enum(['confirmed', 'cancelled']),
    isGroupSeat: z.boolean().optional().openapi({
      description:
        'True for a group-seat booking, which does not support host reschedule requests.',
    }),
    pendingReschedule: z
      .object({
        id: z.uuid(),
        expiresAt: Instant,
        note: z.string().nullable(),
      })
      .optional()
      .openapi({
        description:
          'An outstanding host request to choose another time. The original booking stays confirmed and blocks its slot; expiry keeps the original time.',
      }),
    start: Instant,
    end: Instant,
    title: z.string(),
    eventTypeTitle: z.string().nullable().optional().openapi({
      description:
        "Authenticated host reads only: the event type's current title, or null when deleted. The stored booking title remains historical; clients must verify its exact composition before localizing it.",
    }),
    location: BookingLocation.nullable(),
    conference: z
      .object({
        provider: z.enum(['google_meet', 'zoom']),
        status: z.enum(['pending', 'ready', 'failed']),
        errorCode: z.string().max(64).nullable().openapi({
          description:
            'Stable failure code, or null. conference_pending_timeout means Google still reports a pending conference after the polling budget; provider_unavailable means a provider or transport failure. Clients must accept additional codes.',
          example: 'conference_pending_timeout',
        }),
      })
      .optional(),
    conferenceCanRetry: z.boolean().optional().openapi({
      description: 'Authenticated host reads only: whether this caller is the pinned organizer.',
    }),
    calendarCopy: z
      .object({
        status: z.enum(['pending', 'ready', 'failed', 'not_configured']),
        errorCode: z.string().max(64).nullable(),
        canRetry: z.boolean(),
      })
      .optional()
      .openapi({
        description: 'Authenticated host reads only: this caller’s ordinary calendar copy.',
      }),
    responses: Responses,
    questions: z.array(Question).optional().openapi({
      description:
        'Authenticated host reads only: the imported booking’s original question definitions, including preserved notes.',
    }),
    attendees: z.array(Attendee).openapi({ description: 'The invitee first, then guests' }),
    coHosts: z
      .array(z.object({ name: z.string() }))
      .optional()
      .openapi({
        description:
          'Authenticated host reads only: the other booked hosts’ names, with no email addresses or internal identifiers. Omitted for single-host bookings.',
      }),
    rescheduledFromId: z.uuid().nullable().openapi({
      description: 'The booking this one replaced when it was rescheduled',
    }),
    rescheduledToId: z.uuid().nullable().optional().openapi({
      description:
        'Authenticated host reads only: the immediate successor booking in the same organization that this caller also hosts, or null. A rescheduled predecessor keeps status cancelled.',
    }),
    cancelledAt: Instant.nullable(),
    cancelReason: z.string().nullable(),
    source: z.enum(['web', 'embed', 'api', 'mcp', 'import']).openapi({
      description:
        'How the booking was made; import means a read-only busy record managed in the original system',
    }),
    managementPolicy: z.literal('local_only_read_only').optional().openapi({
      description:
        'Present for imported busy records: managed in the original system, without Hourmere management links, changes, retries, calendar writes or notifications.',
    }),
    createdAt: Instant,
    assignedHost: z
      .object({ name: z.string(), timeZone: z.string() })
      .nullable()
      .optional()
      .openapi({
        description:
          'The actual round-robin winner; no private host identity or availability mapping',
      }),
  })
  .openapi('Booking')

export const ManagedBooking = Booking.extend({
  eventType: z
    .object({
      title: z.string(),
      durationMinutes: z.number().int(),
      allowedDurationsMinutes: z.array(SelectedDurationMinutes).min(1).max(12).optional(),
    })
    .nullable()
    .openapi({
      description:
        'The event type as it is now; null once it is deleted. The booking start and end retain its actual length even if the default changes.',
    }),
  hosts: z.array(z.object({ name: z.string() })).openapi({
    description: "Who the invitee meets: each host's name",
  }),
}).openapi('ManagedBooking')

export const BookingWithToken = z
  .object({
    booking: Booking,
    manageToken: z.string().nullable().openapi({
      description:
        "The invitee's own manage token, sent as X-Manage-Token to /api/v1/bookings/manage. Returned once on creation or an invitee reschedule; creation replays and host reschedules return null. A host reschedule transfers the existing hash to the successor so the invitee's original token keeps working; an invitee reschedule leaves the old token on the cancelled booking. Emails carry their own tokens that follow the chain.",
    }),
  })
  .openapi('BookingWithToken')

export const CancelBody = z
  .strictObject({ reason: z.string().max(1000).optional() })
  .openapi('CancelBooking')

export const RescheduleBody = z
  .strictObject({ start: Instant, durationMinutes: SelectedDurationMinutes.optional() })
  .openapi('Reschedule')

export const RescheduleRequestId = z.uuid().optional().openapi({
  description:
    'The pendingReschedule.id being answered. Fences replaced requests and makes a matching pick or cancellation safe to replay.',
})
export const ManagedCancelBody = z.strictObject({
  ...CancelBody.shape,
  rescheduleRequestId: RescheduleRequestId,
})
export const ManagedRescheduleBody = z.strictObject({
  ...RescheduleBody.shape,
  rescheduleRequestId: RescheduleRequestId,
})

export const RequestRescheduleBody = z
  .strictObject({
    idempotencyKey: z.uuid().openapi({
      description:
        'Retain this random UUID for retries. A new key replaces the current request; changed input with an existing key is refused.',
    }),
    note: RescheduleRequestNoteSchema.optional().openapi({
      description:
        'Optional plain text, at most 2000 UTF-16 code units, normalized like follow-up host notes. Included only in the email body.',
    }),
  })
  .openapi('RequestReschedule')

export const BookingPage = z
  .object({
    data: z.array(Booking),
    nextCursor: z.string().nullable().openapi({
      description: 'Pass as `cursor` to get the next page; null on the last page',
    }),
  })
  .openapi('BookingPage')

/** Filters and paging for the host's bookings (GET /api/v1/bookings, MCP list_bookings). */
export const ListBookingsQuery = z.object({
  order: z.enum(['asc', 'desc']).optional().openapi({
    description: 'Order by start time and id: asc (default) or desc. Keep unchanged between pages.',
  }),
  from: Instant.optional().openapi({ description: 'Only bookings starting at or after' }),
  to: Instant.optional().openapi({ description: 'Only bookings starting before' }),
  endAfter: Instant.optional().openapi({ description: 'Only bookings ending after (exclusive)' }),
  endTo: Instant.optional().openapi({
    description: 'Only bookings ending at or before (inclusive)',
  }),
  status: z.enum(['confirmed', 'cancelled']).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .openapi({ description: `Page size, 1–${MAX_PAGE_SIZE} (default 50)` }),
  cursor: z.string().optional(),
})

const error = (description: string) => ({ description, content: json(ErrorBody) })

const ManageToken = z.object({
  'x-manage-token': z.string().optional().openapi({
    description:
      "The invitee's secret: the `manageToken` the booking API returned, or the `token` in a link from a booking email (https://<app>/booking#token=…). A missing or unknown token gets 404 `booking_not_found`. After an invitee reschedule, the previous response token shows the cancelled booking; a host reschedule transfers that token's hash to the successor so it keeps working. Email tokens always follow the reschedule chain.",
  }),
})
const manageNotFound = error('Missing or unknown manage token (`booking_not_found`)')
const rateLimited = error('Too many requests from this address (`rate_limited`); see Retry-After')
const hostNotFound = error(
  'No such booking among those the caller hosts in this organization (`booking_not_found`)',
)
const unauthorized = error('No valid session or API key')
const keyRateLimited = error(
  "The API key's rate limit is used up (`rate_limited`); see Retry-After",
)
const hostRateLimited = error(
  "The caller's per-user limit or the API key's rate limit is used up (`rate_limited`); see Retry-After",
)
const crossOrigin = error(
  'A cookie-authenticated write that does not come from the app itself (`forbidden`)',
)
const invalidId = error('The id is not a UUID (`invalid_request`)')
const invalidCancel = error(
  'Invalid request (`invalid_request`), or a reason over 1000 characters or with control characters (`invalid_reason`)',
)

export interface BookingRoutesDeps {
  db: Db
  bookingMaxInviteeReschedules?: number | undefined
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
  now?: () => Temporal.Instant
  /** Queues the booking emails in the transaction of each change; none are sent without it. */
  notify?: BookingNotifier | undefined
  /** Replaces PUBLIC_RATE_LIMITS.manage (and .slots for the reschedule slots), e.g. in tests. */
  rateLimits?: Partial<Record<keyof typeof PUBLIC_RATE_LIMITS, RateLimit>>
  /** Per-user host limits, separate from invitee IP counters; defaults are 30/120 per minute. */
  hostRateLimits?: Partial<Record<'manage' | 'slots', RateLimit>>
}

/**
 * /api/v1/bookings: the invitee's manage endpoints (unauthenticated, token in the
 * X-Manage-Token header, rate limited per client IP) and the host's bookings
 * (authenticated, scoped to the caller's organization).
 */
export function bookingRoutes({
  db,
  bookingMaxInviteeReschedules,
  now = () => Temporal.Now.instant(),
  notify,
  automaticMeet,
  automaticZoom,
  rateLimits = {},
  hostRateLimits = {},
}: BookingRoutesDeps): RouteModule {
  const publicContext: PublicContext = {
    db,
    now,
    notify,
    automaticMeet,
    automaticZoom,
    bookingMaxInviteeReschedules,
  }
  const manageLimit = rateLimit(createRateLimiter(rateLimits.manage ?? PUBLIC_RATE_LIMITS.manage))
  // Picking a new time pages through months of slots, so it counts like public slots.
  const manageSlotsLimit = rateLimit(
    createRateLimiter(rateLimits.slots ?? PUBLIC_RATE_LIMITS.slots),
  )
  // Authentication must run first: these counters follow the user across sessions, keys,
  // organizations and IPs, without consuming the anonymous invitee's address budget.
  const hostLimit = (limit: RateLimit) => {
    const limiter = createRateLimiter(limit)
    return createMiddleware<CallerEnv>(async (c, next) => {
      const retryAfter = limiter.hit(c.var.principal.user.id)
      if (retryAfter !== undefined) {
        c.header('Retry-After', String(retryAfter))
        return c.json({ error: 'rate_limited' }, 429)
      }
      await next()
    })
  }
  const hostManageLimit = hostLimit(hostRateLimits.manage ?? PUBLIC_RATE_LIMITS.manage)
  const hostSlotsLimit = hostLimit(hostRateLimits.slots ?? PUBLIC_RATE_LIMITS.slots)

  return ({ app, caller }) => {
    // Tuples preserve caller's principal type through createRoute's middleware inference.
    const hostManage: [typeof caller, MiddlewareHandler<CallerEnv>] = [caller, hostManageLimit]
    const hostSlots: [typeof caller, MiddlewareHandler<CallerEnv>] = [caller, hostSlotsLimit]
    const context = (
      principal: ServiceContext['principal'],
      expectedOrganizationId?: string,
    ): ServiceContext => ({
      db,
      principal,
      now,
      notify,
      automaticMeet,
      automaticZoom,
      authorizeOrganizationWrite: bookingWriteAccess(principal, expectedOrganizationId),
    })

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/{id}/request-reschedule',
        operationId: 'requestReschedule',
        summary: 'Ask the invitee to choose another time',
        description:
          'For a confirmed future booking the caller hosts. Keeps the original slot booked while the invitee chooses through their manage link or cancels. A second request replaces the first. Imported and group-seat bookings are refused.',
        security: authenticated,
        middleware: hostManage,
        tags: ['Bookings'],
        request: {
          params: z.object({ id: z.uuid() }),
          headers: ExpectedOrganizationHeaders,
          body: { required: true, content: json(RequestRescheduleBody) },
        },
        responses: {
          200: {
            description: 'Booking with its outstanding request, or the current booking on replay',
            content: json(Booking),
          },
          400: error('Invalid input or note (`invalid_request`)'),
          401: unauthorized,
          403: crossOrigin,
          404: hostNotFound,
          409: error(
            'Booking cancelled, already started, imported read-only, group-seat unsupported, idempotency key reused or organization context changed',
          ),
          429: hostRateLimited,
        },
      }),
      async (c) =>
        c.json(
          await requestReschedule(
            context(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/{id}/conference/retry',
        operationId: 'retryBookingConference',
        security: authenticated,
        middleware: caller,
        tags: ['Bookings'],
        summary: 'Retry safe conference reconciliation for an assigned host',
        description:
          'A Google Meet conference_pending_timeout retry rechecks the same event and conference request without creating a replacement. Only an explicit conference_failed result permits a new request on that event.',
        request: {
          params: z.object({ id: z.uuid() }),
          headers: ExpectedOrganizationHeaders,
          body: { required: true, content: json(z.strictObject({})) },
        },
        responses: {
          204: { description: 'Durable reconciliation requested' },
          400: invalidId,
          401: unauthorized,
          403: crossOrigin,
          404: { description: 'No such booking or conference', content: json(ErrorBody) },
          409: {
            description: 'conference_not_retryable or organization_context_changed',
            content: json(ErrorBody),
          },
        },
      }),
      async (c) => {
        // Hono can skip JSON validation when Content-Type is absent. The documented
        // empty-object command still requires JSON, after authentication/CSRF checks.
        if (
          c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
          'application/json'
        )
          return c.json({ error: 'invalid_request', message: 'Send an empty JSON object.' }, 400)
        await retryBookingConference(
          context(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          c.req.valid('param').id,
        )
        return c.body(null, 204)
      },
    )
    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/{id}/calendar-copy/retry',
        operationId: 'retryBookingCalendarCopy',
        security: authenticated,
        middleware: caller,
        tags: ['Bookings'],
        summary: 'Reconcile my pinned ordinary calendar copy',
        request: {
          params: z.object({ id: z.uuid() }),
          headers: ExpectedOrganizationHeaders,
          body: { required: true, content: json(z.strictObject({})) },
        },
        responses: {
          204: { description: 'Durable copy reconciliation requested' },
          400: invalidId,
          401: unauthorized,
          403: crossOrigin,
          404: hostNotFound,
          409: error('calendar_copy_not_retryable or organization_context_changed'),
        },
      }),
      async (c) => {
        if (
          c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
          'application/json'
        )
          return c.json({ error: 'invalid_request', message: 'Send an empty JSON object.' }, 400)
        await retryConferenceMirror(
          context(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          c.req.valid('param').id,
        )
        return c.body(null, 204)
      },
    )
    // Registered before /api/v1/bookings/{id}…: Hono runs matching routes in registration
    // order, and "manage" would otherwise be taken for an id (and need a caller).
    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings/manage',
        summary: "The booking behind an invitee's manage token",
        middleware: manageLimit,
        request: { headers: ManageToken },
        responses: {
          200: {
            description: 'The booking, with its event type and hosts',
            content: json(ManagedBooking),
          },
          404: manageNotFound,
          429: rateLimited,
        },
      }),
      async (c) => {
        const booking = await getManagedBookingDetails(
          publicContext,
          c.req.valid('header')['x-manage-token'],
        )
        return c.json(booking, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings/manage/slots',
        summary: 'Times the booking can move to',
        description: `The slots the booking behind the manage token can be rescheduled to, fully inside [start, end]: its event type's slots with the booking itself ignored, so they may overlap its current time. The same range limits as public slots (at most ${MAX_SLOT_RANGE_DAYS} days).`,
        middleware: manageSlotsLimit,
        request: {
          headers: ManageToken,
          query: SlotRange,
        },
        responses: {
          200: {
            description: 'Slots, sorted by start',
            content: json(z.object({ data: z.array(Slot) })),
          },
          400: error(
            'Invalid parameters (`invalid_request`), a length outside the allowed list (`invalid_duration`), end not after start (`invalid_range`), or a range that is too long (`range_too_long`)',
          ),
          404: manageNotFound,
          409: error(
            'Already cancelled (`booking_cancelled`), the invitee reschedule limit is reached (`booking_reschedule_limit`), already started (`booking_in_past`), the event type no longer takes bookings (`event_type_unavailable`) or the booking has no host (`booking_has_no_host`)',
          ),
          429: rateLimited,
        },
      }),
      async (c) => {
        const { start, end, durationMinutes } = c.req.valid('query')
        const slots = await listManagedSlots(
          publicContext,
          c.req.valid('header')['x-manage-token'],
          {
            start: Temporal.Instant.from(start),
            end: Temporal.Instant.from(end),
            durationMinutes,
          },
        )
        return c.json({ data: slots }, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/manage/cancel',
        operationId: 'cancelManagedBooking',
        summary: 'Cancel with the manage token',
        middleware: manageLimit,
        request: {
          headers: ManageToken,
          body: { content: json(ManagedCancelBody), required: false },
        },
        responses: {
          200: { description: 'The cancelled booking', content: json(Booking) },
          400: invalidCancel,
          404: manageNotFound,
          409: error(
            "Already cancelled (`booking_cancelled`), already started (`booking_in_past`), or, with an email's token, the meeting kept being rescheduled while the request waited (`booking_changed`; try again)",
          ),
          429: rateLimited,
        },
      }),
      async (c) => {
        const { reason, rescheduleRequestId } =
          (c.req.valid('json') as z.infer<typeof ManagedCancelBody> | undefined) ?? {}
        const booking = await cancelManagedBooking(
          publicContext,
          c.req.valid('header')['x-manage-token'],
          { reason, rescheduleRequestId },
          publicBookingAuditOrigin(c),
        )
        return c.json(booking, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/manage/reschedule',
        operationId: 'rescheduleManagedBooking',
        summary: 'Reschedule with the manage token',
        description:
          'Cancels the booking and books the new time in one step. The new time may overlap the old one. Returns the new booking and its manage token. Invitee moves are limited across the entire chain (default five); reaching the instance limit returns 409 `booking_reschedule_limit`, while cancellation stays available. Host moves do not consume that limit. The token returned for the old booking then shows the cancelled booking, so a retry after a lost response gets 409 `booking_cancelled`; tokens from booking emails open the new booking (and would move it again).',
        middleware: manageLimit,
        request: {
          headers: ManageToken,
          body: {
            content: json(ManagedRescheduleBody),
            required: true,
          },
        },
        responses: {
          200: { description: 'The new booking', content: json(BookingWithToken) },
          400: error(
            'Invalid request (`invalid_request`) or length outside the allowed list (`invalid_duration`)',
          ),
          404: manageNotFound,
          409: error(
            "Already cancelled (`booking_cancelled`), the invitee reschedule limit is reached (`booking_reschedule_limit`), already started (`booking_in_past`), without a host (`booking_has_no_host`), the event type no longer takes bookings (`event_type_unavailable`), the time is not offered (`slot_unavailable`, `slot_taken`), or, with an email's token, the meeting kept being rescheduled while the request waited (`booking_changed`; try again)",
          ),
          429: rateLimited,
        },
      }),
      async (c) => {
        const result = await rescheduleManagedBooking(
          publicContext,
          c.req.valid('header')['x-manage-token'],
          {
            start: Temporal.Instant.from(c.req.valid('json').start),
            durationMinutes: c.req.valid('json').durationMinutes,
            rescheduleRequestId: c.req.valid('json').rescheduleRequestId,
          },
          publicBookingAuditOrigin(c),
        )
        return c.json(result, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings/{id}/slots',
        summary: 'Times a booking the caller hosts can move to',
        description: `The same reschedule slots as the invitee sees, with the current booking ignored so a new time may overlap it. The caller must host this booking in their acting organization. The range is at most ${MAX_SLOT_RANGE_DAYS} days.`,
        security: authenticated,
        middleware: hostSlots,
        request: {
          params: z.object({ id: z.uuid() }),
          query: SlotRange,
        },
        responses: {
          200: {
            description: 'Slots, sorted by start',
            content: json(z.object({ data: z.array(Slot) })),
          },
          400: error(
            'Invalid parameters (`invalid_request`, `invalid_duration`, `invalid_range`, `range_too_long`)',
          ),
          401: unauthorized,
          404: hostNotFound,
          409: error(
            'Already cancelled (`booking_cancelled`), already started (`booking_in_past`), the event type no longer takes bookings (`event_type_unavailable`), or required hosts are unavailable (`booking_has_no_host`, `booking_hosts_unavailable`)',
          ),
          429: hostRateLimited,
        },
      }),
      async (c) => {
        const { start, end, durationMinutes } = c.req.valid('query')
        const slots = await listHostBookingSlots(
          context(c.var.principal),
          c.req.valid('param').id,
          {
            start: Temporal.Instant.from(start),
            end: Temporal.Instant.from(end),
            durationMinutes,
          },
        )
        return c.json({ data: slots }, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/{id}/reschedule',
        operationId: 'rescheduleHostBooking',
        summary: 'Reschedule a booking the caller hosts',
        description:
          'Cancels the old booking and creates its successor in one transaction. The caller must host the booking in their acting organization. Invitee links keep working, and manageToken is always null: host authority does not reveal an invitee bearer secret. Retrying the old id gets booking_cancelled.',
        security: authenticated,
        middleware: hostManage,
        request: {
          params: z.object({ id: z.uuid() }),
          headers: ExpectedOrganizationHeaders,
          body: { content: json(RescheduleBody), required: true },
        },
        responses: {
          200: {
            description: 'The successor booking, with manageToken null',
            content: json(BookingWithToken),
          },
          400: error(
            'Invalid request (`invalid_request`) or length outside the allowed list (`invalid_duration`)',
          ),
          401: unauthorized,
          403: crossOrigin,
          404: hostNotFound,
          409: error(
            'Already cancelled (`booking_cancelled`), already started (`booking_in_past`), the event type no longer takes bookings (`event_type_unavailable`), required hosts are unavailable (`booking_has_no_host`, `booking_hosts_unavailable`), the time is not offered (`slot_unavailable`, `slot_taken`), or the browser organization context changed (`organization_context_changed`)',
          ),
          429: hostRateLimited,
        },
      }),
      async (c) => {
        const result = await rescheduleHostBooking(
          context(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          c.req.valid('param').id,
          {
            start: Temporal.Instant.from(c.req.valid('json').start),
            durationMinutes: c.req.valid('json').durationMinutes,
          },
        )
        return c.json(result, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings',
        summary: 'Bookings the caller hosts',
        description:
          'Bookings in the organization the caller acts in where the caller is a host, ordered by start time and id, ascending by default. Use order=desc for newest first. Paginated with a cursor: pass `nextCursor` from one page as `cursor` for the next (keep the other parameters, including order, the same).',
        security: authenticated,
        middleware: caller,
        request: { query: ListBookingsQuery },
        responses: {
          200: { description: 'A page of bookings', content: json(BookingPage) },
          400: error('Invalid parameters (`invalid_request`, `invalid_range`, `invalid_cursor`)'),
          401: unauthorized,
          429: keyRateLimited,
        },
      }),
      async (c) => {
        const q = c.req.valid('query')
        const page = await listHostBookings(context(c.var.principal), {
          order: q.order,
          from: q.from === undefined ? undefined : Temporal.Instant.from(q.from),
          to: q.to === undefined ? undefined : Temporal.Instant.from(q.to),
          endAfter: q.endAfter === undefined ? undefined : Temporal.Instant.from(q.endAfter),
          endTo: q.endTo === undefined ? undefined : Temporal.Instant.from(q.endTo),
          status: q.status,
          limit: q.limit,
          cursor: q.cursor,
        })
        return c.json(page, 200)
      },
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings/export.csv',
        operationId: 'exportBookingsCsv',
        summary: 'Download bookings as CSV',
        description:
          'Personal owners keep the full column set with a browser session or read/full API key. Team owners/admins require a current verified browser session; API keys and OAuth cannot export teams. Team columns follow the team-admin read whitelist: no booking title, custom answers, location, source, created_at or host email addresses. A repeatable-read snapshot streams 100-row keyset pages; one export per organization and BOOKING_EXPORT_MAX_CONCURRENT per process (default 2), a 30-second stalled-reader timeout and five-minute deadline. Required [from,to) start range at most 366 days. UTF-8 without BOM by default; bom=true supports Excel. Personal JSON answers retain stable question IDs. Contains personal data; keep downloaded files private.',
        security: authenticated,
        middleware: caller,
        request: {
          query: ListBookingsQuery.omit({ limit: true, cursor: true })
            .extend({
              from: Instant,
              to: Instant,
              timeZone: z.string().optional(),
              eventTypeId: z.uuid().optional(),
              hostUserId: z.uuid().optional(),
              expectedOrganizationId: z.uuid().optional(),
              bom: z.enum(['true', 'false']).optional(),
            })
            .strict(),
        },
        responses: {
          200: {
            description: 'CSV download with RFC 4180 quoting and formula protection',
            content: { 'text/csv': { schema: z.string() } },
          },
          400: error('Invalid export filters or range'),
          401: unauthorized,
          403: error(
            'Personal ownership or verified browser team-admin access required; team_management_access_denied for team agent credentials',
          ),
          409: error(
            'export_busy when the process cap is reached, export_in_progress for an active organization export, or organization_context_changed',
          ),
          429: keyRateLimited,
        },
      }),
      async (c) => {
        const q = c.req.valid('query')
        const body = await exportBookingsCsv(
          context(c.var.principal),
          { ...q, bom: q.bom === 'true' },
          c.req.raw.signal,
        )
        return new Response(body, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="bookings.csv"',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        })
      },
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings/{id}/organization',
        summary: 'Resolve the space of a booking visible to the browser session',
        description:
          'Read-only browser handoff. Rechecks the verified live session and membership in the booking space. Only a booked host or a team owner/admin receives its organization and access kind. Everyone else receives uniform booking_not_found. API keys and OAuth grants cannot resolve other spaces. Does not switch the session or grant host authority.',
        security: [{ session: [] }],
        middleware: caller,
        request: { params: z.object({ id: z.uuid() }) },
        responses: {
          200: {
            description: 'Authorized booking space',
            content: json(
              z.object({
                organizationId: z.uuid(),
                access: z.enum(['host', 'team_admin']),
              }),
            ),
          },
          400: invalidId,
          401: unauthorized,
          404: hostNotFound,
          429: keyRateLimited,
        },
      }),
      async (c) =>
        c.json(
          await resolveBookingOrganization(context(c.var.principal), c.req.valid('param').id),
          200,
        ),
    )

    app.openapi(
      createRoute({
        method: 'get',
        path: '/api/v1/bookings/{id}',
        summary: 'A booking the caller hosts',
        security: authenticated,
        middleware: caller,
        request: { params: z.object({ id: z.uuid() }) },
        responses: {
          200: { description: 'The booking', content: json(Booking) },
          400: invalidId,
          401: unauthorized,
          404: hostNotFound,
          429: keyRateLimited,
        },
      }),
      async (c) =>
        c.json(await getHostBooking(context(c.var.principal), c.req.valid('param').id), 200),
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/api/v1/bookings/{id}/cancel',
        operationId: 'cancelHostBooking',
        summary: 'Cancel a booking the caller hosts',
        security: authenticated,
        middleware: caller,
        request: {
          params: z.object({ id: z.uuid() }),
          headers: ExpectedOrganizationHeaders,
          body: { content: json(CancelBody), required: false },
        },
        responses: {
          200: { description: 'The cancelled booking', content: json(Booking) },
          400: invalidCancel,
          401: unauthorized,
          403: crossOrigin,
          404: hostNotFound,
          409: error(
            'Already cancelled (`booking_cancelled`), already started (`booking_in_past`), or the browser organization context changed (`organization_context_changed`)',
          ),
          429: keyRateLimited,
        },
      }),
      async (c) => {
        const { reason } = (c.req.valid('json') as z.infer<typeof CancelBody> | undefined) ?? {}
        const booking = await cancelHostBooking(
          context(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          c.req.valid('param').id,
          { reason },
        )
        return c.json(booking, 200)
      },
    )
  }
}
