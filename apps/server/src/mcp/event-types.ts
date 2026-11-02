import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { createEventType, type ServiceContext, updateEventType } from '@hourmere/scheduling'
import { EventType, EventTypeInput, EventTypeUpdate } from '../routes/event-types.ts'
import { defineTool, type McpCaller, type Tool } from './tools.ts'

/** Account configuration writes, with the same strict input and services as REST. */
export function eventTypeTools({
  db,
  automaticMeet,
  automaticZoom,
  followUpHostNotesEnabled,
}: {
  db: Db
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
  followUpHostNotesEnabled?: boolean | undefined
}): Tool[] {
  const context = (principal: McpCaller): ServiceContext => ({
    db,
    principal,
    automaticMeet,
    automaticZoom,
    followUpHostNotesEnabled,
    now: () => Temporal.Now.instant(),
  })
  return [
    defineTool({
      name: 'create_event_type',
      title: 'Create an event type',
      description:
        'Creates an event type in your current organization, as POST /api/v1/event-types does. Personal types belong to you; team types require owner or admin access. durationMinutes is the default meeting length; allowedDurationsMinutes optionally offers 1–12 distinct whole-minute lengths from 1 to 1440 and must include the default. Omission uses [durationMinutes]. Returns the saved configuration. This changes account settings and requires full API key scope. Round-robin pools still need separate activation in the web app. Not idempotent: inspect the catalog after an uncertain response before retrying.',
      input: EventTypeInput,
      output: EventType,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      async run(args, call) {
        return createEventType(context(call.caller), args)
      },
    }),
    defineTool({
      name: 'update_event_type',
      title: 'Change an event type',
      description:
        'Changes an event type by id from list_event_types, as PATCH /api/v1/event-types/{id} does. Supply changed fields alongside id; omitted fields stay unchanged and null clears a nullable field. durationMinutes is the default; allowedDurationsMinutes must contain 1–12 distinct whole-minute lengths from 1 to 1440 including that default. Include a replacement list when the new default is not already offered by a multiple-length type. Changing the default alone on a single-length type replaces its sole length. Returns the saved configuration. Requires full API key scope and existing ownership or team owner/admin access. Saving never activates a round-robin pool. Existing bookings keep their actual length.',
      input: EventTypeUpdate.extend({
        id: z.uuid().openapi({ description: 'The event type id from list_event_types' }),
      }),
      output: EventType,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run({ id, ...changes }, call) {
        return updateEventType(context(call.caller), id, changes)
      },
    }),
  ]
}
