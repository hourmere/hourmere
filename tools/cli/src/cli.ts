import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { CliError, callTool, endpoint, isObject, MAX_INPUT_BYTES, version } from './client.ts'

export const COMMANDS = {
  whoami: 'whoami',
  profile: 'get_profile',
  catalog: 'list_event_types',
  event: 'get_event_type',
  schedules: 'list_schedules',
  schedule: 'get_schedule',
  slots: 'find_available_slots',
  book: 'create_booking',
  list: 'list_bookings',
  reschedule: 'reschedule_booking',
  cancel: 'cancel_booking',
  'retry-meeting': 'retry_conference',
  'retry-calendar-copy': 'retry_calendar_copy',
} as const

export const HELP = `Usage: hourmere COMMAND [--input FILE|-] [--output FILE] [--url ORIGIN]
       hourmere slots|book|reschedule [--duration-minutes MINUTES] [other options]
       hourmere --help | --version

Commands: whoami, profile, catalog, event, schedules, schedule, slots,
          book, list, reschedule, cancel, retry-meeting, retry-calendar-copy
Meeting length: --duration-minutes on slots, book or reschedule; 1–1440 whole minutes.
Arguments: JSON object in --input (MCP tool arguments; default {}). Use - for stdin.
Configuration: HOURMERE_URL (HTTPS origin or loopback HTTP), HOURMERE_API_KEY.
Secrets are never accepted as command-line flags. No .env or credential store is read.
stdout is JSON with management capabilities redacted. --output creates a new 0600 JSON
file including returned management tokens; keep it private. Existing files are refused.
book requires an explicit random idempotencyKey in its input. Calls are never retried.
See https://hourmere.com/docs/cli for complete usage.
`

interface Options {
  command: keyof typeof COMMANDS
  input?: string
  output?: string
  url?: string
  durationMinutes?: number
}

function parse(argv: readonly string[]): Options {
  const [command, ...rest] = argv
  if (!command || !Object.hasOwn(COMMANDS, command)) throw new CliError('invalid_command')
  const options: Options = { command: command as keyof typeof COMMANDS }
  const seen = new Set<string>()
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    const value = rest[i + 1]
    if (
      !flag ||
      !['--input', '--output', '--url', '--duration-minutes'].includes(flag) ||
      seen.has(flag)
    )
      throw new CliError('invalid_options')
    if (!value || (value.startsWith('-') && !(flag === '--input' && value === '-')))
      throw new CliError('invalid_options')
    seen.add(flag)
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
  }
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
    if (Object.hasOwn(input, 'manageToken')) {
      if (typeof input.manageToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.manageToken))
        throw new CliError('invalid_manage_token')
      secrets.push(input.manageToken)
    }
    if (
      args.command === 'book' &&
      (typeof input.idempotencyKey !== 'string' ||
        !/^[\x20-\x7e]{1,255}$/.test(input.idempotencyKey))
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
    const inputToken = typeof input.manageToken === 'string' ? input.manageToken : ''
    if (output) {
      await output.writeFile(printable(result, [key]))
      await output.sync()
      options.stdout('{"outputWritten":true}\n')
    } else {
      const token = typeof result.manageToken === 'string' ? result.manageToken : ''
      options.stdout(printable(result, [key, inputToken, token]))
    }
    return 0
  } catch (error) {
    const code = error instanceof CliError ? error.code : called ? 'output_failed' : 'file_error'
    options.stderr(
      printable(
        {
          error: code,
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
