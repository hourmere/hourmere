import { createRoute, z } from '@hono/zod-openapi'
import { interfaceLanguages } from '@hourmere/core/language'
import {
  confirmDefaultSchedule,
  createSchedule,
  deleteSchedule,
  deleteScheduleOverride,
  getSchedule,
  listScheduleOverrides,
  listSchedules,
  putScheduleOverride,
  SCHEDULE_NAME_MAX_LENGTH,
  updateSchedule,
} from '@hourmere/scheduling'
import {
  authenticated,
  CROSS_ORIGIN_WRITE,
  callerWithBodyLimit,
  errorResponses,
  json,
  type RouteModule,
  type ServiceDeps,
  serviceContext,
} from '../openapi.ts'

// Schemas check the JSON shape (400 invalid_request); the service checks values with the
// availability engine's own rules and answers with specific codes, the same for REST and
// MCP. Limits are documented here.
//
// Request bodies are strict (a misspelled field is an error, not ignored); responses are
// open, because fields may be added to them within /api/v1.

const interval = {
  start: z.string().openapi({
    description: 'Local time HH:MM, 00:00–23:59',
    pattern: '^\\d{2}:\\d{2}$',
    example: '09:00',
  }),
  end: z.string().openapi({
    description: 'Local time HH:MM after start; 24:00 is the end of the day',
    pattern: '^\\d{2}:\\d{2}$',
    example: '17:00',
  }),
}
const intervalRules = {
  description: 'Intervals of one day must not overlap; touching ones are joined',
}
const WallClockInterval = z.object(interval).openapi('WallClockInterval', intervalRules)
const WallClockIntervalInput = z
  .strictObject(interval)
  .openapi('WallClockIntervalInput', intervalRules)

const week = <T extends z.ZodType>(interval: T) => {
  const day = z.array(interval).optional()
  return {
    monday: day,
    tuesday: day,
    wednesday: day,
    thursday: day,
    friday: day,
    saturday: day,
    sunday: day,
  }
}
const weekRules = { description: 'A missing or empty weekday is unavailable' }
const WeeklyHours = z.object(week(WallClockInterval)).openapi('WeeklyHours', weekRules)
const WeeklyHoursInput = z
  .strictObject(week(WallClockIntervalInput))
  .openapi('WeeklyHoursInput', weekRules)

