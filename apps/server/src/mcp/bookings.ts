// Booking tools: the same services, schemas and rules as the REST booking routes
// (routes/public.ts, routes/bookings.ts), shaped for agents.
import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  type BookingNotifier,
  type BookingOrigin,
  cancelHostBooking,
  cancelManagedBooking,
  createPublicBooking,
  DomainError,
  getPublicEventType,
  listHostBookings,
  listPublicSlots,
  MAX_SLOT_RANGE_DAYS,
  type PublicContext,
  rescheduleManagedBooking,
  type ServiceContext,
  validTimeZone,
} from '@hourmere/scheduling'
import { createRateLimiter, PUBLIC_RATE_LIMITS, type RateLimit } from '../rate-limit.ts'
import {
  Booking,
  BookingPage,
  BookingWithToken,
  CancelBody,
  Instant,
  ListBookingsQuery,
} from '../routes/bookings.ts'
import { CreateBooking, PageParams, PublicEventType, Slot } from '../routes/public.ts'
import { defineTool, type McpCaller, type Tool } from './tools.ts'

const handle = PageParams.shape.handle.openapi({
  description:
    "The host's handle: the first path segment of their booking link https://<host>/<handle>/<slug>",
})
const slug = PageParams.shape.slug.openapi({
  description: 'The event type: the second path segment of the booking link',
})

const manageToken = z.string().openapi({
  description:
    "The manageToken that create_booking or reschedule_booking returned for this booking, or the token in a link from one of the invitee's booking emails (https://<host>/booking#token=<token>). A token from an email follows the meeting when it is rescheduled; one returned by a tool stays with its booking.",
})

/** RFC 3339 with the zone's offset, e.g. 2026-11-02T10:00:00+01:00. */
const localTime = (iso: string, timeZone: string) =>
  Temporal.Instant.from(iso)
    .toZonedDateTimeISO(timeZone)
    .toString({ timeZoneName: 'never', fractionalSecondDigits: 0 })

const FindSlotsInput = z.strictObject({
  handle,
  slug,
  timeZone: z.string().min(1).max(64).openapi({
    description:
      'IANA time zone name, e.g. Europe/Berlin or America/New_York (numeric offsets such as +01:00 are refused: they ignore daylight saving time). startDate and endDate are days in this zone, and each slot is also given in it. Use the time zone of the person you are booking for.',
    example: 'Europe/Berlin',
  }),
  startDate: z.iso.date().openapi({ description: 'First day to search, YYYY-MM-DD in timeZone' }),
  endDate: z.iso.date().openapi({
    description: `Last day to search (inclusive), YYYY-MM-DD in timeZone; at most ${MAX_SLOT_RANGE_DAYS} days in all`,
  }),
})

const LocalSlot = Slot.extend({
  localStart: z.string().openapi({
    description: 'start in the requested timeZone, RFC 3339 with its UTC offset',
  }),
  localEnd: z.string().openapi({
    description: 'end in the requested timeZone, RFC 3339 with its UTC offset',
  }),
})

const FindSlotsOutput = z.object({
  eventType: PublicEventType,
  timeZone: z.string().openapi({
    description:
      'The requested time zone, with its letter case normalized (europe/berlin → Europe/Berlin)',
  }),
  slots: z.array(LocalSlot).openapi({
    description:
      "Bookable slots, sorted by start. Pass a slot's `start` unchanged to create_booking.",
  }),
})

// The REST body's fields, after the page they belong to.
const CreateBookingInput = z.strictObject({
  handle,
  slug,
  ...CreateBooking.shape,
  start: CreateBooking.shape.start.openapi({
    description: 'The exact `start` of a slot from find_available_slots, unchanged',
  }),
  idempotencyKey: z.string().optional().openapi({
    description:
      'Makes retries safe: a retry with the same key and the same arguments returns the original booking (replayed: true, manageToken null) instead of booking again; the same key with different arguments fails with idempotency_key_reused. Use a new random value (e.g. a UUIDv4) per booking; 1–255 printable ASCII characters. Keys are scoped to your API key.',
  }),
})

const CreateBookingOutput = BookingWithToken.extend({
  replayed: z.boolean().openapi({
    description:
      'True when an earlier call with the same idempotencyKey made this booking (manageToken is then null)',
  }),
})

