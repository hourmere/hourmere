type CaptureValue = string | number | boolean | null | CaptureValue[] | CaptureObject
type CaptureObject = { [key: string]: CaptureValue }
type Collection = 'Users' | 'Groups' | 'ServiceProviderConfig'
type CaptureQuery = Partial<{
  filter: string
  attributes: string
  excludedAttributes: string
  startIndex: number
  count: number
}>

export interface ScimCaptureEntry {
  method: string
  path: string
  query?: CaptureQuery
  request?: CaptureValue
  status: number
  response?: CaptureValue
}

const redacted = '[redacted]'
const maxBodyBytes = 64 * 1024
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const resource = /^\/scim\/v2\/[^/]+\/(Users|Groups|ServiceProviderConfig)(?:\/([^/]+))?\/?$/
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const filter = /^(userName|displayName|externalId|groups\.value)\s+eq\s+("(?:[^"\\]|\\.)*")$/
const memberFilter = /^members\[value\s+eq\s+"([0-9a-f-]+)"\]$/i
const structured = new Set([
  'Resources',
  'Operations',
  'name',
  'emails',
  'members',
  'patch',
  'filter',
])
const counts = new Set(['totalResults', 'startIndex', 'itemsPerPage', 'maxResults'])
const flags = new Set(['active', 'primary', 'supported'])
const textFields = new Set([
  'userName',
  'displayName',
  'givenName',
  'familyName',
  'formatted',
  'type',
  'title',
  'preferredLanguage',
  'locale',
])
const attributes = new Set([
  'id',
  'externalId',
  'userName',
  'name',
  'name.givenName',
  'name.familyName',
  'displayName',
  'emails',
  'active',
  'title',
  'preferredLanguage',
  'locale',
  'members',
  'groups',
])
const schemaIds = new Set([
  'urn:ietf:params:scim:schemas:core:2.0:User',
  'urn:ietf:params:scim:schemas:core:2.0:Group',
  'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  'urn:ietf:params:scim:api:messages:2.0:Error',
])
const operations = new Set(['add', 'remove', 'replace'])
const errorTypes = new Set([
  'invalidFilter',
  'invalidPath',
  'invalidSyntax',
  'invalidValue',
  'mutability',
  'noTarget',
  'uniqueness',
])

async function jsonBody(message: Request | Response): Promise<unknown> {
  if (!message.body) return undefined
  const mime = message.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (mime !== 'application/scim+json' && mime !== 'application/json') return redacted
  const reader = message.clone().body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBodyBytes) {
        void reader.cancel().catch(() => {})
        return redacted
      }
      chunks.push(value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch {
    return redacted
  } finally {
    reader.releaseLock()
  }
}

function known(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : redacted
}

/** Capture only the SCIM exchange with synthetic fixture values, leaving the HTTP response intact. */
export function createScimCapture(syntheticValues: readonly string[] = []) {
  const entries: ScimCaptureEntry[] = []
  const literals = new Set(['work', ...syntheticValues])
  const identifiers = new Map<string, Map<string, string>>()

  function alias(kind: string, value: unknown): string {
    if (typeof value !== 'string' || !uuid.test(value)) return redacted
    let aliases = identifiers.get(kind)
    if (!aliases) {
      aliases = new Map()
      identifiers.set(kind, aliases)
    }
    const id = value.toLowerCase()
    const label = aliases.get(id) ?? `${kind}-${aliases.size + 1}`
    aliases.set(id, label)
    return label
  }

  function patchPath(value: unknown): string {
    if (typeof value !== 'string') return redacted
    const member = memberFilter.exec(value)?.[1]
    return member ? `members[value eq "${alias('user', member)}"]` : known(value, attributes)
  }

  function project(value: unknown, kind: string, member = false, depth = 0): CaptureValue {
    if (depth > 8) return redacted
    if (Array.isArray(value)) return value.map((item) => project(item, kind, member, depth + 1))
    if (typeof value === 'string') return known(value, literals)
    if (typeof value === 'boolean' || value === null) return value
    if (typeof value !== 'object') return redacted

    const body = value as Record<string, unknown>
    const projected: CaptureObject = {}
    for (const [key, item] of Object.entries(body)) {
      if (key === 'id') projected[key] = alias(kind, item)
      else if (key === 'externalId') projected[key] = alias(`keycloak-${kind}`, item)
      else if (key === 'schemas' && Array.isArray(item))
        projected[key] = item.map((schema) => known(schema, schemaIds))
      else if (key === 'op') projected[key] = known(item, operations)
      else if (key === 'path') projected[key] = patchPath(item)
      else if (key === 'scimType') projected[key] = known(item, errorTypes)
      else if (key === 'status' && typeof item === 'string' && /^[45]\d\d$/.test(item))
        projected[key] = item
      else if (textFields.has(key)) projected[key] = known(item, literals)
      else if (flags.has(key) && typeof item === 'boolean') projected[key] = item
      else if (counts.has(key) && typeof item === 'number' && Number.isSafeInteger(item))
        projected[key] = item
      else if (structured.has(key))
        projected[key] = project(item, kind, key === 'members', depth + 1)
      else if (key === 'value') {
        if (member) projected[key] = alias('user', item)
        else if (body.path === 'externalId') projected[key] = alias(`keycloak-${kind}`, item)
        else projected[key] = project(item, kind, body.path === 'members', depth + 1)
      }
    }
    return projected
  }

  function query(params: URLSearchParams, kind: string): CaptureQuery {
    const result: CaptureQuery = {}
    const expression = params.get('filter')
    if (expression !== null) {
      const match = filter.exec(expression)
      result.filter = redacted
      if (match?.[1] && match[2]) {
        // The filter's quoted value uses the same escapes as one JSON string.
        try {
          const field = match[1]
          const value: unknown = JSON.parse(match[2])
          const safeValue =
            field === 'groups.value'
              ? alias('group', value)
              : field === 'externalId'
                ? alias(`keycloak-${kind}`, value)
                : known(value, literals)
          result.filter = `${field} eq ${JSON.stringify(safeValue)}`
        } catch {
          // Invalid filter values are still forwarded unchanged to Hourmere.
        }
      }
    }
    for (const key of ['attributes', 'excludedAttributes'] as const) {
      const value = params.get(key)
      if (value !== null)
        result[key] = value
          .split(',')
          .map((field) => known(field.trim(), attributes))
          .join(',')
    }
    for (const key of ['startIndex', 'count'] as const) {
      const value = params.get(key)
      if (value !== null && /^\d{1,9}$/.test(value)) result[key] = Number(value)
    }
    return result
  }

  return {
    entries: entries as readonly ScimCaptureEntry[],
    async fetch(request: Request, appFetch: (request: Request) => Response | Promise<Response>) {
      const url = new URL(request.url)
      if (!url.pathname.startsWith('/scim/v2/')) return appFetch(request)
      const match = resource.exec(url.pathname)
      const collection = match?.[1] as Collection | undefined
      const kind = collection === 'Users' ? 'user' : 'group'
      const path = collection
        ? `/${collection}${match?.[2] ? `/${alias(kind, match[2])}` : ''}`
        : redacted
      const capturedQuery = query(url.searchParams, kind)
      const [input, response] = await Promise.all([jsonBody(request), appFetch(request)])
      const output = await jsonBody(response)
      entries.push({
        method: known(request.method, methods),
        path,
        ...(Object.keys(capturedQuery).length && { query: capturedQuery }),
        ...(input !== undefined && { request: project(input, kind) }),
        status: response.status,
        ...(output !== undefined && { response: project(output, kind) }),
      })
      return response
    },
  }
}
