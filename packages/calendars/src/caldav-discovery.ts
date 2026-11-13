import { SaxesParser } from 'saxes'
import {
  CALDAV_MAX_RESPONSE_BYTES,
  CalDavError,
  type CalDavPrivateTarget,
  type CalDavTransport,
  calDavUrl,
  redactCalDavRequest,
  sendCalDav,
} from './caldav-transport.ts'

const DAV = 'DAV:'
const CAL = 'urn:ietf:params:xml:ns:caldav'
interface Element {
  uri: string
  name: string
  text: string
  attributes: Record<string, string>
  children: Element[]
}
function children(node: Element, uri: string, name: string) {
  return node.children.filter((n) => n.uri === uri && n.name === name)
}
function first(node: Element, uri: string, name: string) {
  return children(node, uri, name)[0]
}
function parse(body: string): Element {
  if (Buffer.byteLength(body) > CALDAV_MAX_RESPONSE_BYTES) throw new CalDavError('invalid_response')
  const stack: Element[] = []
  let root: Element | undefined
  let count = 0
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => {
    throw new CalDavError('invalid_response')
  })
  parser.on('opentag', (tag) => {
    if (++count > 10_000 || stack.length >= 32) throw new CalDavError('invalid_response')
    const node = {
      uri: tag.uri,
      name: tag.local,
      text: '',
      attributes: Object.fromEntries(Object.values(tag.attributes).map((a) => [a.name, a.value])),
      children: [],
    }
    stack.at(-1)?.children.push(node)
    root ??= node
    stack.push(node)
  })
  parser.on('text', (text) => {
    const node = stack.at(-1)
    if (node) node.text += text
  })
  parser.on('cdata', (text) => {
    const node = stack.at(-1)
    if (node) node.text += text
  })
  parser.on('closetag', () => {
    stack.pop()
  })
  try {
    parser.write(body).close()
  } catch {
    throw new CalDavError('invalid_response')
  }
  if (!root || root.uri !== DAV || root.name !== 'multistatus')
    throw new CalDavError('invalid_response')
  return root
}
function properties(response: Element): Element[] {
  return children(response, DAV, 'propstat').flatMap((stat) =>
    /^HTTP\/\d(?:\.\d)? 200(?: |$)/.test(first(stat, DAV, 'status')?.text.trim() ?? '')
      ? (first(stat, DAV, 'prop')?.children ?? [])
      : [],
  )
}
export interface CalDavCalendar {
  url: string
  displayName: string | null
  supportsEvents: boolean
  canWrite: boolean
}
export interface CalDavDiscoveryResult {
  principalUrl: string
  calendarHomeUrl: string
  calendars: CalDavCalendar[]
}
export interface CalDavDiscoveryClient {
  discover(
    credentials: { serverUrl: string; username: string; password: string },
    signal?: AbortSignal,
  ): Promise<CalDavDiscoveryResult>
}
/** Pure orchestration with injected transport. No persistence, logging, busy reads or writes. */
export function createCalDavDiscovery(
  transport: CalDavTransport = sendCalDav,
  options: {
    privateTargets?: readonly CalDavPrivateTarget[]
    /** Operator/provider trust configuration; never derived from an untrusted response. */
    allowedOrigins?: readonly string[]
  } = {},
): CalDavDiscoveryClient {
  const configuredTargets = (options.privateTargets ?? []).map((target) =>
    Object.freeze({ ...target }),
  )
  const configuredOrigins = [...(options.allowedOrigins ?? [])]
  return {
    async discover(credentials, outerSignal) {
      const privateTargets = configuredTargets
      const server = calDavUrl(credentials.serverUrl, privateTargets)
      const origins = new Set([new URL(server).origin, ...configuredOrigins])
      const signal = AbortSignal.any([
        ...(outerSignal ? [outerSignal] : []),
        AbortSignal.timeout(30_000),
      ])
      if (
        !credentials.username ||
        credentials.username.includes(':') ||
        !credentials.password ||
        credentials.username.length > 1024 ||
        credentials.password.length > 8192 ||
        !credentials.username.isWellFormed() ||
        !credentials.password.isWellFormed() ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: reject Basic credential controls
        /[\u0000-\u001f\u007f-\u009f]/.test(credentials.username + credentials.password)
      )
        throw new CalDavError('unauthorized')
      const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
      function resolve(value: string, base: string): string {
        if (!value.isWellFormed() || /[\s\\]/.test(value))
          throw new CalDavError('destination_refused')
        let url: string
        try {
          url = calDavUrl(new URL(value, base).href, privateTargets)
        } catch {
          throw new CalDavError('destination_refused')
        }
        if (!origins.has(new URL(url).origin)) throw new CalDavError('destination_refused')
        return url
      }
      async function propfind(
        start: string,
        depth: '0' | '1',
      ): Promise<{ root: Element; url: string }> {
        let url = start
        for (let redirects = 0; redirects <= 3; redirects++) {
          if (signal.aborted) throw new CalDavError('timeout')
          // Bound injected transports too; cancellation is also passed to the adapter.
          const response = await new Promise<Awaited<ReturnType<CalDavTransport>>>(
            (resolveResponse, reject) => {
              const abort = () => reject(new CalDavError('timeout'))
              signal.addEventListener('abort', abort, { once: true })
              Promise.resolve()
                .then(() =>
                  transport(
                    redactCalDavRequest({
                      url,
                      depth,
                      authorization,
                      privateTargets,
                      signal,
                      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><c:calendar-home-set/><d:resourcetype/><d:displayname/><d:current-user-privilege-set/><c:supported-calendar-component-set/></d:prop></d:propfind>',
                    }),
                  ),
                )
                .then(resolveResponse, (error: unknown) =>
                  reject(
                    error instanceof CalDavError ? error : new CalDavError('transport_failed'),
                  ),
                )
                .finally(() => signal.removeEventListener('abort', abort))
            },
          )
          if (
            [301, 302, 307, 308].includes(response.status) &&
            response.location &&
            redirects < 3
          ) {
            url = resolve(response.location, url)
            continue
          }
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
          return { root: parse(response.body), url }
        }
        throw new CalDavError('invalid_response')
      }
      function href(root: Element, base: string, uri: string, name: string): string {
        const responses = children(root, DAV, 'response').map((response) => {
          const target = first(response, DAV, 'href')?.text.trim()
          if (!target) throw new CalDavError('invalid_response')
          const url = resolve(target, base)
          if (new URL(url).origin !== new URL(base).origin)
            throw new CalDavError('destination_refused')
          return { response, url }
        })
        const selected =
          responses.find(({ url }) => url === base || url === `${base}/` || `${url}/` === base) ??
          (responses.length === 1 ? responses[0] : undefined)
        if (!selected) throw new CalDavError('invalid_response')
        const values = properties(selected.response).filter((p) => p.uri === uri && p.name === name)
        const value = values.flatMap((p) => children(p, DAV, 'href'))[0]?.text.trim()
        if (!value) throw new CalDavError('invalid_response')
        // RFC 4918 section 8.3 resolves relative references against the request URI.
        return resolve(value, base)
      }
      // Explicit DAV paths are preserved; origin-only inputs use RFC 6764 discovery.
      const initial =
        new URL(server).pathname === '/' ? new URL('/.well-known/caldav', server).href : server
      const entry = await propfind(initial, '0')
      const principalUrl = resolve(
        href(entry.root, entry.url, DAV, 'current-user-principal'),
        entry.url,
      )
      const principal = await propfind(principalUrl, '0')
      const calendarHomeUrl = resolve(
        href(principal.root, principal.url, CAL, 'calendar-home-set'),
        principal.url,
      )
      const home = await propfind(calendarHomeUrl, '1')
      const calendars: CalDavCalendar[] = []
      for (const response of children(home.root, DAV, 'response')) {
        const props = properties(response)
        const prop = (uri: string, name: string) =>
          props.find((p) => p.uri === uri && p.name === name)
        const resource = prop(DAV, 'resourcetype')
        if (!resource || !first(resource, CAL, 'calendar')) continue
        const target = first(response, DAV, 'href')?.text.trim()
        if (!target) throw new CalDavError('invalid_response')
        const privileges = prop(DAV, 'current-user-privilege-set')
        const components = prop(CAL, 'supported-calendar-component-set')
        calendars.push({
          url: resolve(target, home.url),
          displayName: prop(DAV, 'displayname')?.text.trim() || null,
          // RFC 4791 section 5.2.3: an absent component set accepts every component.
          supportsEvents:
            !components ||
            components.children.some(
              (n) => n.uri === CAL && n.name === 'comp' && n.attributes.name === 'VEVENT',
            ),
          canWrite: Boolean(
            privileges &&
              children(privileges, DAV, 'privilege').some(
                (p) =>
                  first(p, DAV, 'write') ||
                  first(p, DAV, 'all') ||
                  first(p, DAV, 'write-content') ||
                  first(p, DAV, 'bind'),
              ),
          ),
        })
        if (calendars.length > 256) throw new CalDavError('invalid_response')
      }
      return { principalUrl, calendarHomeUrl, calendars }
    },
  }
}
