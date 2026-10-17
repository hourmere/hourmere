// Read-only owner configuration discovery, using the REST services and detail schemas.
import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  DEFAULT_CATALOG_PAGE_SIZE,
  EVENT_TYPE_LIMITS,
  getEventType,
  getProfile,
  getSchedule,
  listEventTypeCatalog,
  listScheduleCatalog,
  MAX_CATALOG_PAGE_SIZE,
  SCHEDULE_NAME_MAX_LENGTH,
  type ServiceContext,
} from '@hourmere/scheduling'
import { EventType } from '../routes/event-types.ts'
import { Profile } from '../routes/profile.ts'
import { Schedule } from '../routes/schedules.ts'
import { defineTool, type McpCaller, type Tool } from './tools.ts'

const PageInput = z.strictObject({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_CATALOG_PAGE_SIZE)
    .optional()
    .openapi({
      description: `Maximum summaries in this page (default ${DEFAULT_CATALOG_PAGE_SIZE}, maximum ${MAX_CATALOG_PAGE_SIZE})`,
    }),
  after: z.uuid().optional().openapi({
    description: 'Exclusive nextAfter from the previous page; keep the same key and organization',
  }),
})
const IdInput = z.strictObject({
  id: z.uuid().openapi({ description: 'The id from the corresponding list tool' }),
})
const EventTypeSummary = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  ownerUserId: z.uuid().nullable(),
  slug: z.string().max(EVENT_TYPE_LIMITS.slugMaxLength),
  title: z.string().max(EVENT_TYPE_LIMITS.titleMaxLength),
  durationMinutes: z.number().int(),
  schedulingType: z.enum(['individual', 'round_robin', 'collective']),
  isActive: z.boolean(),
  isHidden: z.boolean(),
  allowGuests: z.boolean(),
  position: z.number().int(),
})
const ScheduleSummary = z.object({
  id: z.uuid(),
  name: z.string().max(SCHEDULE_NAME_MAX_LENGTH),
  timeZone: z.string().max(64),
  isDefault: z.boolean(),
})
const page = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item).max(MAX_CATALOG_PAGE_SIZE),
    nextAfter: z.uuid().nullable(),
  })
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

export function catalogTools({ db }: { db: Db }): Tool[] {
  const context = (principal: McpCaller): ServiceContext => ({
    db,
    principal,
    now: () => Temporal.Now.instant(),
  })
  return [
    defineTool({
      name: 'get_profile',
      title: 'Get my profile',
      description:
        "Reads your booking-page handle, IANA time zone and language, as GET /api/v1/profile does. The handle is used with an event type's slug in find_available_slots. profile_not_found means you have not created a profile yet.",
      input: z.strictObject({}),
      output: Profile,
      annotations,
      async run(_args, call) {
        return getProfile(context(call.caller))
      },
    }),
    defineTool({
      name: 'list_event_types',
      title: 'List my event types',
      description: `Compact summaries of visible event type configurations in the key's organization: team types and your own personal types, including inactive configurations. Sorted by id, up to limit (default ${DEFAULT_CATALOG_PAGE_SIZE}, maximum ${MAX_CATALOG_PAGE_SIZE}); pass after=nextAfter until null. Pages are recalculated and exclude deleted types. Use get_event_type for questions, location and rules; find_available_slots checks current public availability.`,
      input: PageInput,
      output: page(EventTypeSummary),
      annotations,
      async run(args, call) {
        return listEventTypeCatalog(context(call.caller), args)
      },
    }),
    defineTool({
      name: 'get_event_type',
      title: 'Get an event type',
      description:
        "Reads a visible event type's full configuration (questions, location, schedule and booking rules) by id from list_event_types, with the same ownership and organization boundaries as GET /api/v1/event-types/{id}.",
      input: IdInput,
      output: EventType,
      annotations,
      async run(args, call) {
        return getEventType(context(call.caller), args.id)
      },
    }),
    defineTool({
      name: 'list_schedules',
      title: 'List my schedules',
      description: `Compact summaries of your working-hours schedules (id, name, IANA timeZone, isDefault), sorted by id. Schedules belong to your user and follow you across organizations. Up to limit (default ${DEFAULT_CATALOG_PAGE_SIZE}, maximum ${MAX_CATALOG_PAGE_SIZE}); pass after=nextAfter until null. Use get_schedule for weekly hours.`,
      input: PageInput,
      output: page(ScheduleSummary),
      annotations,
      async run(args, call) {
        return listScheduleCatalog(context(call.caller), args)
      },
    }),
    defineTool({
      name: 'get_schedule',
      title: 'Get my schedule',
      description:
        'Reads one of your schedules by id from list_schedules, including weekly working hours in its IANA time zone (monday to sunday; HH:MM local start/end, end may be 24:00). Date overrides are separate from weekly hours. Same ownership as GET /api/v1/schedules/{id}.',
      input: IdInput,
      output: Schedule,
      annotations,
      async run(args, call) {
        // Normalize the core's readonly weekly-hour arrays through the shared response shape.
        return Schedule.parse(await getSchedule(context(call.caller), args.id))
      },
    }),
  ]
}
