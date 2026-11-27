import { constants } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import {
  CliError,
  callTool,
  downloadCsv,
  endpoint,
  isObject,
  MAX_INPUT_BYTES,
  uploadLogo,
  version,
} from './client.ts'

export const COMMANDS = {
  'polls create': 'create_meeting_poll',
  'polls list': 'list_meeting_polls',
  'polls get': 'get_meeting_poll',
  'polls results': 'get_meeting_poll_results',
  'polls invite': 'invite_meeting_poll_voters',
  'polls resend-invitation': 'resend_meeting_poll_invitation',
  'polls remove-voter': 'remove_meeting_poll_voter',
  'polls remove-unverified': 'remove_unverified_meeting_poll_voters',
  'polls rotate-link': 'rotate_meeting_poll_link',
  'polls close': 'close_meeting_poll',
  'polls cancel': 'cancel_meeting_poll',
  'polls delete': 'delete_meeting_poll',
  'polls finalize': 'finalize_meeting_poll',
  'polls view': 'read_meeting_poll',
  'polls join': 'enroll_meeting_poll_voter',
  'polls recover': 'recover_meeting_poll_voter',
  'polls verify': 'verify_meeting_poll_voter',
  'polls vote': 'submit_meeting_poll_vote',
  'polls withdraw': 'withdraw_meeting_poll_vote',
  'polls reminder-opt-out': 'opt_out_meeting_poll_reminder',

  'sso providers list': 'list_sso_providers',
  'sso policy': 'get_sso_policy',
  'routing-forms list': 'list_routing_forms',
  'routing-forms get': 'get_routing_form',
  'routing-forms create': 'create_routing_form',
  'routing-forms update': 'update_routing_form',
  'routing-forms archive': 'archive_routing_form',
  'routing-forms publish': 'publish_routing_form',
  'routing-forms preview': 'preview_routing_form',
  'routing-forms public': 'get_public_routing_form',
  'routing-forms route': 'route_lead',
  'routing-forms resolve': 'resolve_routing_continuation',
  'routing-forms slots': 'find_routed_slots',

  'audit-log list': 'list_audit_events',
  'audit-log settings': 'get_audit_log_settings',
  'audit-log set-retention': 'set_audit_log_settings',
  'branding get': 'get_branding',
  'branding set': 'set_branding',
  whoami: 'whoami',
  profile: 'get_profile',
  catalog: 'list_event_types',
  'team-home': 'get_public_team',
  event: 'get_event_type',
  'create-event': 'create_event_type',
  'duplicate-event': 'duplicate_event_type',
  'update-event': 'update_event_type',
  'set-event-notifications': 'set_event_type_notifications',
  'event-waitlist': 'get_event_type_waitlist',
  'set-event-waitlist': 'set_event_type_waitlist',
  'waitlist-entries': 'list_waitlist_entries',
  'remove-waitlist-entry': 'remove_waitlist_entry',
  'join-waitlist': 'join_waitlist',
  'resend-waitlist-verification': 'resend_waitlist_verification',
  schedules: 'list_schedules',
  schedule: 'get_schedule',
  'schedule-availability': 'get_schedule_availability',
  'save-availability': 'save_schedule_availability',
  slots: 'find_available_slots',
  'open-time-snippet': 'generate_open_time_snippet',
  'troubleshoot-availability': 'troubleshoot_availability',
  book: 'create_booking',
  list: 'list_bookings',
  booking: 'get_booking',
  export: 'export_bookings',
  reschedule: 'reschedule_booking',
  'request-reschedule': 'request_reschedule',
  cancel: 'cancel_booking',
  'set-no-show': 'set_attendee_no_show',
  'booking-attendees': 'get_booking_attendees',
  'group-attendees': 'get_group_occurrence_attendees',
  'cancel-group': 'cancel_group_occurrence',
  'booking-activity': 'get_booking_activity',
  'retry-meeting': 'retry_conference',
  'retry-calendar-copy': 'retry_calendar_copy',
  'webhooks list': 'list_webhooks',
  'webhooks create': 'create_webhook',
  'webhooks update': 'update_webhook',
  'webhooks delete': 'delete_webhook',
  'webhooks rotate-secret': 'rotate_webhook_secret',
  'webhooks deliveries': 'list_webhook_deliveries',
  'slack list': 'list_slack_destinations',
  'slack create': 'create_slack_destination',
  'slack update': 'update_slack_destination',
  'slack delete': 'delete_slack_destination',
  'slack test': 'test_slack_destination',
  'one-time-links create': 'create_one_time_link',
  'one-time-links list': 'list_one_time_links',
  'one-time-links revoke': 'revoke_one_time_link',
  'workflows delete': 'delete_workflow',
  'workflows preview': 'preview_workflow',
  'workflows update': 'update_workflow',
  'workflows create': 'create_workflow',
  'workflows list': 'list_workflows',
  'workflows get': 'get_workflow',
  'workflows runs': 'list_workflow_runs',
  'scim-team-mappings create': 'create_scim_team_mapping',
  'scim-team-mappings delete': 'delete_scim_team_mapping',
} as const

