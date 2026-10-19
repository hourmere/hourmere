import { z } from '@hono/zod-openapi'
import { type CalendarDeps, listCalendarConnections } from '@hourmere/calendars'
import { type ConferenceDeps, listConferenceConnections } from '@hourmere/conferences'
import { CalendarConnections } from '../routes/calendars.ts'
import { ConferenceConnections } from '../routes/conferences.ts'
import { defineTool, type Tool } from './tools.ts'

/** Read the same private metadata as REST without starting provider authorization. */
export function integrationTools({
  calendar,
  conference,
}: {
  calendar: CalendarDeps
  conference: ConferenceDeps
}): Tool[] {
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
  return [
    defineTool({
      name: 'list_calendar_connections',
      title: 'List my calendar connections',
      description:
        'Lists your connected Google and Microsoft accounts, safe connection status, calendars, conflict selections and default write destination, as GET /api/v1/calendar-connections does. Connections follow your user across organizations. Never returns credentials or contacts a provider. Use the REST API with your own API key to change selections, refresh the calendar list or sync now; provider authorization and disconnect require browser consent.',
      input: z.strictObject({}),
      output: CalendarConnections,
      annotations,
      run: async (_args, { caller }) => listCalendarConnections(calendar, caller),
    }),
    defineTool({
      name: 'list_conference_connections',
      title: 'List my Zoom connections',
      description:
        'Lists your Zoom connection IDs, accountEmail, displayName, identity/meetings mode, safe status and instance availability, as GET /api/v1/conference-connections does. Never returns credentials, provider meeting links or browser authorization attempts, and never contacts Zoom. Your API key can select your own meeting-mode connection for an event type you actually host through the REST API. Starting authorization, refreshing Zoom credentials and disconnecting require a browser session.',
      input: z.strictObject({}),
      output: ConferenceConnections,
      annotations,
      run: async (_args, { caller }) => listConferenceConnections(conference, caller),
    }),
  ]
}
