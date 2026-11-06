import type { Db } from '@hourmere/db'
import { generateOpenTimeSnippet } from '@hourmere/scheduling'
import { GenerateOpenTimeSnippet, OpenTimeSnippet } from '../routes/open-time-snippets.ts'
import { defineTool, type Tool } from './tools.ts'

export function openTimeSnippetTools({
  db,
  automaticMeet,
  automaticZoom,
  publicUrl = 'http://localhost',
  slotSnippetsEnabled = false,
}: {
  db: Db
  automaticMeet?: boolean | undefined
  automaticZoom?: boolean | undefined
  publicUrl?: string | undefined
  slotSnippetsEnabled?: boolean | undefined
}): Tool[] {
  return [
    defineTool({
      name: 'generate_open_time_snippet',
      title: 'Generate an open-time email snippet',
      description:
        'Prepare a reply offering open times, for example three times next week. Supply exactly one eventTypeId or unique slug in your organization, and from/to RFC 3339 instants with offsets (at most 31 elapsed days). Returns the earliest available times, direct booking links, text and HTML. count defaults to 3 (1–10); locale and displayTimeZone default to your profile, durationMinutes to the event default. Personal owners and team owners/admins may use read, bookings or full API keys; authorized MCP OAuth is also supported. Requires the instance SLOT_SNIPPETS_ENABLED flag. Active hidden events are allowed, so forwarded links can expose their booking page. No times are reserved: a taken link offers another-time selection. Generate the snippet, review it, then use your email tool to send it only when authorized.',
      input: GenerateOpenTimeSnippet.strict(),
      output: OpenTimeSnippet,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async run(args, call) {
        return generateOpenTimeSnippet(
          {
            db,
            automaticMeet,
            automaticZoom,
            principal: call.caller,
            now: () => Temporal.Now.instant(),
          },
          args,
          { publicUrl, slotSnippetsEnabled },
        )
      },
    }),
  ]
}