export function cliCommands() {
  return COMMANDS
}

export const REST_COMMANDS = { 'branding upload': 'POST /api/v1/branding/logo' } as const

export const HELP = `Usage: hourmere COMMAND [--input FILE|-] [--output FILE] [--url ORIGIN]
       hourmere slots|book|reschedule [--duration-minutes MINUTES] [other options]
       hourmere polls list|get|results|close|cancel|delete|finalize --input -
       hourmere polls create|invite|resend-invitation|remove-voter|remove-unverified|rotate-link --input -
       hourmere polls view|join|recover|verify|vote|withdraw|reminder-opt-out --input -
       hourmere one-time-links create|list|revoke [--input FILE|-] [--url ORIGIN]
       hourmere branding get|set [--input FILE|-]
       hourmere audit-log list|settings|set-retention [--input FILE|-] [--url ORIGIN]
       hourmere sso providers list [--input FILE|-] [--url ORIGIN]
       hourmere sso policy [--input FILE|-] [--url ORIGIN]
       hourmere scim-team-mappings create|delete --input FILE|-
       hourmere team-home --input FILE|- [--url ORIGIN]
       hourmere routing-forms list|get|create|update|archive|publish|preview|public [--input FILE|-] [--url ORIGIN]
       hourmere routing-forms route --input FILE|- [--output FILE] [--url ORIGIN]
       hourmere routing-forms resolve|slots --input FILE|- [--output FILE] [--url ORIGIN]
       hourmere workflows list|get|runs|create|update|delete|preview [--input FILE|-] [--url ORIGIN]
       hourmere webhooks list [--json]
       hourmere webhooks create --input FILE|- (--json | --output FILE)
       hourmere webhooks update --input FILE|- [--json]
       hourmere webhooks delete --input FILE|- --yes [--json]
       hourmere webhooks rotate-secret --input FILE|- (--json | --output FILE)
       hourmere webhooks deliveries --input FILE|- [--json]
       hourmere branding upload --file IMAGE --content-type image/png|image/jpeg|image/webp
       hourmere --help | --version

Webhook reads require read or full scope and writes require full scope.
All webhook commands require personal ownership or a team owner/admin role.
Create takes JSON {url, events, isActive?}. Rotate-secret takes JSON {id}.
Both require --output FILE (new private file) or --json (stdout) and return the signing secret once.
Use --input - for JSON containing destination credentials.
Use a private file when stdout is logged.
Update takes JSON {id, events?, isActive?}. The URL is immutable.
Delete takes JSON {id} and requires --yes to confirm deletion of the endpoint and retained deliveries.
Deliveries takes JSON {id, after?} and returns up to 50 metadata rows. Pass nextAfter as after for the next page.
Events: booking.created, booking.rescheduled, booking.cancelled, booking.reschedule_requested,
        booking.reschedule_request_expired, booking.attendee_no_show_changed, workflow.executed.
Adding workflow.executed on create or update requires enabled workflows.
With WORKFLOWS_ENABLED=false, the server returns workflows_disabled (REST 404).
On create this takes precedence over webhooks_disabled (REST 409).
Endpoint events and delivery eventType are open enums. Ignore unknown event kinds.
Slack: slack create|list|update|delete|test (JSON input; list read/full, writes full).
Supply incoming-webhook URLs only through private JSON input; responses are masked.
Slack events: booking.created, booking.rescheduled, booking.cancelled,
  booking.reschedule_requested, booking.reschedule_request_expired.
Commands: whoami, profile, catalog, event, create-event, duplicate-event, update-event,
          set-event-notifications, schedules, schedule, slots, open-time-snippet,
          troubleshoot-availability,
          schedule-availability, save-availability,
          book, list, booking, reschedule, request-reschedule, cancel, set-no-show, booking-attendees, group-attendees, cancel-group,
          booking-activity, retry-meeting, retry-calendar-copy
          one-time-links create|list|revoke
Read booking details with booking --input FILE|- and JSON {bookingId}.
Requires a full, read or bookings key with access to the booking.
Read a public team directory with team-home --input FILE|- and JSON {handle}.
Use the exact-case team slug. Accepts read, bookings or full keys.
Meeting polls
  Every poll command requires JSON on stdin (--input -). Input files and --output are refused.
  Keep tokens, invitation addresses and idempotency keys out of command arguments and shell history.
  Reads accept read, bookings or full API keys. Writes require bookings or full.

  Host commands require personal event ownership or a current team owner/admin role.
    list accepts {} or limit and after (pass nextAfter from the previous page).
    get takes id and returns metadata. results takes id and includes the private roster,
      ballots, current revisions and advisory availability. Keep results stdout private.
    create takes eventTypeId, candidateStarts, deadlineAt, displayTimeZone, admissionMode
      and idempotencyKey, with optional durationMinutes and visibility. It reserves no time.
    create and rotate-link print publicLink only once for a public_link poll. Keep it private.
    invite takes id, invitees and idempotencyKey. resend-invitation and remove-voter take
      id, voterId and expectedHostRevision. resend-invitation also takes idempotencyKey.
    close, cancel, delete, remove-unverified and rotate-link take id and expectedHostRevision.
      rotate-link also takes idempotencyKey and immediately invalidates the old link.
    finalize takes id, slotId, bookerVoterId and attendeeVoterIds (including the booker),
      expectedResultsRevision, expectedBallotRevisions, acknowledgeConditional, idempotencyKey
      and optional locationOptionId. Use revisions from results and acknowledge if_need_be votes.
      After a lost response, replay the exact input with the original key to get booking metadata.

  Public commands act on existing polls. A host key cannot replace a voter’s token or consent.
    view takes token (from a public link, verification email or voter link).
    join takes publicToken, name, email, timeZone and optional locale. recover takes pollId and email.
    verify takes the emailed token and prints a newly minted votingToken once when issued. Keep it private.
    vote takes the voting token, complete votes, consent: true, expectedBallotRevision (initially 0)
      and optional responses. withdraw takes the voting token and expectedBallotRevision.
      On poll_changed, use view and reconcile before submitting again.
    reminder-opt-out takes the separate opt-out token from the poll email.
Waitlists: event-waitlist, set-event-waitlist, waitlist-entries, remove-waitlist-entry,
           join-waitlist, resend-waitlist-verification (arguments through JSON input).
SSO: sso providers list (optional limit 1–100, cursor), sso policy. Team owner/admin only,
     with read/full scope. OIDC SSO is off unless the operator sets SSO_OIDC_ENABLED=true.
Routing forms are on by default. The server operator can turn them off with ROUTING_FORMS_ENABLED=false.
Pass id, expectedRevision and an optional requestId (UUID) as JSON to routing-forms publish.
Publication requires full scope. Repeat the same input with the same requestId to recover its version.
Pass id and answers (keyed by question ID) as JSON to routing-forms preview. Preview requires full scope.
Pass slug and exactly one of handle or teamSlug as JSON to routing-forms public. Accepts read, bookings or full keys.
Pass slug, exactly one of handle or teamSlug, versionId from public, and answers keyed by question ID
as JSON to routing-forms route. Requires bookings or full scope. If the form changed, fetch public metadata again.
Stdout redacts routeToken and continuationUrl. Use --output FILE to save them in a new 0600 JSON file.
Existing files and symlinks are refused.
Pass routeToken in private JSON to routing-forms resolve to read current booking fields and prefill.
For routing-forms slots, also pass start and end as UTC timestamps, and optionally durationMinutes
and locationOptionId. Both commands require bookings or full scope and leave the receipt usable
until its original expiry. The input token is redacted from stdout, output files and errors.
For routed bookings, pass routeToken to book in private JSON instead of handle/teamSlug/slug or
oneTimeToken. Use bookings or full scope. The input token is redacted from stdout, output files and errors.
While routing forms are off, these calls return routing_forms_disabled. An exact committed booking
can still be replayed with the same input, idempotency key and API key.
Workflows: workflows list (owner {kind, id}; optional limit, cursor), workflows get (id).
           workflows runs (id; optional limit 1–100, cursor) returns run history. Pass nextCursor as cursor.
           workflows create (owner, idempotencyKey, name, scope, trigger, actions; optional enabled, conditions).
           workflows update (id, expectedRevision, and changed definition fields).
           workflows delete (id, expectedRevision); authorized repeats are safe.
           workflows preview (owner, definition fields, optional synthetic example) accepts JSON from stdin or a file.
           Read or full scope for list/get/runs. Full scope for create/update/delete/preview.
           Workflows are enabled by default. With WORKFLOWS_ENABLED=false, only reads,
           disable-only updates and deletion are available. Other commands return workflows_disabled.
Audit log: audit-log list (optional from, to, actorType, actorId, action, limit 1–100, cursor;
           newest first, UTC times), audit-log settings, audit-log set-retention
           ({"retention":"instance"|"forever"} or {"retention":"days","retentionDays":30–3650}).
           Full scope; owner/admin reads, owner changes retention.
Meeting length: --duration-minutes on slots, book or reschedule; 1–1440 whole minutes.
Event settings: create-event/update-event use JSON durationMinutes and allowedDurationsMinutes;
                1–12 distinct whole-minute lengths (1–1440) including the default. Requires full API key scope.
                minimumNoticeMinutes: 0–525600; bufferBeforeMinutes/bufferAfterMinutes: 0–1440,
                all whole minutes. bookingWindowDays: 1–3650 whole calendar days or null (unlimited).
Locations: create-event/update-event accept locations through JSON; slots/book accept locationOptionId.
Use microsoft_teams for one host with a writable Microsoft calendar selected for booking events.
           book also accepts inviteePhone (normalized E.164). Reschedule preserves the choice.
Booking limits: JSON maxBookingsPerDay, maxBookingsPerWeek, maxBookingsPerMonth;
                integers 1–1000 or null. Set ceilings must not descend from day to week to month.
Change deadlines: JSON rescheduleCutoffMinutes, cancelCutoffMinutes; minutes 1–525600 or null.
After booking: create-event/update-event accept --success-redirect-url URL,
               --success-redirect-parameters NAME,... (empty string clears the list),
               --success-redirect-include-invitee-personal-data true|false,
               --success-redirect-allow-embed-parent true|false, or --clear-success-redirect.
Invitee name/email become visible to the target website and its analytics when enabled.
Export: export --input FILE|- [--output FILE] [--include-routing-answers true|false].
Requires read/full scope; input: from, to (maximum 366 days), timeZone, optional filters and bom.
Streams CSV to a new private file or stdout. Set includeRoutingAnswers in JSON or use the flag.
Routing answers are available for personal exports. When routing forms are off, requesting them
returns routing_forms_disabled.
Arguments: JSON object in --input (MCP tool arguments; default {}). Use - for stdin.
Configuration: HOURMERE_URL (HTTPS origin or loopback HTTP), HOURMERE_API_KEY.
Secrets are never accepted as command-line flags. No .env or credential store is read.
stdout is JSON with management capabilities redacted (--json makes this explicit). --output creates a new 0600 JSON
file including returned management tokens; keep it private. Existing files are refused.
book requires an explicit random idempotencyKey in its input. Calls are never retried.
request-reschedule requires bookingId, an explicit idempotencyKey and optional plain-text note.
The original slot remains booked until the invitee moves or cancels; expiry keeps it booked.
Imported bookings remain read-only in the original system (managementPolicy=local_only_read_only).
Cancel, reschedule, set-no-show and retry commands refuse them with imported_booking_read_only.
For one-time links, book input uses oneTimeToken instead of handle/teamSlug/slug.
one-time-links create requires bookings or full scope, eventTypeId and an explicit idempotencyKey.
Its secret URL is printed once to stdout; --output is refused and nothing is stored.
one-time-links list requires read or full; revoke requires bookings or full and eventTypeId plus id.
open-time-snippet --json --input - generates text/HTML and direct links without reserving times.
Input: eventTypeId or slug, from/to instants (at most 31 days), optional count (1–10),
locale, displayTimeZone and durationMinutes. Requires read, bookings or full scope.
troubleshoot-availability explains which times of one local day can be booked and why
others cannot. Input: eventTypeId, date (YYYY-MM-DD), optional timeZone and durationMinutes.
Requires full scope and personal ownership or team owner/admin; otherwise event_type_not_found.
See https://hourmere.com/docs/cli for complete usage.
`

