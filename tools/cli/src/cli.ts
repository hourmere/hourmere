import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { CliError, callTool, endpoint, isObject, MAX_INPUT_BYTES, version } from './client.ts'

export const COMMANDS = {
  whoami: 'whoami',
  profile: 'get_profile',
  catalog: 'list_event_types',
  event: 'get_event_type',
  'create-event': 'create_event_type',
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
  slots: 'find_available_slots',
  'open-time-snippet': 'generate_open_time_snippet',
  book: 'create_booking',
  list: 'list_bookings',
  reschedule: 'reschedule_booking',
  cancel: 'cancel_booking',
  'set-no-show': 'set_attendee_no_show',
  'booking-attendees': 'get_booking_attendees',
  'retry-meeting': 'retry_conference',
  'retry-calendar-copy': 'retry_calendar_copy',
  'one-time-links create': 'create_one_time_link',
  'one-time-links list': 'list_one_time_links',
  'one-time-links revoke': 'revoke_one_time_link',
} as const

export const HELP = `Usage: hourmere COMMAND [--input FILE|-] [--output FILE] [--url ORIGIN]
       hourmere slots|book|reschedule [--duration-minutes MINUTES] [other options]
       hourmere one-time-links create|list|revoke [--input FILE|-] [--url ORIGIN]
       hourmere --help | --version

Commands: whoami, profile, catalog, event, create-event, update-event,
          set-event-notifications, schedules, schedule, slots, open-time-snippet,
          book, list, reschedule, cancel, set-no-show, booking-attendees, retry-meeting, retry-calendar-copy
          one-time-links create|list|revoke
Waitlists: event-waitlist, set-event-waitlist, waitlist-entries, remove-waitlist-entry,
           join-waitlist, resend-waitlist-verification (arguments through JSON input).
Meeting length: --duration-minutes on slots, book or reschedule; 1–1440 whole minutes.
Event settings: create-event/update-event use JSON durationMinutes and allowedDurationsMinutes;
                1–12 distinct lengths including the default. Requires full API key scope.
After booking: create-event/update-event accept --success-redirect-url URL,
               --success-redirect-parameters NAME,... (empty string clears the list),
               --success-redirect-include-invitee-personal-data true|false,
               --success-redirect-allow-embed-parent true|false, or --clear-success-redirect.
Invitee name/email become visible to the target website and its analytics when enabled.
Arguments: JSON object in --input (MCP tool arguments; default {}). Use - for stdin.
Configuration: HOURMERE_URL (HTTPS origin or loopback HTTP), HOURMERE_API_KEY.
Secrets are never accepted as command-line flags. No .env or credential store is read.
stdout is JSON with management capabilities redacted (--json makes this explicit). --output creates a new 0600 JSON
file including returned management tokens; keep it private. Existing files are refused.
book requires an explicit random idempotencyKey in its input. Calls are never retried.
Imported bookings remain read-only in the original system (managementPolicy=local_only_read_only).
Cancel, reschedule, set-no-show and retry commands refuse them with imported_booking_read_only.
For one-time links, book input uses oneTimeToken instead of handle/teamSlug/slug.
one-time-links create requires bookings or full scope, eventTypeId and an explicit idempotencyKey.
Its secret URL is printed once to stdout; --output is refused and nothing is stored.
one-time-links list requires read or full; revoke requires bookings or full and eventTypeId plus id.
open-time-snippet --json --input - generates text/HTML and direct links without reserving times.
Input: eventTypeId or slug, from/to instants (at most 31 days), optional count (1–10),
locale, displayTimeZone and durationMinutes. Requires read, bookings or full scope.
See https://hourmere.com/docs/cli for complete usage.
`

interface Options {
  command: keyof typeof COMMANDS
  input?: string
  output?: string
  url?: string
  durationMinutes?: number
  successRedirect?: Record<string, unknown>
  clearSuccessRedirect?: boolean
}

function parse(argv: readonly string[]): Options {
  const parts = [...argv]
  const first = parts.shift()
  const command = first === 'one-time-links' ? `${first} ${parts.shift() ?? ''}` : first
  const rest = parts
  if (!command || !Object.hasOwn(COMMANDS, command)) throw new CliError('invalid_command')
  const options: Options = { command: command as keyof typeof COMMANDS }
  const seen = new Set<string>()
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    if (
      !flag ||
      ![
        '--json',
        '--input',
        '--output',
        '--url',
        '--duration-minutes',
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
  if (options.clearSuccessRedirect && options.successRedirect)
    throw new CliError('invalid_success_redirect_options')
  if (command === 'one-time-links create' && options.output)
    throw new CliError('one_time_link_output_forbidden')
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
function printable(result: unknown, secrets: readonly string[]): string {
  let json = JSON.stringify(result, null, 2)
  for (const secret of secrets) {
    if (secret) json = json.replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]')
  }
  return `${json}\n`
}

export async function runCli(options: {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  stdin: AsyncIterable<Uint8Array | string>
  stdout: (text: string) => void
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
  let called = false
  const secrets = [options.env.HOURMERE_API_KEY ?? '']
  try {
    const args = parse(options.argv)
    const url = endpoint(args.url ?? options.env.HOURMERE_URL)
    const key = options.env.HOURMERE_API_KEY ?? ''
    if (!/^hm_[A-Za-z0-9_-]{1,512}$/.test(key)) throw new CliError('invalid_api_key')
    const input = await readInput(args.input, options.stdin)
    if (args.durationMinutes !== undefined) {
      if (Object.hasOwn(input, 'durationMinutes') && input.durationMinutes !== args.durationMinutes)
        throw new CliError('invalid_duration')
      input.durationMinutes = args.durationMinutes
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
    if (Object.hasOwn(input, 'oneTimeToken')) {
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
    if (Object.hasOwn(input, 'manageToken')) {
      if (typeof input.manageToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.manageToken))
        throw new CliError('invalid_manage_token')
      secrets.push(input.manageToken)
    }
    if (Object.hasOwn(input, 'waitlistToken')) {
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
    // Reserve the private output before making a booking: a path error must not lose its token.
    if (args.output) output = await open(args.output, 'wx', 0o600)
    called = true
    const result = await callTool({
      url,
      key,
      tool: COMMANDS[args.command],
      input,
      fetch: options.fetch,
    })
    const oneTimeToken = typeof input.oneTimeToken === 'string' ? input.oneTimeToken : ''
    const waitlistToken = typeof input.waitlistToken === 'string' ? input.waitlistToken : ''
    if (output) {
      await output.writeFile(printable(result, [key, oneTimeToken, waitlistToken]))
      await output.sync()
      options.stdout('{"outputWritten":true}\n')
    } else {
      const token = typeof result.manageToken === 'string' ? result.manageToken : ''
      options.stdout(printable(result, [...secrets, token]))
    }
    return 0
  } catch (error) {
    const code = error instanceof CliError ? error.code : called ? 'output_failed' : 'file_error'
    options.stderr(
      printable(
        {
          error: code,
          ...(error instanceof CliError && error.detail !== undefined && { message: error.detail }),
          ...(error instanceof CliError && error.field !== undefined && { field: error.field }),
          ...(error instanceof CliError && error.status !== undefined && { status: error.status }),
          ...(error instanceof CliError &&
            error.retryAfterSeconds !== undefined && {
              retryAfterSeconds: error.retryAfterSeconds,
            }),
          ...(called && { outcomeMayBeUnknown: true }),
        },
        secrets,
      ),
    )
    return error instanceof CliError && ['http_error', 'request_failed'].includes(error.code)
      ? 3
      : 1
  } finally {
    await output?.close().catch(() => {})
  }
}
