import { createRoute, z } from '@hono/zod-openapi'
import { EVENT_TYPE_RULE_BOUNDS } from '@hourmere/core'
import {
  createEventType,
  deleteEventType,
  EVENT_TYPE_LIMITS,
  getEventType,
  listEventTypes,
  PHONE_NUMBER_PATTERN,
  QUESTION_ID_PATTERN,
  QUESTION_TYPES,
  SLUG_PATTERN,
  updateEventType,
} from '@hourmere/scheduling'
import {
  authenticated,
  CROSS_ORIGIN_WRITE,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'

// Schemas check the JSON shape (400 invalid_request); the service checks values (the rule
// bounds are the availability engine's) and answers with specific codes, the same for REST
// and MCP. Limits are documented here.

const L = EVENT_TYPE_LIMITS

// Not a named component: zod-to-openapi would add the null of `.nullable()` to the
// component itself, and flattens a union with null.
const Location = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('google_meet') }),
    z.strictObject({ kind: z.literal('zoom') }),
    z.strictObject({
      kind: z.literal('phone'),
      number: z.string().openapi({
        description: "The host's number in E.164",
        pattern: PHONE_NUMBER_PATTERN.source,
        example: '+14155550123',
      }),
    }),
    z.strictObject({
      kind: z.literal('in_person'),
      address: z.string().openapi({ minLength: 1, maxLength: L.addressMaxLength }),
    }),
    z.strictObject({
      kind: z.literal('link'),
      url: z.string().openapi({
        description: 'An http or https URL',
        format: 'uri',
        maxLength: L.urlMaxLength,
      }),
    }),
  ])
  .nullable()
  .openapi({
    description:
      'Where the meeting happens, by kind; Meet and Zoom links are generated per booking. null = not set.',
  })

const questionFields = {
  id: z.string().openapi({
    description: 'Unique within the event type; answers are stored under it',
    pattern: QUESTION_ID_PATTERN.source,
    example: 'company',
  }),
  label: z.string().openapi({ minLength: 1, maxLength: L.questionLabelMaxLength }),
  type: z.enum(QUESTION_TYPES),
  options: z
    .array(z.string().openapi({ minLength: 1, maxLength: L.optionMaxLength }))
    .optional()
    .openapi({
      description: 'The distinct choices; only (and required) for select and multi_select',
      minItems: 1,
      maxItems: L.options,
    }),
}

const Question = z
  .object({ ...questionFields, required: z.boolean() })
  .openapi('Question', { description: 'A booking-form field beyond name and email' })

const QuestionInput = z
  .strictObject({ ...questionFields, required: z.boolean().optional().openapi({ default: false }) })
  .openapi('QuestionInput')

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
  durationMinutes: rule('durationMinutes', 'Length of a meeting'),
  slotStepMinutes: rule(
    'slotStepMinutes',
    'Distance between start times; null = the duration',
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
  isActive: z.boolean().openapi({ description: 'Whether invitees can book it' }),
  position: z.int().openapi({
    description: 'Order on the page, ascending',
    ...minMax({ min: L.positionMin, max: L.positionMax }),
  }),
  scheduleId: z.string().nullable().openapi({
    description: "One of the host's schedules; null = the host's default schedule",
    format: 'uuid',
  }),
}