interface Options {
  command: keyof typeof COMMANDS | keyof typeof REST_COMMANDS
  file?: string
  contentType?: string
  input?: string
  output?: string
  url?: string
  durationMinutes?: number
  includeRoutingAnswers?: boolean
  successRedirect?: Record<string, unknown>
  clearSuccessRedirect?: boolean
}

function parse(argv: readonly string[]): Options {
  const parts = [...argv]
  const first = parts.shift()
  const command =
    first === 'sso'
      ? parts[0] === 'providers'
        ? `${first} ${parts.shift()} ${parts.shift() ?? ''}`
        : `${first} ${parts.shift() ?? ''}`
      : first === 'polls' ||
          first === 'one-time-links' ||
          first === 'branding' ||
          first === 'webhooks' ||
          first === 'slack' ||
          first === 'workflows' ||
          first === 'routing-forms' ||
          first === 'scim-team-mappings' ||
          first === 'audit-log'
        ? `${first} ${parts.shift() ?? ''}`
        : first
  const rest = parts
  if (!command || (!Object.hasOwn(COMMANDS, command) && !Object.hasOwn(REST_COMMANDS, command)))
    throw new CliError('invalid_command')
  const options: Options = { command: command as Options['command'] }
  const seen = new Set<string>()
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    if (
      !flag ||
      ![
        '--file',
        '--content-type',
        '--json',
        '--input',
        '--output',
        '--url',
        '--yes',
        '--duration-minutes',
        '--include-routing-answers',
        '--success-redirect-url',
        '--success-redirect-parameters',
        '--success-redirect-include-invitee-personal-data',
        '--success-redirect-allow-embed-parent',
        '--clear-success-redirect',
      ].includes(flag) ||
      seen.has(flag)
    )
      throw new CliError('invalid_options')
    seen.add(flag)
    if (flag === '--json') continue
    if (flag === '--yes') {
      if (command !== 'webhooks delete') throw new CliError('invalid_options')
      continue
    }
    const redirectFlag =
      flag.startsWith('--success-redirect-') || flag === '--clear-success-redirect'
    if (redirectFlag && !['create-event', 'update-event'].includes(command))
      throw new CliError('invalid_options')
    if (flag === '--clear-success-redirect') {
      options.clearSuccessRedirect = true
      continue
    }
    const value = rest[++i]
    if (
      value === undefined ||
      (value === '' && flag !== '--success-redirect-parameters') ||
      (value.startsWith('-') && !(flag === '--input' && value === '-'))
    )
      throw new CliError('invalid_options')
    if (flag === '--file' || flag === '--content-type') {
      if (command !== 'branding upload') throw new CliError('invalid_options')
      if (flag === '--file') options.file = value
      else options.contentType = value
    }
    if (flag === '--input') options.input = value
    if (flag === '--output') options.output = value
    if (flag === '--url') options.url = value
    if (flag === '--duration-minutes') {
      if (!['slots', 'book', 'reschedule'].includes(command)) throw new CliError('invalid_options')
      const durationMinutes = Number(value)
      if (!/^[0-9]+$/.test(value) || durationMinutes < 1 || durationMinutes > 1440)
        throw new CliError('invalid_request')
      options.durationMinutes = durationMinutes
    }
    if (flag === '--include-routing-answers') {
      if (command !== 'export' || (value !== 'true' && value !== 'false'))
        throw new CliError('invalid_options')
      options.includeRoutingAnswers = value === 'true'
    }
    if (redirectFlag) {
      options.successRedirect ??= {}
      const redirect = options.successRedirect
      if (flag === '--success-redirect-url') redirect.url = value
      if (flag === '--success-redirect-parameters')
        redirect.parameters = value === '' ? [] : value.split(',')
      if (
        flag === '--success-redirect-include-invitee-personal-data' ||
        flag === '--success-redirect-allow-embed-parent'
      ) {
        if (value !== 'true' && value !== 'false') throw new CliError('invalid_options')
        redirect[
          flag === '--success-redirect-include-invitee-personal-data'
            ? 'includeInviteePersonalData'
            : 'allowEmbedParent'
        ] = value === 'true'
      }
    }
  }
  if (command.startsWith('polls ') && (options.input !== '-' || options.output))
    throw new CliError('poll_stdin_required')
  if (options.clearSuccessRedirect && options.successRedirect)
    throw new CliError('invalid_success_redirect_options')
  if (command === 'one-time-links create' && options.output)
    throw new CliError('one_time_link_output_forbidden')
  if (
    ['webhooks create', 'webhooks rotate-secret'].includes(command) &&
    !seen.has('--json') &&
    !options.output
  )
    throw new CliError('webhook_secret_output_required')
  if (command === 'webhooks delete' && !seen.has('--yes'))
    throw new CliError('webhook_delete_confirmation_required')
  if (
    command === 'branding upload' &&
    (!options.file ||
      options.input ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(options.contentType ?? ''))
  )
    throw new CliError('invalid_options')
  return options
}

