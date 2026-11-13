import type { Db } from '@hourmere/db'
import { troubleshootEventAvailability } from '@hourmere/scheduling'
import {
  AvailabilityTroubleshooting,
  TroubleshootAvailabilityArgs,
} from '../routes/availability-troubleshooting.ts'
import { defineTool, type Tool } from './tools.ts'

export function availabilityTroubleshootingTools({
  db,
  automaticMeet,
  automaticZoom,
}: {
  db: Db
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
}): Tool[] {
  return [
    defineTool({
      name: 'troubleshoot_availability',
      title: 'Explain why times cannot be booked',
      description:
        'Answer "why can’t this time be booked?" for one event type you manage. Supply eventTypeId and a local date (YYYY-MM-DD); timeZone (IANA) defaults to your profile time zone, durationMinutes to the event length. Returns every candidate time of that local day (23 or 25 hours on DST change days), each with status available/unavailable and ordered reason codes: past, duration_not_offered, outside_working_hours (weekly hours or a date override), off_slot_grid, minimum_notice, booking_window, calendar_busy, buffer_before, buffer_after, daily_limit, weekly_limit, monthly_limit, host_conflict (another booking), collective_member_unavailable, no_eligible_round_robin_host. Team reasons name the host by hostUserId; hosts lists names. Reasons never include calendar event titles, attendees or booking details. For a team host, a time outside their working hours reports only outside_working_hours for that host, without their busy, buffer or booking reasons; a buffer reason on an in-hours time can still show the edge of an adjacent off-hours commitment, within one buffer length. Only the personal owner or a team owner/admin may call it, with a full-scope API key or an mcp:tools OAuth grant; read and bookings keys do not see this tool, and callers who may not manage the event type get event_type_not_found, exactly like a missing id. calendar_sync_unavailable means calendars could not be read right now, not missing configuration.',
      input: TroubleshootAvailabilityArgs.strict(),
      output: AvailabilityTroubleshooting,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run(args, call) {
        return troubleshootEventAvailability(
          {
            db,
            automaticMeet,
            automaticZoom,
            principal: call.caller,
            now: () => Temporal.Now.instant(),
          },
          args,
        )
      },
    }),
  ]
}