const EventType = z
  .object({
    id: z.uuid(),
    organizationId: z.uuid(),
    ownerUserId: z.uuid().nullable().openapi({
      description: 'The user whose personal page lists it; null for a team event type',
    }),
    ...fields,
    schedulingType: z.enum(['individual', 'round_robin', 'collective']),
    questions: z.array(Question),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('EventType')

const questions = z
  .array(QuestionInput)
  .openapi({ description: 'Extra booking-form fields', maxItems: L.questions })

const EventTypeInput = z
  .strictObject({
    slug: fields.slug,
    title: fields.title,
    durationMinutes: fields.durationMinutes,
    description: fields.description.optional(),
    slotStepMinutes: fields.slotStepMinutes.optional(),
    bufferBeforeMinutes: fields.bufferBeforeMinutes.optional().openapi({ default: 0 }),
    bufferAfterMinutes: fields.bufferAfterMinutes.optional().openapi({ default: 0 }),
    minimumNoticeMinutes: fields.minimumNoticeMinutes.optional().openapi({ default: 0 }),
    bookingWindowDays: fields.bookingWindowDays.optional(),
    maxBookingsPerDay: fields.maxBookingsPerDay.optional(),
    location: fields.location.optional(),
    questions: questions.optional(),
    isActive: fields.isActive.optional().openapi({ default: true }),
    position: fields.position.optional().openapi({ default: 0 }),
    scheduleId: fields.scheduleId.optional(),
  })
  .openapi('EventTypeInput')

const EventTypeUpdate = z
  .strictObject({
    slug: fields.slug.optional(),
    title: fields.title.optional(),
    durationMinutes: fields.durationMinutes.optional(),
    description: fields.description.optional(),
    slotStepMinutes: fields.slotStepMinutes.optional(),
    bufferBeforeMinutes: fields.bufferBeforeMinutes.optional(),
    bufferAfterMinutes: fields.bufferAfterMinutes.optional(),
    minimumNoticeMinutes: fields.minimumNoticeMinutes.optional(),
    bookingWindowDays: fields.bookingWindowDays.optional(),
    maxBookingsPerDay: fields.maxBookingsPerDay.optional(),
    location: fields.location.optional(),
    questions: questions.optional(),
    isActive: fields.isActive.optional(),
    position: fields.position.optional(),
    scheduleId: fields.scheduleId.optional(),
  })
  .openapi('EventTypeUpdate', {
    description: 'Omitted fields stay as they are; null clears a nullable field',
  })

const EventTypeList = z.object({ data: z.array(EventType) }).openapi('EventTypeList')

const IdParams = z.object({ id: z.string().openapi({ format: 'uuid' }) })

const tags = ['Event types']
const notFound =
  'event_type_not_found: no such event type in the organization, or one the caller cannot see'
const invalid =
  'invalid_request, invalid_slug, invalid_event_type, invalid_location, invalid_questions, or schedule_not_found (scheduleId is not one of the host’s schedules)'
const forbidden = `insufficient_role: team event types need the owner or admin role; ${CROSS_ORIGIN_WRITE}`
const slugTaken = 'slug_taken: another event type on the same page has this slug'

export function eventTypeRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    const route = { security: authenticated, middleware: caller, tags }

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
        c.json({ data: await listEventTypes(serviceContext(deps, c.var.principal)) }, 200),
    )

    app.openapi(
      createRoute({
        ...route,
        method: 'post',
        path: '/api/v1/event-types',
        summary: 'Create an event type',
        description:
          "Created in the organization the caller acts in and hosted by the caller: on the caller's personal page in a personal organization, on the team page in a team (owners and admins only).",
        request: { body: { content: json(EventTypeInput), required: true } },
        responses: {
          201: { description: 'The new event type', content: json(EventType) },
          ...errorResponses({ 400: invalid, 403: forbidden, 409: slugTaken }),
        },
      }),
      async (c) =>
        c.json(
          await createEventType(serviceContext(deps, c.var.principal), c.req.valid('json')),
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
          await getEventType(serviceContext(deps, c.var.principal), c.req.valid('param').id),
          200,
        ),
    )

    app.openapi(
      createRoute({
        ...route,
        method: 'patch',
        path: '/api/v1/event-types/{id}',
        summary: 'Change an event type',
        request: { params: IdParams, body: { content: json(EventTypeUpdate), required: true } },
        responses: {
          200: { description: 'The changed event type', content: json(EventType) },
          ...errorResponses({ 400: invalid, 403: forbidden, 404: notFound, 409: slugTaken }),
        },
      }),
      async (c) =>
        c.json(
          await updateEventType(
            serviceContext(deps, c.var.principal),
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
          200,
        ),
    )

    app.openapi(
      createRoute({
        ...route,
        method: 'delete',
        path: '/api/v1/event-types/{id}',
        summary: 'Delete an event type',
        description:
          'It disappears from the API and its slug becomes free; past bookings keep pointing at it.',
        request: { params: IdParams },
        responses: {
          204: { description: 'Deleted' },
          ...errorResponses({ 403: forbidden, 404: notFound }),
        },
      }),
      async (c) => {
        await deleteEventType(serviceContext(deps, c.var.principal), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )
  }
}
