import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  createEventType,
  duplicateEventType,
  type ServiceContext,
  updateEventType,
} from '@hourmere/scheduling'
import { EventType, EventTypeInput, EventTypeUpdate } from '../routes/event-types.ts'
import { defineTool, type McpCaller, type Tool } from './tools.ts'

const teamsLocationDescription =
  ' A microsoft_teams location requires one individual host with a Microsoft calendar selected for writeback. Adding Teams, reactivating an event with Teams or changing its host requires the assigned host’s browser session and returns microsoft_teams_host_session_required on this tool.'

/** Account configuration writes, with the same strict input and services as REST. */
export function eventTypeTools({
  db,
  automaticMeet,
  automaticZoom,
  microsoftCalendarEnabled,
  smsRemindersAvailable,
  followUpHostNotesEnabled,
  successRedirectPolicy,
}: {
  db: Db
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
  microsoftCalendarEnabled?: boolean | undefined
  smsRemindersAvailable?: boolean | undefined
  followUpHostNotesEnabled?: boolean | undefined
  successRedirectPolicy?: ServiceContext['successRedirectPolicy']
}): Tool[] {
  const context = (principal: McpCaller): ServiceContext => ({
    db,
    principal,
    ...(principal.scimResourcesEnabled && { scimResourcesEnabled: true }),
    automaticMeet,
    automaticZoom,
    microsoftCalendarEnabled,
    smsRemindersAvailable,
    successRedirectPolicy,
    followUpHostNotesEnabled,
    now: () => Temporal.Now.instant(),
  })
  return [
    defineTool({
      name: 'duplicate_event_type',
      title: 'Duplicate an event type',
      description:
        'Copies event settings in the current organization with a new unique booking slug, as POST /api/v1/event-types/{id}/duplicate does. Requires full API-key scope and the same ownership or team owner/admin permission as creation. Bookings, history, statistics, one-time links and round-robin activation are not copied. Not idempotent: inspect the event list after an uncertain response before retrying. Duplicating an event with a microsoft_teams location requires the assigned host’s browser session and returns microsoft_teams_host_session_required on this tool.',
      input: z.strictObject({ id: z.uuid() }),
      output: EventType,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      async run({ id }, call) {
        return duplicateEventType(context(call.caller), id)
      },
    }),
    defineTool({
      name: 'create_event_type',
      title: 'Create an event type',
      description:
        'Creates an event type in your current organization, as POST /api/v1/event-types does. Personal types belong to you; team types require owner or admin access. durationMinutes is the default meeting length in whole minutes; allowedDurationsMinutes optionally offers 1–12 distinct whole-minute lengths from 1 to 1440 and must include the default. Lengths are kept in ascending order; supplied lists are sorted before storage. Omission uses [durationMinutes]. minimumNoticeMinutes (0–525600), bufferBeforeMinutes and bufferAfterMinutes (0–1440) are whole minutes. bookingWindowDays is whole calendar days in the host schedule time zone (1–3650 or null for unlimited). UI display units do not change these API units. successRedirect configures an optional HTTPS Continue link after public booking, with a parameter whitelist and explicit invitee-personal-data and embed-parent opt-ins; null clears it. maxBookingsPerDay, maxBookingsPerWeek and maxBookingsPerMonth accept 1–1000 or null for unlimited. Set ceilings must not descend as periods get longer, even when week is unset. Counts use each host schedule’s local day, ISO week starting Monday, or calendar month. Lowering a ceiling never cancels bookings. rescheduleCutoffMinutes and cancelCutoffMinutes (1–525600 or null for none) stop invitees from rescheduling or cancelling through their manage link that many minutes before the start, and rescheduling also closes once the cancel deadline has passed; each booking keeps the values that applied when it was booked, and hosts and team admins are not limited. bookingMode group with groupCapacity 2–100 enables independent seats per occurrence; it requires individual scheduling, one host and no guests. Mode cannot change while confirmed bookings or pending payment holds have not ended; capacity edits apply to new occurrences. Returns the saved configuration. This changes account settings and requires full API key scope. Round-robin pools still need separate activation in the web app. Not idempotent: inspect the catalog after an uncertain response before retrying.' +
        teamsLocationDescription,
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
        'Changes an event type by id from list_event_types, as PATCH /api/v1/event-types/{id} does. Supply changed fields alongside id; omitted fields stay unchanged and null clears a nullable field. durationMinutes is the default in whole minutes; allowedDurationsMinutes must contain 1–12 distinct whole-minute lengths from 1 to 1440 including that default. Lengths are kept in ascending order; supplied lists are sorted before storage. Include a replacement list when the new default is not already offered by a multiple-length type. Changing the default alone on a single-length type replaces its sole length. minimumNoticeMinutes (0–525600), bufferBeforeMinutes and bufferAfterMinutes (0–1440) are whole minutes. bookingWindowDays is whole calendar days in the host schedule time zone (1–3650 or null for unlimited). UI display units do not change these API units. successRedirect configures an optional HTTPS Continue link after public booking, with a parameter whitelist and explicit invitee-personal-data and embed-parent opt-ins; null clears it. maxBookingsPerDay, maxBookingsPerWeek and maxBookingsPerMonth accept 1–1000 or null for unlimited. Set ceilings must not descend as periods get longer, even when week is unset. Counts use each host schedule’s local day, ISO week starting Monday, or calendar month. Lowering a ceiling never cancels bookings. rescheduleCutoffMinutes and cancelCutoffMinutes (1–525600 or null for none) stop invitees from rescheduling or cancelling through their manage link that many minutes before the start, and rescheduling also closes once the cancel deadline has passed; each booking keeps the values that applied when it was booked, and hosts and team admins are not limited. bookingMode group with groupCapacity 2–100 enables independent seats per occurrence; it requires individual scheduling, one host and no guests. Mode cannot change while confirmed bookings or pending payment holds have not ended; capacity edits apply to new occurrences. Returns the saved configuration. Requires full API key scope and existing ownership or team owner/admin access. Saving never activates a round-robin pool. Existing bookings keep their actual length.' +
        teamsLocationDescription,
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
