import { CalDavError } from './caldav-transport.ts'

export interface CalDavBusy {
  /** Ephemeral resource-local identity. Callers must hash it before persistence. */
  instanceId: string
  kind: 'timed' | 'all_day'
  start: string
  end: string
}
export interface CalDavBusyOptions {
  start: string
  end: string
  /** An independently verified IANA calendar timezone, never the machine timezone. */
  timeZone?: string | null
  /** Verified calendar-user-address-set values; never infer these from the login name. */
  ownerAddresses?: readonly string[]
}
type Property = { name: string; params: Map<string, string>; value: string }
const invalid = (): never => {
  throw new CalDavError('invalid_response')
}

function property(line: string): Property {
  // Quoted parameter values may contain colons or semicolons (e.g. attendee CN).
  let quoted = false
  let colon = -1
  const parts: string[] = []
  let from = 0
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    if (!quoted && line[i] === ';') {
      parts.push(line.slice(from, i))
      from = i + 1
    }
    if (!quoted && line[i] === ':') {
      parts.push(line.slice(from, i))
      colon = i
      break
    }
  }
  if (colon < 0 || quoted) return invalid()
  const name = parts.shift()?.toUpperCase() ?? ''
  if (!/^[A-Z0-9-]+$/.test(name)) return invalid()
  const params = new Map<string, string>()
  for (const part of parts) {
    const equal = part.indexOf('=')
    if (equal < 1) return invalid()
    const key = part.slice(0, equal).toUpperCase()
    let value = part.slice(equal + 1)
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (params.has(key) || !value) return invalid()
    params.set(key, value)
  }
  return { name, params, value: line.slice(colon + 1) }
}

