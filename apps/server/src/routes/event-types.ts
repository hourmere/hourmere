import { createRoute, z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import { EVENT_TYPE_RULE_BOUNDS, MAX_ALLOWED_DURATIONS } from '@hourmere/core'
import {
  activateRoundRobin,
  createEventType,
  deleteEventType,
  EVENT_TYPE_LIMITS,
  getEventType,
  listEventTypeHosts,
  listEventTypes,
  MAX_OPTION_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTION_LABEL,
  MAX_QUESTIONS,
  NotificationSettingsSchema,
  PHONE_NUMBER_PATTERN,
  QuestionSchema,
  type EventType as ServiceEventType,
  SLUG_PATTERN,
  updateEventType,
} from '@hourmere/scheduling'
import {
  authenticated,
  CROSS_ORIGIN_WRITE,
  callerWithBodyLimit,
  errorResponses,
  json,
  Question,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'
import {
  EXPECTED_ORGANIZATION_HEADER,
  ORGANIZATION_CONTEXT_CHANGED,
  organizationWriteAccess,
} from '../team-management.ts'

// Schemas check the JSON shape (400 invalid_request); the service checks values (the rule
// bounds are the availability engine's) and answers with specific codes, the same for REST
// and MCP. Limits are documented here.
//
// Request bodies are strict (a misspelled field is an error, not ignored); responses are
// open, because fields may be added to them within /api/v1.

const L = EVENT_TYPE_LIMITS

// Redirect configuration is service-only until its REST/MCP/CLI contract is introduced.
const eventTypeResponse = ({ successRedirect: _successRedirect, ...eventType }: ServiceEventType) =>
  eventType

const locationKinds = {
  googleMeet: { kind: z.literal('google_meet'), autoCreate: z.literal(true).optional() },
  zoom: { kind: z.literal('zoom'), autoCreate: z.literal(true).optional() },
  phone: {
    kind: z.literal('phone'),
    number: z.string().openapi({
      description: "The host's number in E.164",
      pattern: PHONE_NUMBER_PATTERN.source,
      example: '+14155550123',
    }),
  },
  inPerson: {
    kind: z.literal('in_person'),
    address: z.string().openapi({ minLength: 1, maxLength: L.addressMaxLength }),
  },
  link: {
    kind: z.literal('link'),
    url: z.string().openapi({
      description: 'An http or https URL, stored as parsed (normalized)',
      format: 'uri',
      maxLength: L.urlMaxLength,
    }),
  },
}
const locationDoc = {
  description:
    'Where the meeting happens, by kind; Meet and Zoom links are generated per booking. null = not set.',
}
// Not named components: zod-to-openapi would add the null of `.nullable()` to the
// component itself, and flattens a union with null.
const Location = z
  .discriminatedUnion('kind', [
    z.object(locationKinds.googleMeet),
    z.object(locationKinds.zoom),
    z.object(locationKinds.phone),
    z.object(locationKinds.inPerson),
    z.object(locationKinds.link),
  ])
  .nullable()
  .openapi(locationDoc)
const LocationInput = z
  .discriminatedUnion('kind', [
    z.strictObject(locationKinds.googleMeet),
    z.strictObject(locationKinds.zoom),
    z.strictObject(locationKinds.phone),
    z.strictObject(locationKinds.inPerson),
    z.strictObject(locationKinds.link),
  ])
  .nullable()
  .openapi(locationDoc)

// Questions: responses show the shared Question component (openapi.ts). Writes are checked
// for shape here and as a whole by validateQuestions in the service (400 invalid_questions),
// so this schema takes its types and limits from questions.ts but enforces only the shape.
const QuestionInput = z
  .strictObject({
    id: z.string().openapi({
      description:
        'Unique within the event type; answers are stored under it. 1–64 letters, digits, "_" or "-", not __proto__.',
      maxLength: 64,
      example: 'company',
    }),
    label: z.string().openapi({ minLength: 1, maxLength: MAX_QUESTION_LABEL }),
    type: QuestionSchema.shape.type,
    required: z.boolean().optional().openapi({ default: false }),
    options: z
      .array(z.string().openapi({ minLength: 1, maxLength: MAX_OPTION_LENGTH }))
      .optional()
      .openapi({
        description: 'The distinct choices; only (and required) for select and multi_select',
        minItems: 1,
        maxItems: MAX_OPTIONS,
      }),
  })
  .openapi('QuestionInput', {
    description: 'A booking-form field beyond name and email, as written (see Question)',
  })

// Keep the shared transport shape; bounds and normalization are service validation so
// every interface returns invalid_notifications for the same values.
const notificationRule = NotificationSettingsSchema.shape.reminders.element
const notificationFields = {
  id: z.string().openapi({
    description: 'Stable rule ID, unique across reminders and followUps; __proto__ is reserved',
    minLength: 1,
    maxLength: 64,
    pattern: '^[A-Za-z0-9_-]+$',
  }),
  offsetMinutes: z.number().openapi({
    description: 'Elapsed minutes before the meeting starts or after it ends',
    type: 'integer',
    minimum: 5,
    maximum: 43200,
  }),
  recipients: z.strictObject(notificationRule.shape.recipients.shape).openapi({
    description: 'All flags are required; at least one must be true',
  }),
}
const followUpNote = z.string().optional().openapi({
  description:
    'Optional plain text, follow-ups only. At most 2000 UTF-16 code units after CRLF normalization and bidi-control removal; controls other than LF are refused. Placeholders are literal. Operators can disable host notes.',
  maxLength: 2000,
})
const notificationsDescription =
  'Complete email settings for future new bookings only; existing bookings and reschedules keep their snapshot. IDs are unique across both arrays, offsets are distinct within each array. Reminders return by descending offset, follow-ups ascending. Omitted on creation = one 24-hour reminder to all roles and no follow-ups; omitted on update = unchanged. Empty arrays disable both categories.'
const NotificationSettingsInput = z
  .strictObject({
    reminders: z.array(z.strictObject(notificationFields)).openapi({ maxItems: 5 }),
    followUps: z
      .array(z.strictObject({ ...notificationFields, hostNote: followUpNote }))
      .openapi({ maxItems: 3 }),
  })
  .openapi('EventTypeNotificationsInput', { description: notificationsDescription })
const responseNotificationFields = {
  ...notificationFields,
  recipients: z.object(notificationRule.shape.recipients.shape),
}
const NotificationSettings = z
  .object({
    reminders: z.array(z.object(responseNotificationFields)).openapi({ maxItems: 5 }),
    followUps: z
      .array(z.object({ ...responseNotificationFields, hostNote: followUpNote }))
      .openapi({ maxItems: 3 }),
  })
  .openapi('EventTypeNotifications', { description: notificationsDescription })

const rule = (name: keyof typeof EVENT_TYPE_RULE_BOUNDS, description: string) =>
  z.int().openapi({ description, ...minMax(EVENT_TYPE_RULE_BOUNDS[name]) })
const minMax = ({ min, max }: { min: number; max: number }) => ({ minimum: min, maximum: max })

const fields = {
  slug: z.string().openapi({
    description:
      'The last part of the booking URL, unique on its page: lowercase letters, digits and hyphens, starting and ending with a letter or digit',
    pattern: SLUG_PATTERN.source,
    maxLength: L.slugMaxLength,
    example: 'intro-call',
  }),
  title: z.string().openapi({ minLength: 1, maxLength: L.titleMaxLength, example: 'Intro call' }),
  description: z.string().nullable().openapi({ maxLength: L.descriptionMaxLength }),
  durationMinutes: rule('durationMinutes', 'Default length of a meeting'),
  allowedDurationsMinutes: z.array(rule('durationMinutes', 'Permitted meeting length')).openapi({
    description:
      'Distinct permitted lengths, including durationMinutes; omitted on creation = [durationMinutes]',
    minItems: 1,
    maxItems: MAX_ALLOWED_DURATIONS,
    uniqueItems: true,
  }),
  slotStepMinutes: rule(
    'slotStepMinutes',
    'Distance between start times; null = the selected duration',
  ).nullable(),
  bufferBeforeMinutes: rule('bufferBeforeMinutes', 'Free time kept before a meeting'),
  bufferAfterMinutes: rule('bufferAfterMinutes', 'Free time kept after a meeting'),
  minimumNoticeMinutes: rule('minimumNoticeMinutes', 'How far ahead a meeting must be booked'),
  bookingWindowDays: rule(
    'bookingWindowDays',
    'How many days ahead can be booked; null = no limit',
  ).nullable(),
  maxBookingsPerDay: rule(
    'maxBookingsPerDay',
    "Bookings per host's day; null = no limit",
  ).nullable(),
  location: Location,
  allowGuests: z.boolean().openapi({
    description:
      'Whether new bookings may add up to ten guest email recipients; existing booking attendees are preserved',
  }),
  isActive: z.boolean().openapi({ description: 'Whether invitees can book it' }),
  isHidden: z.boolean().openapi({
    description:
      'Hidden from public listings; anyone with the direct link can still book it. This is not access control.',
  }),
  position: z.int().openapi({
    description: 'Order on the page, ascending',
    ...minMax({ min: L.positionMin, max: L.positionMax }),
  }),
  scheduleId: z.string().nullable().openapi({
    description: "One of the host's schedules; null = the host's default schedule",
    format: 'uuid',
  }),
}

export const EventType = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    ownerUserId: z.uuid().nullable().openapi({
      description: 'The user whose personal page lists it; null for a team event type',
    }),
    ...fields,
    schedulingType: z.enum(['individual', 'round_robin', 'collective']),
    roundRobinActive: z
      .boolean()
      .openapi({ description: 'Explicit round-robin activation; metadata saves never enable it' }),
    hosts: z.array(z.object({ userId: z.uuid() })).max(8),
    conferenceOrganizer: z.object({ userId: z.uuid() }).nullable(),
    zoomConnectionId: z.uuid().nullable().optional(),
    questions: z.array(Question),
    notifications: NotificationSettings,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('EventType')

const questions = z
  .array(QuestionInput)
  .openapi({ description: 'Extra booking-form fields', maxItems: MAX_QUESTIONS })

const EventTypeInput = z
  .strictObject({
    slug: fields.slug,
    title: fields.title,
    durationMinutes: fields.durationMinutes,
    allowedDurationsMinutes: fields.allowedDurationsMinutes.optional(),
    description: fields.description.optional(),
    slotStepMinutes: fields.slotStepMinutes.optional(),
    bufferBeforeMinutes: fields.bufferBeforeMinutes.optional().openapi({ default: 0 }),
    bufferAfterMinutes: fields.bufferAfterMinutes.optional().openapi({ default: 0 }),
    minimumNoticeMinutes: fields.minimumNoticeMinutes.optional().openapi({ default: 0 }),
    bookingWindowDays: fields.bookingWindowDays.optional(),
    maxBookingsPerDay: fields.maxBookingsPerDay.optional(),
    location: LocationInput.optional(),
    conferenceOrganizer: z.strictObject({ userId: z.string() }).nullable().optional(),
    zoomConnectionId: z.string().nullable().optional(),
    questions: questions.optional(),
    notifications: NotificationSettingsInput.optional(),
    isActive: fields.isActive.optional().openapi({ default: true }),
    isHidden: fields.isHidden.optional().openapi({ default: false }),
    allowGuests: fields.allowGuests.optional().openapi({ default: false }),
    position: fields.position.optional().openapi({ default: 0 }),
    scheduleId: fields.scheduleId.optional(),
    schedulingType: z.enum(['individual', 'collective', 'round_robin']).optional(),
    hosts: z
      .array(z.strictObject({ userId: z.string() }))
      .optional()
      .openapi({ minItems: 1, maxItems: 8 }),
  })
  .openapi('EventTypeInput')

const EventTypeUpdate = z
  .strictObject({
    slug: fields.slug.optional(),
    title: fields.title.optional(),
    durationMinutes: fields.durationMinutes.optional(),
    allowedDurationsMinutes: fields.allowedDurationsMinutes.optional(),
    description: fields.description.optional(),
    slotStepMinutes: fields.slotStepMinutes.optional(),
    bufferBeforeMinutes: fields.bufferBeforeMinutes.optional(),
    bufferAfterMinutes: fields.bufferAfterMinutes.optional(),
    minimumNoticeMinutes: fields.minimumNoticeMinutes.optional(),
    bookingWindowDays: fields.bookingWindowDays.optional(),
    maxBookingsPerDay: fields.maxBookingsPerDay.optional(),
    location: LocationInput.optional(),
    conferenceOrganizer: z.strictObject({ userId: z.string() }).nullable().optional(),
    zoomConnectionId: z.string().nullable().optional(),
    questions: questions.optional(),
    notifications: NotificationSettingsInput.optional(),
    isActive: fields.isActive.optional(),
    isHidden: fields.isHidden.optional(),
    allowGuests: fields.allowGuests.optional(),
    position: fields.position.optional(),
    scheduleId: fields.scheduleId.optional(),
    schedulingType: z.enum(['individual', 'collective', 'round_robin']).optional(),
    hosts: z
      .array(z.strictObject({ userId: z.string() }))
      .optional()
      .openapi({ minItems: 1, maxItems: 8 }),
  })
  .openapi('EventTypeUpdate', {
    description: 'Omitted fields stay as they are; null clears a nullable field',
  })

const EventTypeList = z.object({ data: z.array(EventType) }).openapi('EventTypeList')

const IdParams = z.object({ id: z.string().openapi({ format: 'uuid' }) })
const ExpectedOrganizationHeaders = z.object({
  'x-expected-organization-id': z.string().optional().openapi({
    description:
      'The organization bound to the web form when it opened. Required for session event-type writes, including personal forms; ignored for API keys. A stale or missing context is refused with organization_context_changed; reload before retrying.',
  }),
})

const tags = ['Event types']

/**
 * Body limit (see routeBodyLimit in body-limit.ts) for creating and changing an event type.
 * Its largest legal request, with every string at its maximum length and every character
 * escaped as \uXXXX (6 bytes), is about 1.33 MB: 20 questions with a 64-character id, a
 * 200-character label and 50 options of 200 characters (20 × ≈ 62 KB ≈ 1.24 MB), a
 * 5000-character description (30 KB), a 2000-character link (12 KB), a 200-character title,
 * three 2000-code-unit follow-up notes (36 KB), and the keys and other fields (under
 * 5 KB). Rounded up.
 */
export const EVENT_TYPE_BODY_LIMIT = 2 * 1024 * 1024
const notFound =
  'event_type_not_found: no such event type in the organization, or one the caller cannot see'
const invalid =
  'invalid_request, invalid_slug, invalid_event_type, invalid_location, invalid_questions, invalid_notifications (rule values or disabled host notes), invalid_hosts, or invalid_schedule_id (scheduleId is not one of the host’s schedules)'
const forbidden = `insufficient_role: team event types need the owner or admin role; team_management_access_denied: session writes require current verified owner or admin access; ${CROSS_ORIGIN_WRITE}`
const slugTaken = 'slug_taken: another event type on the same page has this slug'

export function eventTypeRoutes(deps: ServiceDeps): RouteModule {
  const writeContext = (principal: Principal, expectedOrganizationId?: string) => ({
    ...serviceContext(deps, principal),
    authorizeOrganizationWrite: organizationWriteAccess(principal, expectedOrganizationId),
  })
  return ({ app, caller }) => {
    const route = { security: authenticated, middleware: caller, tags }

    app.openapi(
      createRoute({
        ...route,
        middleware: callerWithBodyLimit(caller, EVENT_TYPE_BODY_LIMIT),
        method: 'put',
        path: '/api/v1/event-types/{id}/notifications',
        operationId: 'setEventTypeNotifications',
        summary: 'Replace reminder and follow-up settings',
        description:
          'Replaces notifications atomically for future new bookings, without sending mail or changing existing booking snapshots. Requires full API-key scope or the same session write access as other event-type changes.',
        request: {
          params: IdParams,
          headers: ExpectedOrganizationHeaders,
          body: {
            content: json(z.strictObject({ notifications: NotificationSettingsInput })),
            required: true,
          },
        },
        responses: {
          200: { description: 'The changed event type', content: json(EventType) },
          ...errorResponses({
            400: 'invalid_request: malformed shape; invalid_notifications: rule values or disabled host notes',
            403: forbidden,
            404: notFound,
            409: ORGANIZATION_CONTEXT_CHANGED,
          }),
        },
      }),
      async (c) =>
        c.json(
          eventTypeResponse(
            await updateEventType(
              writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
              c.req.valid('param').id,
              c.req.valid('json'),
            ),
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        ...route,
        method: 'get',
        path: '/api/v1/event-type-hosts',
        summary: 'Current verified members available for host assignment',
        request: {
          query: z.object({
            after: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
          }),
        },
        responses: {
          200: {
            description: 'A bounded member page',
            content: json(
              z.object({
                data: z.array(z.object({ id: z.uuid(), memberId: z.uuid(), name: z.string() })),
                nextAfter: z.string().nullable(),
              }),
            ),
          },
          ...errorResponses({ 403: forbidden, 400: 'invalid_limit, invalid_cursor' }),
        },
      }),
      async (c) =>
        c.json(
          await listEventTypeHosts(serviceContext(deps, c.var.principal), c.req.valid('query')),
          200,
        ),
    )

    app.openapi(
      createRoute({
        ...route,
        method: 'get',
        path: '/api/v1/event-types',
        summary: 'Event types of the organization the caller acts in',
        description:
          'Team event types, and the personal ones the caller owns, by position. Deleted ones are left out.',
        responses: {
          200: { description: 'By position', content: json(EventTypeList) },
          ...errorResponses({}),
        },
      }),
      async (c) =>
        c.json(
          {
            data: (await listEventTypes(serviceContext(deps, c.var.principal))).map(
              eventTypeResponse,
            ),
          },
          200,
        ),
    )

    app.openapi(
      createRoute({
        ...route,
        middleware: callerWithBodyLimit(caller, EVENT_TYPE_BODY_LIMIT),
        method: 'post',
        path: '/api/v1/event-types',
        operationId: 'createEventType',
        summary: 'Create an event type',
        description:
          "Created in the organization the caller acts in and hosted by the caller: on the caller's personal page in a personal organization, on the team page in a team (owners and admins only).",
        request: {
          headers: ExpectedOrganizationHeaders,
          body: { content: json(EventTypeInput), required: true },
        },
        responses: {
          201: { description: 'The new event type', content: json(EventType) },
          ...errorResponses({
            400: invalid,
            403: forbidden,
            409: `${slugTaken}; ${ORGANIZATION_CONTEXT_CHANGED}`,
          }),
        },
      }),
      async (c) =>
        c.json(
          eventTypeResponse(
            await createEventType(
              writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
              c.req.valid('json'),
            ),
          ),
          201,
        ),
    )

    app.openapi(
      createRoute({
        ...route,
        method: 'get',
        path: '/api/v1/event-types/{id}',
        summary: 'An event type',
        request: { params: IdParams },
        responses: {
          200: { description: 'The event type', content: json(EventType) },
          ...errorResponses({ 404: notFound }),
        },
      }),
      async (c) =>
        c.json(
          eventTypeResponse(
            await getEventType(serviceContext(deps, c.var.principal), c.req.valid('param').id),
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        ...route,
        middleware: callerWithBodyLimit(caller, EVENT_TYPE_BODY_LIMIT),
        method: 'patch',
        path: '/api/v1/event-types/{id}',
        operationId: 'updateEventType',
        summary: 'Change an event type',
        request: {
          params: IdParams,
          headers: ExpectedOrganizationHeaders,
          body: { content: json(EventTypeUpdate), required: true },
        },
        responses: {
          200: { description: 'The changed event type', content: json(EventType) },
          ...errorResponses({
            400: invalid,
            403: forbidden,
            404: notFound,
            409: `${slugTaken}; ${ORGANIZATION_CONTEXT_CHANGED}`,
          }),
        },
      }),
      async (c) =>
        c.json(
          eventTypeResponse(
            await updateEventType(
              writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
              c.req.valid('param').id,
              c.req.valid('json'),
            ),
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        ...route,
        middleware: callerWithBodyLimit(caller, 1024),
        method: 'post',
        path: '/api/v1/event-types/{id}/round-robin/activate',
        operationId: 'activateRoundRobin',
        summary: 'Explicitly activate a team round-robin pool',
        description:
          'Validates the complete current verified host pool. Ordinary metadata saves and mode changes never activate it. Existing fairness sequence values are preserved.',
        request: {
          params: IdParams,
          headers: ExpectedOrganizationHeaders,
          body: { content: json(z.strictObject({})), required: true },
        },
        responses: {
          200: { description: 'The activated configuration', content: json(EventType) },
          ...errorResponses({
            400: invalid,
            403: forbidden,
            404: notFound,
            409: ORGANIZATION_CONTEXT_CHANGED,
          }),
        },
      }),
      async (c) =>
        c.json(
          eventTypeResponse(
            await activateRoundRobin(
              writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
              c.req.valid('param').id,
            ),
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        ...route,
        method: 'delete',
        path: '/api/v1/event-types/{id}',
        operationId: 'deleteEventType',
        summary: 'Delete an event type',
        description:
          'It disappears from the API and its slug becomes free; past bookings keep pointing at it.',
        request: { params: IdParams, headers: ExpectedOrganizationHeaders },
        responses: {
          204: { description: 'Deleted' },
          ...errorResponses({ 403: forbidden, 404: notFound, 409: ORGANIZATION_CONTEXT_CHANGED }),
        },
      }),
      async (c) => {
        await deleteEventType(
          writeContext(c.var.principal, c.req.header(EXPECTED_ORGANIZATION_HEADER)),
          c.req.valid('param').id,
        )
        return c.body(null, 204)
      },
    )
  }
}
