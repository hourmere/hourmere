import {
  CALDAV_MAX_RESPONSE_BYTES,
  CalDavError,
  type CalDavPrivateTarget,
  type CalDavTransport,
  calDavUrl,
  redactCalDavRequest,
  sendCalDav,
} from './caldav-transport.ts'
import { children, type Element, first, parse, properties } from './caldav-xml.ts'

const DAV = 'DAV:'
const CAL = 'urn:ietf:params:xml:ns:caldav'
const ns = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"'
const escapeXml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c,
  )
export interface CalDavSyncCursor {
  syncToken: string | null
  etags: Record<string, string>
  start: string
  end: string
}
export interface CalDavSyncResult {
  full: boolean
  syncToken: string | null
  etags: Record<string, string>
  resources: { href: string; etag: string; calendarData: string }[]
  deleted: string[]
  calendarTimezone: string | null
}
export interface CalDavSyncClient {
  sync(
    credentials: { serverUrl: string; username: string; password: string },
    input: { calendarUrl: string; start: string; end: string; previous?: CalDavSyncCursor },
    signal?: AbortSignal,
  ): Promise<CalDavSyncResult>
}
/** Bounded, stateless protocol reader. Returned iCalendar bodies must never be persisted/logged. */
export function createCalDavSyncClient(
  transport: CalDavTransport = sendCalDav,
  options: {
    privateTargets?: readonly CalDavPrivateTarget[]
    allowedOrigins?: readonly string[]
  } = {},
): CalDavSyncClient {
  const privateTargets = (options.privateTargets ?? []).map((target) =>
    Object.freeze({ ...target }),
  )
  const allowedOrigins = [...(options.allowedOrigins ?? [])]
  return {
    async sync(credentials, input, outerSignal) {
      const signal = AbortSignal.any([
        ...(outerSignal ? [outerSignal] : []),
        AbortSignal.timeout(30_000),
      ])
      const server = calDavUrl(credentials.serverUrl, privateTargets)
      const origins = new Set([new URL(server).origin, ...allowedOrigins])
      function resolve(value: string, base: string) {
        try {
          if (!value.isWellFormed() || /[\s\\]/.test(value)) throw new Error()
          const url = calDavUrl(new URL(value, base).href, privateTargets)
          if (!origins.has(new URL(url).origin)) throw new Error()
          return url
        } catch {
          throw new CalDavError('destination_refused')
        }
      }
      const calendarUrl = resolve(input.calendarUrl, server)
      const start = Temporal.Instant.from(input.start)
      const end = Temporal.Instant.from(input.end)
      if (
        end.epochMilliseconds <= start.epochMilliseconds ||
        end.epochMilliseconds - start.epochMilliseconds > 410 * 86400_000
      )
        throw new CalDavError('invalid_response')
      const stamp = (instant: Temporal.Instant) =>
        instant.toString({ smallestUnit: 'second' }).replace(/[-:]/g, '')
      const range = `start="${stamp(start)}" end="${stamp(end)}"`
      if (
        !credentials.username ||
        credentials.username.includes(':') ||
        !credentials.password ||
        credentials.username.length > 1024 ||
        credentials.password.length > 8192 ||
        !credentials.username.isWellFormed() ||
        !credentials.password.isWellFormed() ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Basic credential controls
        /[\u0000-\u001f\u007f-\u009f]/.test(credentials.username + credentials.password)
      )
        throw new CalDavError('unauthorized')
      const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
      async function request(method: 'PROPFIND' | 'REPORT', body: string) {
        let url = calendarUrl
        for (let redirects = 0; redirects <= 3; redirects++) {
          if (signal.aborted) throw new CalDavError('timeout')
          const response = await new Promise<Awaited<ReturnType<CalDavTransport>>>(
            (accept, reject) => {
              const abort = () => reject(new CalDavError('timeout'))
              signal.addEventListener('abort', abort, { once: true })
              Promise.resolve()
                .then(() =>
                  transport(
                    redactCalDavRequest({
                      url,
                      method,
                      body,
                      authorization,
                      depth: method === 'REPORT' ? '1' : '0',
                      signal,
                      privateTargets,
                    }),
                  ),
                )
                .then(accept, (error: unknown) =>
                  reject(
                    new CalDavError(error instanceof CalDavError ? error.code : 'transport_failed'),
                  ),
                )
                .finally(() => signal.removeEventListener('abort', abort))
            },
          )
          if (Buffer.byteLength(response.body) > CALDAV_MAX_RESPONSE_BYTES)
            throw new CalDavError('invalid_response')
          if (
            [301, 302, 307, 308].includes(response.status) &&
            response.location &&
            redirects < 3
          ) {
            url = resolve(response.location, url)
            continue
          }
          return { ...response, url }
        }
        throw new CalDavError('invalid_response')
      }
      function checked(response: Awaited<ReturnType<typeof request>>) {
        if (response.status !== 207)
          throw new CalDavError(
            response.status === 401
              ? 'unauthorized'
              : response.status === 403
                ? 'forbidden'
                : response.status === 429
                  ? 'rate_limited'
                  : 'unavailable',
          )
        return parse(response.body)
      }
      const capabilityResponse = await request(
        'PROPFIND',
        `<d:propfind ${ns}><d:prop><d:supported-report-set/><d:sync-token/><c:calendar-timezone/></d:prop></d:propfind>`,
      )
      const capabilityRoot = checked(capabilityResponse)
      const capabilityRows = children(capabilityRoot, DAV, 'response')
      if (capabilityRows.length !== 1) throw new CalDavError('invalid_response')
      const cap = capabilityRows[0]
      if (!cap) throw new CalDavError('invalid_response')
      const capHref = resolve(first(cap, DAV, 'href')?.text.trim() ?? '', capabilityResponse.url)
      if (capHref.replace(/\/$/, '') !== capabilityResponse.url.replace(/\/$/, ''))
        throw new CalDavError('invalid_response')
      const props = properties(cap)
      const supportsSync = props.some(
        (p) =>
          p.uri === DAV &&
          p.name === 'supported-report-set' &&
          children(p, DAV, 'supported-report').some((s) => {
            const report = first(s, DAV, 'report')
            return report && first(report, DAV, 'sync-collection')
          }),
      )
      const advertisedToken =
        props.find((p) => p.uri === DAV && p.name === 'sync-token')?.text.trim() || null
      const calendarTimezone =
        props.find((p) => p.uri === CAL && p.name === 'calendar-timezone')?.text || null
      if (advertisedToken && advertisedToken.length > 8192)
        throw new CalDavError('invalid_response')
      const eventFields = [
        'UID',
        'DTSTART',
        'DTEND',
        'DURATION',
        'RECURRENCE-ID',
        'RRULE',
        'RDATE',
        'EXDATE',
        'STATUS',
        'TRANSP',
        'ATTENDEE',
      ]
        .map((name) => `<c:prop name="${name}"/>`)
        .join('')
      const dataProp = `<d:prop><d:getetag/><c:calendar-data><c:comp name="VCALENDAR"><c:prop name="VERSION"/><c:comp name="VEVENT">${eventFields}</c:comp><c:comp name="VTIMEZONE"><c:allprop/><c:allcomp/></c:comp></c:comp><c:expand ${range}/></c:calendar-data></d:prop>`
      function rows(root: Element, base: string, allowDeletes = false) {
        const seen = new Set<string>()
        return children(root, DAV, 'response').map((row) => {
          const rawHref = first(row, DAV, 'href')?.text.trim()
          if (!rawHref) throw new CalDavError('invalid_response')
          const href = resolve(rawHref, base)
          const collection = new URL(base)
          const resource = new URL(href)
          if (
            resource.origin !== collection.origin ||
            !resource.pathname.startsWith(`${collection.pathname.replace(/\/$/, '')}/`) ||
            seen.has(href)
          )
            throw new CalDavError('invalid_response')
          seen.add(href)
          if (seen.size > 2048) throw new CalDavError('invalid_response')
          const status = first(row, DAV, 'status')?.text.trim()
          if (allowDeletes && /^HTTP\/\d(?:\.\d)? 404(?: |$)/.test(status ?? ''))
            return { href, deleted: true, etag: '', calendarData: '' }
          if (status && !/^HTTP\/\d(?:\.\d)? 200(?: |$)/.test(status))
            throw new CalDavError('invalid_response')
          const props = properties(row)
          const etag = props.find((p) => p.uri === DAV && p.name === 'getetag')?.text.trim()
          if (!etag || etag.length > 1024) throw new CalDavError('invalid_response')
          const calendarData = props.find((p) => p.uri === CAL && p.name === 'calendar-data')?.text
          return { href, deleted: false, etag, calendarData }
        })
      }
      const previous = input.previous
      if (
        previous &&
        ((previous.syncToken?.length ?? 0) > 8192 || Object.keys(previous.etags).length > 2048)
      )
        throw new CalDavError('invalid_response')
      if (
        supportsSync &&
        previous?.syncToken &&
        previous.start === input.start &&
        previous.end === input.end
      ) {
        const response = await request(
          'REPORT',
          `<d:sync-collection ${ns}><d:sync-token>${escapeXml(previous.syncToken)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
        )
        let invalidToken = false
        if (response.status === 403)
          invalidToken = Boolean(first(parse(response.body, 'error'), DAV, 'valid-sync-token'))
        if (!invalidToken && ![405, 501].includes(response.status)) {
          const root = checked(response)
          const token = first(root, DAV, 'sync-token')?.text.trim()
          if (!token || token.length > 8192) throw new CalDavError('invalid_response')
          const updates = rows(root, response.url, true)
          const deleted = updates.filter((r) => r.deleted).map((r) => r.href)
          const changed = updates.filter((r) => !r.deleted && previous.etags[r.href] !== r.etag)
          const resources: CalDavSyncResult['resources'] = []
          for (let offset = 0; offset < changed.length; offset += 100) {
            const batch = changed.slice(offset, offset + 100)
            const fetched = await request(
              'REPORT',
              `<c:calendar-multiget ${ns}>${dataProp}${batch.map((r) => `<d:href>${escapeXml(new URL(r.href).pathname)}</d:href>`).join('')}</c:calendar-multiget>`,
            )
            const items = rows(checked(fetched), fetched.url)
            if (items.length !== batch.length) throw new CalDavError('invalid_response')
            for (const item of items) {
              if (
                batch.find((r) => r.href === item.href)?.etag !== item.etag ||
                item.calendarData === undefined
              )
                throw new CalDavError('invalid_response')
              resources.push({ href: item.href, etag: item.etag, calendarData: item.calendarData })
            }
          }
          const etags = { ...previous.etags }
          for (const href of deleted) delete etags[href]
          for (const item of resources) etags[item.href] = item.etag
          if (Object.keys(etags).length > 2048) throw new CalDavError('invalid_response')
          return { full: false, syncToken: token, etags, resources, deleted, calendarTimezone }
        }
      }
      const response = await request(
        'REPORT',
        `<c:calendar-query ${ns}>${dataProp}<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
      )
      const resources = rows(checked(response), response.url).map((r) => {
        if (r.calendarData === undefined) throw new CalDavError('invalid_response')
        return { href: r.href, etag: r.etag, calendarData: r.calendarData }
      })
      return {
        full: true,
        syncToken: supportsSync ? advertisedToken : null,
        etags: Object.fromEntries(resources.map((r) => [r.href, r.etag])),
        resources,
        deleted: [],
        calendarTimezone,
      }
    },
  }
}