const RescheduleInput = z.strictObject({
  manageToken,
  start: Instant.openapi({
    description:
      'The new start: the exact `start` of a slot from find_available_slots for the same event type',
  }),
})

const CancelInput = CancelBody.extend({
  bookingId: z.uuid().optional().openapi({
    description: 'Cancel as the host: the id of a booking you host (see list_bookings)',
  }),
  manageToken: manageToken.optional(),
  reason: CancelBody.shape.reason.openapi({
    description: 'Why the booking is cancelled, kept with it; at most 1000 characters',
  }),
}).refine((v) => (v.bookingId === undefined) !== (v.manageToken === undefined), {
  message:
    'Give exactly one of bookingId (to cancel as the host) or manageToken (to cancel as the invitee)',
})

const ListBookingsInput = z.strictObject(ListBookingsQuery.shape)

export interface BookingToolsDeps {
  db: Db
  now?: () => Temporal.Instant
  /** Queues the booking emails in the transaction of each change, as for REST. */
  notify?: BookingNotifier | undefined
  /**
   * Per-user limits for the tools that act on public booking pages; defaults to the public
   * endpoints' per-address limits (PUBLIC_RATE_LIMITS). Replaced in tests.
   */
  rateLimits?: Partial<Record<keyof typeof PUBLIC_RATE_LIMITS, RateLimit>>
}

/**
 * Tools for booking someone's public event type (as the invitee, like the booking page)
 * and for the bookings the caller hosts. Tools that act on public pages are limited per
 * user (all of their API keys together) with the numbers the public endpoints apply per
 * address: an agent behind a shared address (a hosted assistant) is not throttled by other
 * people's agents, and a person gets no more through agents than the booking page gives.
 */