async function readInput(path: string | undefined, stdin: AsyncIterable<Uint8Array | string>) {
  if (path === undefined) return {}
  let text: string
  if (path === '-') {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of stdin) {
      const data = Buffer.from(chunk)
      size += data.byteLength
      if (size > MAX_INPUT_BYTES) throw new CliError('input_too_large')
      chunks.push(data)
    }
    text = Buffer.concat(chunks).toString('utf8')
  } else {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new CliError('invalid_input_file')
      if (stat.size > MAX_INPUT_BYTES) throw new CliError('input_too_large')
      // A file may grow after stat; keep the actual read bounded too.
      const data = Buffer.alloc(MAX_INPUT_BYTES + 1)
      let size = 0
      for (;;) {
        const { bytesRead } = await handle.read(data, size, data.length - size, null)
        size += bytesRead
        if (size > MAX_INPUT_BYTES) throw new CliError('input_too_large')
        if (bytesRead === 0) break
      }
      text = data.subarray(0, size).toString('utf8')
    } finally {
      await handle.close()
    }
  }
  try {
    const input: unknown = JSON.parse(text)
    if (!isObject(input)) throw new Error()
    return input
  } catch {
    throw new CliError('invalid_json_input')
  }
}

// Redact exact secrets everywhere (including nested text), rather than trusting field names.
function printable(result: unknown, secrets: readonly string[], idempotencyKey?: string): string {
  // Idempotency keys can be a single punctuation character. Redact an echoed value before
  // serializing so it cannot alter JSON syntax or unrelated strings such as timestamps.
  let json = JSON.stringify(
    result,
    (_name, value) => (idempotencyKey && value === idempotencyKey ? '[redacted]' : value),
    2,
  )
  for (const secret of secrets) {
    if (secret) json = json.replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]')
  }
  return `${json}\n`
}