function date(value: string) {
  if (!/^\d{8}$/.test(value) || value.startsWith('0000')) return invalid()
  return Temporal.PlainDate.from(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`)
}
function time(p: Property, zone: string | null | undefined, embeddedZones: Set<string>) {
  if (!/^\d{8}T\d{6}Z?$/.test(p.value)) return invalid()
  const value = `${date(p.value.slice(0, 8))}T${p.value.slice(9, 11)}:${p.value.slice(11, 13)}:${p.value.slice(13, 15)}`
  if (p.params.has('VALUE') && p.params.get('VALUE') !== 'DATE-TIME') return invalid()
  if (p.value.endsWith('Z')) {
    if (p.params.has('TZID')) return invalid()
    return Temporal.Instant.from(`${value}Z`)
  }
  const tz = p.params.get('TZID') ?? zone
  // Embedded definitions may override even IANA names. No VTIMEZONE engine exists here.
  if (!tz || embeddedZones.has(tz) || /^[+-]/.test(tz)) return invalid()
  return Temporal.PlainDateTime.from(value)
    .toZonedDateTime(tz, { disambiguation: 'reject' })
    .toInstant()
}

/** Consume server-expanded VEVENTs only. Any incomplete/unsupported resource fails the refresh. */
export function parseCalDavBusy(ical: string, options: CalDavBusyOptions): CalDavBusy[] {
  try {
    if (
      Buffer.byteLength(ical, 'utf8') > 1_048_576 ||
      Array.from(ical).some((c) => c.charCodeAt(0) < 32 && !['\r', '\n', '\t'].includes(c))
    )
      return invalid()
    const lines = ical
      .replace(/\r\n/g, '\n')
      .replace(/\n[ \t]/g, '')
      .split('\n')
    if (lines.length > 50_000) return invalid()
    const stack: string[] = []
    const events: Property[][] = []
    const embeddedZones = new Set<string>()
    let event: Property[] | undefined
    let closed = false
    for (const line of lines) {
      if (!line) continue
      if (line.length > 65_536 || closed) return invalid()
      const p = property(line)
      if (p.name === 'BEGIN') {
        const component = p.value.toUpperCase()
        if (stack.length === 0 && component !== 'VCALENDAR') return invalid()
        if (stack.length > 4 || (stack.length > 0 && component === 'VCALENDAR')) return invalid()
        if (component === 'VEVENT') {
          if (stack.length !== 1 || event || events.length >= 10_000) return invalid()
          event = []
          events.push(event)
        }
        stack.push(component)
      } else if (p.name === 'END') {
        if (!stack.length || stack.pop() !== p.value.toUpperCase()) return invalid()
        if (p.value.toUpperCase() === 'VEVENT') event = undefined
        if (!stack.length) closed = true
      } else {
        if (!stack.length) return invalid()
        if (stack.at(-1) === 'VEVENT') event?.push(p)
        if (stack.at(-1) === 'VTIMEZONE' && p.name === 'TZID') embeddedZones.add(p.value)
      }
    }
    if (!closed || stack.length) return invalid()
    const start = Temporal.Instant.from(options.start)
    const end = Temporal.Instant.from(options.end)
    if (
      Temporal.Instant.compare(start, end) >= 0 ||
      end.epochMilliseconds - start.epochMilliseconds > 410 * 86_400_000
    )
      return invalid()
    const identities = new Set<string>()
    const owners = new Set(options.ownerAddresses?.map((v) => v.toLowerCase()))
    const result: CalDavBusy[] = []
    for (const props of events) {
      const single = (name: string) => {
        const values = props.filter((p) => p.name === name)
        if (values.length > 1) return invalid()
        return values[0]
      }
      if (props.some((p) => ['RRULE', 'RDATE', 'EXDATE', 'EXRULE'].includes(p.name)))
        return invalid()
      const uid = single('UID')?.value
      const recurrence = single('RECURRENCE-ID')
      if (!uid || uid.length > 4096 || recurrence?.params.has('RANGE')) return invalid()
      const instanceId = JSON.stringify([uid, recurrence?.value ?? null])
      if (identities.has(instanceId)) return invalid()
      identities.add(instanceId)
      if (
        single('STATUS')?.value.toUpperCase() === 'CANCELLED' ||
        single('TRANSP')?.value.toUpperCase() === 'TRANSPARENT'
      )
        continue
      if (
        props.some(
          (p) =>
            p.name === 'ATTENDEE' &&
            p.params.get('PARTSTAT')?.toUpperCase() === 'DECLINED' &&
            owners.has(p.value.toLowerCase()),
        )
      )
        continue
      const first = single('DTSTART')
      const last = single('DTEND')
      const duration = single('DURATION')
      if (!first || (last && duration)) return invalid()
      if (first.params.get('VALUE') === 'DATE') {
        if (
          first.params.has('TZID') ||
          (last && (last.params.get('VALUE') !== 'DATE' || last.params.has('TZID')))
        )
          return invalid()
        const from = date(first.value)
        let to = last ? date(last.value) : from.add({ days: 1 })
        if (duration) {
          if (!/^P(?:\d+W|\d+D)$/.test(duration.value)) return invalid()
          to = from.add(Temporal.Duration.from(duration.value))
        }
        if (Temporal.PlainDate.compare(from, to) >= 0) return invalid()
        // Preserve dates: availability interprets these in the host schedule timezone.
        result.push({ instanceId, kind: 'all_day', start: from.toString(), end: to.toString() })
      } else {
        const from = time(first, options.timeZone, embeddedZones)
        let to = last ? time(last, options.timeZone, embeddedZones) : from
        if (duration) {
          if (!/^P(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/.test(duration.value))
            return invalid()
          const d = Temporal.Duration.from(duration.value)
          // Calendar-day durations across DST require local calendar arithmetic.
          if (!first.value.endsWith('Z') && (d.weeks || d.days)) return invalid()
          to = from.add({
            seconds:
              d.weeks * 604800 + d.days * 86400 + d.hours * 3600 + d.minutes * 60 + d.seconds,
          })
        }
        if (Temporal.Instant.compare(from, to) > 0) return invalid()
        if (Temporal.Instant.compare(from, to) === 0) continue
        if (Temporal.Instant.compare(from, end) < 0 && Temporal.Instant.compare(to, start) > 0)
          result.push({ instanceId, kind: 'timed', start: from.toString(), end: to.toString() })
      }
    }
    return result
  } catch {
    // Never propagate provider-controlled text, including event titles and timezone identifiers.
    return invalid()
  }
}