export function bookingTools({
  db,
  now = () => Temporal.Now.instant(),
  notify,
  rateLimits = {},
}: BookingToolsDeps): Tool[] {
  const pub: PublicContext = { db, now, notify }
  const context = (caller: McpCaller): ServiceContext => ({ db, principal: caller, now, notify })
  const origin = (caller: McpCaller): BookingOrigin => ({
    source: 'mcp',
    apiKeyId: caller.apiKeyId,
  })
  const limiter = (group: keyof typeof PUBLIC_RATE_LIMITS) =>
    createRateLimiter(rateLimits[group] ?? PUBLIC_RATE_LIMITS[group])
  const slotsLimit = limiter('slots')
  const bookLimit = limiter('book')
  const manageLimit = limiter('manage')

  const findAvailableSlots = defineTool({
    name: 'find_available_slots',
    title: 'Find available slots',
    description: `Lists the times someone's event type can be booked between two dates, and the event type itself (title, duration, location kind, the questions its booking form asks, and the host's time zone). Use it before create_booking or reschedule_booking. The event type is identified by its booking link https://<host>/<handle>/<slug>. Each slot is given in UTC (start, end) and in the requested timeZone (localStart, localEnd); pass start unchanged to create_booking. Search a few days at a time (at most ${MAX_SLOT_RANGE_DAYS} days): long searches return long lists.`,
    input: FindSlotsInput,
    output: FindSlotsOutput,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run(args, call) {
      call.rateLimit(slotsLimit)
      const timeZone = validTimeZone(args.timeZone)
      const first = Temporal.PlainDate.from(args.startDate)
      const last = Temporal.PlainDate.from(args.endDate)
      if (Temporal.PlainDate.compare(last, first) < 0) {
        throw new DomainError('invalid', 'invalid_range', 'endDate must not be before startDate')
      }
      if (first.until(last).days >= MAX_SLOT_RANGE_DAYS) {
        throw new DomainError(
          'invalid',
          'range_too_long',
          `Search at most ${MAX_SLOT_RANGE_DAYS} days at a time`,
        )
      }
      const start = first.toZonedDateTime(timeZone).toInstant()
      // Midnight after the last day. A daylight saving change can make the days an hour
      // longer than the service's limit; that hour is cut from the end of the range.
      const nextDay = last.add({ days: 1 }).toZonedDateTime(timeZone).toInstant()
      const longest = start.add({ hours: MAX_SLOT_RANGE_DAYS * 24 })
      const end = Temporal.Instant.compare(nextDay, longest) > 0 ? longest : nextDay
      const eventType = await getPublicEventType(pub, args)
      const slots = await listPublicSlots(pub, { handle: args.handle, slug: args.slug, start, end })
      return {
        eventType,
        timeZone,
        slots: slots.map((s) => ({
          ...s,
          localStart: localTime(s.start, timeZone),
          localEnd: localTime(s.end, timeZone),
        })),
      }
    },
  })

  const createBooking = defineTool({
    name: 'create_booking',
    title: 'Create a booking',
    description:
      "Books a slot of someone's event type for an invitee, as their booking page would. start must be the exact start of a slot find_available_slots returned. Answer the event type's questions in responses, keyed by question id (required ones must be answered). Returns the booking and its manageToken: keep the token, it is shown only this once and is what reschedule_booking and cancel_booking need to act as the invitee. Fails with slot_unavailable if the time is not offered and slot_taken if someone else just booked it; then pick another slot. Pass an idempotencyKey so that a retry after a lost response cannot book twice.",
    input: CreateBookingInput,
    output: CreateBookingOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async run(args, call) {
      call.rateLimit(bookLimit)
      const { replayed, ...result } = await createPublicBooking(
        pub,
        {
          handle: args.handle,
          slug: args.slug,
          start: Temporal.Instant.from(args.start),
          invitee: args.invitee,
          guests: args.guests,
          responses: args.responses,
          idempotencyKey: args.idempotencyKey,
        },
        origin(call.caller),
      )
      return { ...result, replayed }
    },
  })

  const rescheduleBooking = defineTool({
    name: 'reschedule_booking',
    title: 'Reschedule a booking',
    description:
      'Moves a booking you made (as the invitee) to a new time, using its manageToken. In one step the booking is cancelled and a new one is created at start, with the same invitee, guests and answers; the new time may overlap the old one. Returns the new booking and its new manageToken (the token returned for the old booking then belongs to the cancelled booking; tokens from emails follow the meeting to the new one). Not idempotent: with a token a tool returned, a retry after a lost response fails with booking_cancelled, because the booking has already moved; with a token from an email it would move the meeting again. Fails with booking_in_past once the meeting has started.',
    input: RescheduleInput,
    output: BookingWithToken,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async run(args, call) {
      call.rateLimit(manageLimit)
      return rescheduleManagedBooking(
        pub,
        args.manageToken,
        { start: Temporal.Instant.from(args.start) },
        origin(call.caller),
      )
    },
  })

  const cancelBooking = defineTool({
    name: 'cancel_booking',
    title: 'Cancel a booking',
    description:
      'Cancels a booking that has not started yet: either one you host, by bookingId, or one you made as the invitee, by its manageToken (give exactly one). Returns the cancelled booking. Cancelling cannot be undone; a booking that is already cancelled fails with booking_cancelled, one that has started with booking_in_past.',
    input: CancelInput,
    output: Booking,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    async run(args, call) {
      if (args.bookingId !== undefined) {
        return cancelHostBooking(context(call.caller), args.bookingId, { reason: args.reason })
      }
      call.rateLimit(manageLimit)
      return cancelManagedBooking(pub, args.manageToken, { reason: args.reason })
    },
  })

  const listBookings = defineTool({
    name: 'list_bookings',
    title: 'List my bookings',
    description:
      "Lists bookings you host (you: the API key's user, see whoami) in the organization the key acts in, ordered by start time, a page at a time. Filter by start time (from inclusive, to exclusive, RFC 3339) and status. When nextCursor is not null, call again with it as cursor and the same filters for the next page. Times are UTC; each attendee has their own timeZone.",
    input: ListBookingsInput,
    output: BookingPage,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run(args, call) {
      return listHostBookings(context(call.caller), {
        from: args.from === undefined ? undefined : Temporal.Instant.from(args.from),
        to: args.to === undefined ? undefined : Temporal.Instant.from(args.to),
        status: args.status,
        limit: args.limit,
        cursor: args.cursor,
      })
    },
  })

  return [findAvailableSlots, createBooking, rescheduleBooking, cancelBooking, listBookings]
}