export const Schedule = z
  .object({
    id: z.uuid(),
    name: z.string(),
    timeZone: z.string().openapi({ example: 'Europe/Berlin' }),
    weeklyHours: WeeklyHours,
    isDefault: z.boolean().openapi({
      description: 'Event types use the default schedule unless they name another',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Schedule')

const name = z.string().openapi({ minLength: 1, maxLength: SCHEDULE_NAME_MAX_LENGTH })
const timeZone = z
  .string()
  .openapi({ description: 'IANA time zone name', example: 'Europe/Berlin' })

const ScheduleInput = z
  .strictObject({
    name,
    timeZone,
    weeklyHours: WeeklyHoursInput,
    isDefault: z.boolean().optional().openapi({
      description:
        "Make it the default (the previous default stops being one). The user's first schedule is always the default.",
    }),
  })
  .openapi('ScheduleInput')

const ScheduleUpdate = z
  .strictObject({
    name: name.optional(),
    timeZone: timeZone.optional(),
    weeklyHours: WeeklyHoursInput.optional(),
    isDefault: z.boolean().optional().openapi({
      description:
        'true makes it the default. The default cannot be set to false; make another schedule the default instead.',
    }),
  })
  .openapi('ScheduleUpdate')

const ScheduleList = z.object({ data: z.array(Schedule) }).openapi('ScheduleList')

const date = z.string().openapi({ format: 'date', example: '2026-12-24' })

const ScheduleOverride = z
  .object({
    date,
    intervals: z.array(WallClockInterval).openapi({ description: 'Empty: unavailable all day' }),
  })
  .openapi('ScheduleOverride')

const ScheduleOverrideInput = z
  .strictObject({
    intervals: z.array(WallClockIntervalInput).openapi({
      description: 'Replace the weekly hours on this date; [] = unavailable all day',
    }),
  })
  .openapi('ScheduleOverrideInput')

const ScheduleOverrideList = z
  .object({ data: z.array(ScheduleOverride) })
  .openapi('ScheduleOverrideList')

const IdParams = z.object({ id: z.string().openapi({ format: 'uuid' }) })
const OverrideParams = IdParams.extend({
  date: date.openapi({ description: 'Local date in the schedule’s time zone' }),
})

const tags = ['Schedules']
const notFound = 'schedule_not_found: no such schedule among the caller’s'

/**
 * Body limits (see routeBodyLimit in body-limit.ts). A day holds at most 1440 one-minute
 * intervals, and one interval is at most 122 bytes with every string character escaped as
 * \uXXXX (`{"start":"HH:MM","end":"HH:MM"}`: 18 characters × 6 + 13, plus a comma). Weekly
 * hours thus come to 7 × 1440 × 122 ≈ 1.23 MB and one date's intervals to ≈ 176 KB; the name,
 * time zone and keys add under 2 KB. Rounded up.
 */
export const SCHEDULE_BODY_LIMIT = 2 * 1024 * 1024
export const SCHEDULE_OVERRIDE_BODY_LIMIT = 256 * 1024

export function scheduleRoutes(deps: ServiceDeps): RouteModule {
  return ({ app, caller }) => {
    const route = { security: authenticated, middleware: caller, tags }

    app.openapi(
      createRoute({
        ...route,
        middleware: callerWithBodyLimit(caller, SCHEDULE_BODY_LIMIT),
        method: 'post',
        path: '/api/v1/schedules/default',
        summary: 'Confirm starter working hours',
        description:
          'After profile and display name setup, creates a default Mon–Fri 09:00–17:00 schedule in the stored profile time zone only when the caller has no schedules. An existing default is returned unchanged. Existing non-default schedules require an explicit default choice in Availability.',
        request: {
          body: {
            content: json(
              z.strictObject({
                language: z.enum(interfaceLanguages('admin')).optional().openapi({
                  description:
                    'Current account interface language for the new schedule name; defaults to English. Existing schedules are never renamed.',
                }),
              }),
            ),
            required: true,
          },
        },
        responses: {
          200: { description: 'The existing default, unchanged', content: json(Schedule) },
          201: { description: 'The confirmed starter schedule', content: json(Schedule) },
          ...errorResponses({
            400: 'invalid_request or invalid_time_zone',
            403: CROSS_ORIGIN_WRITE,
            409: 'setup_profile_required: profile or display name is missing; setup_default_schedule_required: existing schedules have no default',
          }),
        },
      }),
      async (c) => {
        const { schedule, created } = await confirmDefaultSchedule(
          serviceContext(deps, c.var.principal),
          c.req.valid('json').language,
        )
        return created ? c.json(schedule, 201) : c.json(schedule, 200)
      },
    )

    app.openapi(
      createRoute({
        ...route,
        method: 'get',
        path: '/api/v1/schedules',
        summary: "The caller's schedules",
        responses: {
          200: { description: 'Oldest first', content: json(ScheduleList) },
          ...errorResponses({}),
        },
      }),
      async (c) =>
        c.json({ data: await listSchedules(serviceContext(deps, c.var.principal)) }, 200),
    )

    app.openapi(
      createRoute({
        ...route,
        middleware: callerWithBodyLimit(caller, SCHEDULE_BODY_LIMIT),
        method: 'post',
        path: '/api/v1/schedules',
        summary: 'Create a schedule',
        request: { body: { content: json(ScheduleInput), required: true } },
        responses: {
          201: { description: 'The new schedule', content: json(Schedule) },
          ...errorResponses({
            400: 'invalid_request, invalid_schedule, invalid_time_zone or invalid_weekly_hours',
            403: CROSS_ORIGIN_WRITE,
          }),
        },
      }),
      async (c) =>
        c.json(
          await createSchedule(serviceContext(deps, c.var.principal), c.req.valid('json')),
          201,
        ),
    )

    app.openapi(
      createRoute({
        ...route,
        method: 'get',
        path: '/api/v1/schedules/{id}',
        summary: 'A schedule',
        request: { params: IdParams },
        responses: {
          200: { description: 'The schedule', content: json(Schedule) },
          ...errorResponses({ 404: notFound }),
        },
      }),
      async (c) =>
        c.json(
          await getSchedule(serviceContext(deps, c.var.principal), c.req.valid('param').id),
          200,
        ),
    )

    app.openapi(
      createRoute({
        ...route,
        middleware: callerWithBodyLimit(caller, SCHEDULE_BODY_LIMIT),
        method: 'patch',
        path: '/api/v1/schedules/{id}',
        summary: 'Change a schedule',
        request: { params: IdParams, body: { content: json(ScheduleUpdate), required: true } },
        responses: {
          200: { description: 'The changed schedule', content: json(Schedule) },
          ...errorResponses({
            400: 'invalid_request, invalid_schedule, invalid_time_zone or invalid_weekly_hours',
            403: CROSS_ORIGIN_WRITE,
            404: notFound,
            409: 'schedule_is_default: isDefault false on the default schedule',
          }),
        },
      }),
      async (c) =>
        c.json(
          await updateSchedule(
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
        path: '/api/v1/schedules/{id}',
        summary: 'Delete a schedule',
        description:
          "Its overrides go with it; event types that used it fall back to the host's default schedule.",
        request: { params: IdParams },
        responses: {
          204: { description: 'Deleted' },
          ...errorResponses({
            403: CROSS_ORIGIN_WRITE,
            404: notFound,
            409: 'schedule_is_default: the default schedule while the user has others',
          }),
        },
      }),
      async (c) => {
        await deleteSchedule(serviceContext(deps, c.var.principal), c.req.valid('param').id)
        return c.body(null, 204)
      },
    )

    app.openapi(
      createRoute({
        ...route,
        method: 'get',
        path: '/api/v1/schedules/{id}/overrides',
        summary: "A schedule's date overrides",
        request: {
          params: IdParams,
          query: z.object({
            from: date.optional().openapi({ description: 'First date, inclusive' }),
            to: date.optional().openapi({ description: 'Last date, inclusive' }),
          }),
        },
        responses: {
          200: { description: 'By date', content: json(ScheduleOverrideList) },
          ...errorResponses({
            400: 'invalid_request, invalid_date or invalid_date_range',
            404: notFound,
          }),
        },
      }),
      async (c) => {
        const overrides = await listScheduleOverrides(
          serviceContext(deps, c.var.principal),
          c.req.valid('param').id,
          c.req.valid('query'),
        )
        return c.json({ data: overrides }, 200)
      },
    )

    app.openapi(
      createRoute({
        ...route,
        middleware: callerWithBodyLimit(caller, SCHEDULE_OVERRIDE_BODY_LIMIT),
        method: 'put',
        path: '/api/v1/schedules/{id}/overrides/{date}',
        summary: 'Set the hours of one date',
        request: {
          params: OverrideParams,
          body: { content: json(ScheduleOverrideInput), required: true },
        },
        responses: {
          200: { description: 'The override was replaced', content: json(ScheduleOverride) },
          201: { description: 'The override was created', content: json(ScheduleOverride) },
          ...errorResponses({
            400: 'invalid_request, invalid_date or invalid_intervals',
            403: CROSS_ORIGIN_WRITE,
            404: notFound,
          }),
        },
      }),
      async (c) => {
        const { id, date } = c.req.valid('param')
        const { override, created } = await putScheduleOverride(
          serviceContext(deps, c.var.principal),
          id,
          date,
          c.req.valid('json').intervals,
        )
        return created ? c.json(override, 201) : c.json(override, 200)
      },
    )

    app.openapi(
      createRoute({
        ...route,
        method: 'delete',
        path: '/api/v1/schedules/{id}/overrides/{date}',
        summary: 'Remove the override of one date',
        description: 'The weekly hours apply to the date again.',
        request: { params: OverrideParams },
        responses: {
          204: { description: 'Removed' },
          ...errorResponses({
            400: 'invalid_date',
            403: CROSS_ORIGIN_WRITE,
            404: `${notFound}; schedule_override_not_found: the date has no override`,
          }),
        },
      }),
      async (c) => {
        const { id, date } = c.req.valid('param')
        await deleteScheduleOverride(serviceContext(deps, c.var.principal), id, date)
        return c.body(null, 204)
      },
    )
  }
}