export async function runCli(options: {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  stdin: AsyncIterable<Uint8Array | string>
  stdout: (text: string) => unknown | Promise<unknown>
  stderr: (text: string) => void
  fetch?: typeof fetch
}): Promise<number> {
  if (options.argv.length === 1 && options.argv[0] === '--version') {
    options.stdout(`${version}\n`)
    return 0
  }
  if (options.argv.length === 0 || (options.argv.length === 1 && options.argv[0] === '--help')) {
    options.stdout(HELP)
    return 0
  }
  let output: Awaited<ReturnType<typeof open>> | undefined
  let exportOutputPath: string | undefined
  let called = false
  let command: string | undefined
  let idempotencyKey: string | undefined
  const secrets = [options.env.HOURMERE_API_KEY ?? '']
  try {
    const args = parse(options.argv)
    command = args.command
    const url = endpoint(args.url ?? options.env.HOURMERE_URL)
    const key = options.env.HOURMERE_API_KEY ?? ''
    if (!/^hm_[A-Za-z0-9_-]{1,512}$/.test(key)) throw new CliError('invalid_api_key')
    const input = await readInput(args.input, options.stdin)
    const routeTokenPattern = /^[A-Za-z0-9_-]{43}$/
    const routeToken =
      ['book', 'routing-forms resolve', 'routing-forms slots'].includes(args.command) &&
      typeof input.routeToken === 'string' &&
      routeTokenPattern.test(input.routeToken)
        ? input.routeToken
        : ''
    if (routeToken) secrets.push(routeToken)
    if (args.command.startsWith('polls ')) {
      for (const field of ['token', 'publicToken']) {
        const value = input[field]
        if (typeof value === 'string') secrets.push(value)
      }
      if (typeof input.idempotencyKey === 'string') idempotencyKey = input.idempotencyKey
    }
    const slackUrl =
      args.command.startsWith('slack ') && typeof input.url === 'string' ? input.url : ''
    if (slackUrl) secrets.push(slackUrl)
    if (args.durationMinutes !== undefined) {
      if (Object.hasOwn(input, 'durationMinutes') && input.durationMinutes !== args.durationMinutes)
        throw new CliError('invalid_duration')
      input.durationMinutes = args.durationMinutes
    }
    if (args.includeRoutingAnswers !== undefined) {
      if (
        Object.hasOwn(input, 'includeRoutingAnswers') &&
        input.includeRoutingAnswers !== args.includeRoutingAnswers
      )
        throw new CliError('invalid_request')
      input.includeRoutingAnswers = args.includeRoutingAnswers
    }
    if (args.clearSuccessRedirect) {
      if (Object.hasOwn(input, 'successRedirect') && input.successRedirect !== null)
        throw new CliError('invalid_success_redirect_options')
      input.successRedirect = null
    } else if (args.successRedirect) {
      if (Object.hasOwn(input, 'successRedirect') && !isObject(input.successRedirect))
        throw new CliError('invalid_success_redirect_options')
      const redirect = isObject(input.successRedirect) ? { ...input.successRedirect } : {}
      for (const [field, value] of Object.entries(args.successRedirect)) {
        if (
          Object.hasOwn(redirect, field) &&
          JSON.stringify(redirect[field]) !== JSON.stringify(value)
        )
          throw new CliError('invalid_success_redirect_options')
        redirect[field] = value
      }
      input.successRedirect = redirect
    }
    // Webhook arguments go to the shared strict schema after the server scope check.
    const checkBookingTokens = !args.command.startsWith('webhooks ')
    if (
      args.command === 'book' &&
      Object.hasOwn(input, 'routeToken') &&
      (typeof input.routeToken !== 'string' ||
        !routeTokenPattern.test(input.routeToken) ||
        ['handle', 'teamSlug', 'slug', 'oneTimeToken', 'waitlistToken', 'expectedGroupSlotId'].some(
          (field) => Object.hasOwn(input, field),
        ))
    )
      throw new CliError('invalid_request')
    if (checkBookingTokens && Object.hasOwn(input, 'oneTimeToken')) {
      if (
        args.command !== 'book' ||
        typeof input.oneTimeToken !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(input.oneTimeToken)
      )
        throw new CliError('invalid_one_time_token')
      secrets.push(input.oneTimeToken)
      if (['handle', 'teamSlug', 'slug'].some((field) => Object.hasOwn(input, field)))
        throw new CliError('invalid_request')
    }
    if (checkBookingTokens && Object.hasOwn(input, 'manageToken')) {
      if (typeof input.manageToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.manageToken))
        throw new CliError('invalid_manage_token')
      secrets.push(input.manageToken)
    }
    if (checkBookingTokens && Object.hasOwn(input, 'waitlistToken')) {
      if (typeof input.waitlistToken !== 'string' || input.waitlistToken.length > 256)
        throw new CliError('invalid_waitlist_token')
      secrets.push(input.waitlistToken)
    }
    if (
      ['book', 'one-time-links create'].includes(args.command) &&
      (typeof input.idempotencyKey !== 'string' ||
        !/^[\x20-\x7e]{1,255}$/.test(input.idempotencyKey))
    )
      throw new CliError('idempotency_key_required')
    if (
      args.command === 'one-time-links create' &&
      !/^[\x21-\x7e]{1,255}$/.test(input.idempotencyKey as string)
    )
      throw new CliError('idempotency_key_required')
    // Reserve private output before calling the server, so path errors cannot lose a one-time value.
    if (args.command === 'export') exportOutputPath = args.output
    if (args.output) output = await open(args.output, 'wx', 0o600)
    called = args.command !== 'branding upload'
    const result =
      args.command === 'branding upload'
        ? await uploadLogo({
            url,
            key,
            path: args.file ?? '',
            contentType: args.contentType ?? '',
            fetch: (...request) => {
              called = true
              return (options.fetch ?? fetch)(...request)
            },
          })
        : await callTool({
            url,
            key,
            tool: COMMANDS[args.command],
            input,
            fetch: options.fetch,
          })
    if (args.command === 'export') {
      await downloadCsv({
        url,
        key,
        path: result.downloadPath,
        fetch: options.fetch,
        write: async (chunk) => {
          if (output) await output.writeFile(chunk)
          else await options.stdout(chunk)
        },
      })
      if (output) {
        await output.sync()
        options.stdout('{"outputWritten":true}\n')
      }
      return 0
    }
    const oneTimeToken = typeof input.oneTimeToken === 'string' ? input.oneTimeToken : ''
    const waitlistToken = typeof input.waitlistToken === 'string' ? input.waitlistToken : ''
    if (args.command === 'routing-forms route') {
      // Replace the whole link before replacing the token inside its fragment.
      const { continuationUrl, routeToken } = result
      secrets.unshift(
        typeof continuationUrl === 'string' ? continuationUrl : '',
        typeof routeToken === 'string' ? routeToken : '',
      )
    }
    if (output) {
      await output.writeFile(
        printable(result, [key, oneTimeToken, waitlistToken, slackUrl].concat(routeToken)),
      )
      await output.sync()
      await options.stdout('{"outputWritten":true}\n')
    } else {
      const token = typeof result.manageToken === 'string' ? result.manageToken : ''
      if (args.command.startsWith('polls ')) {
        delete result.manageToken
        delete result.manageUrl
        if (args.command !== 'polls create' && args.command !== 'polls rotate-link') {
          if (typeof result.publicLink === 'string') secrets.push(result.publicLink)
          delete result.publicLink
        }
        if (args.command === 'polls finalize' && isObject(result.booking)) {
          if (typeof result.booking.manageToken === 'string')
            secrets.push(result.booking.manageToken)
          delete result.booking.manageToken
          delete result.booking.manageUrl
        }
      }
      await options.stdout(printable(result, [...secrets, token], idempotencyKey))
    }
    return 0
  } catch (error) {
    if (output && exportOutputPath) {
      await output.close().catch(() => {})
      await unlink(exportOutputPath).catch(() => {})
    }
    const code = error instanceof CliError ? error.code : called ? 'output_failed' : 'file_error'
    options.stderr(
      printable(
        {
          error: code,
          ...(error instanceof CliError && error.detail !== undefined && { message: error.detail }),
          ...(error instanceof CliError && error.field !== undefined && { field: error.field }),
          ...(error instanceof CliError && error.meetingPoll),
          ...(error instanceof CliError && error.status !== undefined && { status: error.status }),
          ...(error instanceof CliError &&
            error.retryAfterSeconds !== undefined && {
              retryAfterSeconds: error.retryAfterSeconds,
            }),
          ...(called &&
            !(command === 'open-time-snippet' && code === 'slot_snippets_disabled') && {
              outcomeMayBeUnknown: true,
            }),
        },
        secrets,
        idempotencyKey,
      ),
    )
    return error instanceof CliError && ['http_error', 'request_failed'].includes(error.code)
      ? 3
      : 1
  } finally {
    await output?.close().catch(() => {})
  }
}
