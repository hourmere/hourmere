type Schema = {
  $ref?: string
  properties?: Record<string, Schema>
  items?: Schema
  allOf?: Schema[]
  anyOf?: Schema[]
  oneOf?: Schema[]
}
type Operation = {
  parameters?: { in: string; name: string }[]
  requestBody?: { content?: Record<string, { schema: Schema }> }
  responses?: Record<string, { content?: Record<string, { schema: Schema }> }>
}
type Document = { paths: Record<string, Record<string, Operation>>; components?: unknown }
type Request = {
  method: string
  path: string
  query?: string[]
  headers?: string[]
  body?: string[] | Record<string, unknown>
  response?: Record<string, string[]>
}
type Fields = { requests: Request[]; webhookPayloadFields?: string[] }
type Recipe = Fields & {
  format: string
  id: string
  title: string
  webhookEvents: string[]
  connections: { kind: string; purpose: string }[]
  settings: { documentation: string }
}

/** Diagnostics never echo the potentially sensitive input. */
export function validateMakeSecrets(raw: string) {
  const errors: string[] = []
  if (/\bhm_[A-Za-z0-9_-]+/i.test(raw)) errors.push('embedded API key')
  if (/\bwhsec_[A-Za-z0-9_-]+/i.test(raw)) errors.push('embedded webhook secret')
  if (/\bBearer[ \t]+(?!<YOUR_[A-Z0-9_]+>)[A-Za-z0-9_~+/.=-]+/i.test(raw))
    errors.push('embedded bearer token')
  if (/\b(?:hook[s]?\.)[a-z0-9.-]*make\.com\//i.test(raw)) errors.push('embedded Make hook URL')
  for (const match of raw.matchAll(/https?:\/\/[^\s"<>`\\)]+/gi)) {
    try {
      const url = new URL(match[0])
      const allowed =
        /^(?:[a-z0-9-]+\.)*example\.(?:com|org|net)$/.test(url.hostname) ||
        ['help.make.com', 'apps.make.com', 'developers.make.com', 'jsr.io'].includes(
          url.hostname,
        ) ||
        (url.hostname === 'github.com' && url.pathname.startsWith('/hourmere/'))
      if (!allowed || url.username || url.password) errors.push('non-placeholder URL')
    } catch {
      errors.push('invalid URL')
    }
  }
  return errors
}

function resolve(schema: Schema | undefined, document: Document): Schema | undefined {
  if (!schema?.$ref) return schema
  if (!schema.$ref.startsWith('#/')) return undefined
  let value: unknown = document
  for (const part of schema.$ref.slice(2).split('/')) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')]
  }
  return value as Schema
}
function hasField(schema: Schema | undefined, field: string, document: Document): boolean {
  const resolved = resolve(schema, document)
  if (!resolved) return false
  if (!field) return true
  const alternatives = resolved.allOf ?? resolved.anyOf ?? resolved.oneOf
  if (alternatives) return alternatives.some((item) => hasField(item, field, document))
  if (resolved.items) return hasField(resolved.items, field.replace(/^\[\]\.?/, ''), document)
  const [head, ...tail] = field.split('.')
  return (
    !!head &&
    Object.hasOwn(resolved.properties ?? {}, head) &&
    hasField(resolved.properties?.[head], tail.join('.'), document)
  )
}
function objectFields(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const field = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(child))
      return [
        field,
        ...child.flatMap((item) =>
          item && typeof item === 'object'
            ? objectFields(item as Record<string, unknown>, field)
            : [],
        ),
      ]
    return child && typeof child === 'object'
      ? [field, ...objectFields(child as Record<string, unknown>, field)]
      : [field]
  })
}
export function validateMakeFields(
  value: Fields,
  document: Document,
  payloadFields: readonly string[],
) {
  const errors: string[] = []
  for (const request of value.requests ?? []) {
    const operation = document.paths[request.path]?.[request.method?.toLowerCase()]
    if (!operation) {
      errors.push('unknown REST method/path')
      continue
    }
    for (const [kind, fields] of [
      ['query', request.query],
      ['header', request.headers],
    ] as const) {
      for (const field of fields ?? []) {
        if (
          !operation.parameters?.some(
            (parameter) =>
              parameter.in === kind &&
              (kind === 'header'
                ? parameter.name.toLowerCase() === field.toLowerCase()
                : parameter.name === field),
          )
        ) {
          errors.push('unknown request parameter')
        }
      }
    }
    const body = Array.isArray(request.body) ? request.body : objectFields(request.body ?? {})
    for (const field of body) {
      if (!hasField(operation.requestBody?.content?.['application/json']?.schema, field, document))
        errors.push('unknown request body field')
    }
    for (const [status, fields] of Object.entries(request.response ?? {})) {
      for (const field of fields) {
        if (
          !hasField(
            operation.responses?.[status]?.content?.['application/json']?.schema,
            field,
            document,
          )
        )
          errors.push('unknown response field')
      }
    }
  }
  for (const field of value.webhookPayloadFields ?? []) {
    if (!payloadFields.includes(field)) errors.push('unknown webhook payload field')
  }
  return errors
}

/** Offline metadata is deliberately not a Make blueprint or credential container. */
export function validateMakeRecipe(
  value: unknown,
  document: Document,
  events: readonly string[],
  payloadFields: readonly string[] = [],
) {
  const raw = JSON.stringify(value)
  const errors = validateMakeSecrets(raw)
  function inspect(item: unknown, key = '') {
    if (typeof item === 'string') {
      if (
        /secret|password|token|authorization|api[-_]?key$/i.test(key) &&
        !/^<YOUR_[A-Z0-9_]+>$/.test(item)
      )
        errors.push('credential field must be a placeholder')
    } else if (Array.isArray(item)) {
      for (const child of item) inspect(child, key)
    } else if (item && typeof item === 'object') {
      for (const [childKey, child] of Object.entries(item)) inspect(child, childKey)
    }
  }
  inspect(value)
  const recipe = value as Recipe
  if (
    recipe?.format !== 'hourmere.make.manual-recipe.v1' ||
    typeof recipe.id !== 'string' ||
    typeof recipe.title !== 'string' ||
    !Array.isArray(recipe.webhookEvents) ||
    !Array.isArray(recipe.requests) ||
    !Array.isArray(recipe.connections) ||
    typeof recipe.settings?.documentation !== 'string'
  )
    return [...errors, 'invalid manual recipe shape']
  if (!recipe.requests.length) errors.push('missing REST references')
  errors.push(...validateMakeFields(recipe, document, payloadFields))
  for (const event of recipe.webhookEvents) {
    if (!events.includes(event)) errors.push('unknown webhook event')
  }
  errors.push(...validateMakeReferences(raw, document, events, payloadFields))
  return errors
}

/** hourmere-fields fences declare operation context; inline kind:field markers are checked too. */
export function validateMakeReferences(
  raw: string,
  document: Document,
  events: readonly string[],
  payloadFields: readonly string[] = [],
) {
  const errors = validateMakeSecrets(raw)
  for (const match of raw.matchAll(/(?<![A-Za-z0-9_.-])booking\.[a-z_]+/g)) {
    if (
      !events.includes(match[0]) &&
      !Object.values(document.paths).some((path) =>
        Object.values(path).some((operation) =>
          Object.values(operation.responses ?? {}).some((response) =>
            hasField(response.content?.['application/json']?.schema, match[0], document),
          ),
        ),
      )
    )
      errors.push('unknown inline webhook event')
  }
  for (const match of raw.matchAll(/\/api\/v1\/[A-Za-z0-9_/{}/-]+/g)) {
    if (!Object.hasOwn(document.paths, match[0])) errors.push('unknown inline REST path')
  }
  for (const match of raw.matchAll(
    /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+`?(\/api\/v1\/[A-Za-z0-9_/{}/-]+)/g,
  )) {
    if (!document.paths[match[2] ?? '']?.[match[1]?.toLowerCase() ?? ''])
      errors.push('unknown inline REST method')
  }
  const requests: Request[] = []
  for (const match of raw.matchAll(/```hourmere-fields\s*\n([\s\S]*?)\n```/g)) {
    try {
      const fields = JSON.parse(match[1] ?? '') as Fields
      errors.push(...validateMakeFields(fields, document, payloadFields))
      requests.push(...fields.requests)
    } catch {
      errors.push('invalid field declaration')
    }
  }
  for (const match of raw.matchAll(/`(body|query|headers|payload|response):([A-Za-z0-9_.:-]+)`/g)) {
    const [, kind, field = ''] = match
    if (kind === 'response' && !/^\d{3}:/.test(field)) continue
    if (kind === 'payload') {
      errors.push(
        ...validateMakeFields(
          { requests: [], webhookPayloadFields: [field] },
          document,
          payloadFields,
        ),
      )
      continue
    }
    let candidates = requests.filter((request) =>
      kind === 'response'
        ? !!request.response?.[field.split(':')[0] ?? ''] &&
          (request.response[field.split(':')[0] ?? ''] ?? []).includes(
            field.split(':').slice(1).join(':'),
          )
        : Object.hasOwn(request, kind ?? ''),
    )
    if (kind === 'response' && !candidates.length)
      candidates = requests.filter((request) => request.response?.[field.split(':')[0] ?? ''])
    if (kind === 'response' && candidates.length > 1) {
      const [status = '', ...path] = field.split(':')
      for (const request of candidates)
        errors.push(
          ...validateMakeFields(
            {
              requests: [
                {
                  method: request.method,
                  path: request.path,
                  response: { [status]: [path.join(':')] },
                },
              ],
            },
            document,
            payloadFields,
          ),
        )
      continue
    }
    if (candidates.length !== 1) {
      errors.push('ambiguous inline field context')
      continue
    }
    const request = candidates[0] as Request
    const [status = '', ...path] = field.split(':')
    const reference =
      kind === 'response' ? { response: { [status]: [path.join(':')] } } : { [kind ?? '']: [field] }
    errors.push(
      ...validateMakeFields(
        { requests: [{ method: request.method, path: request.path, ...reference }] },
        document,
        payloadFields,
      ),
    )
  }
  for (const match of raw.matchAll(/`(Webhook-[A-Za-z-]+)`/gi)) {
    if (!payloadFields.includes(`headers.${match[1]?.toLowerCase()}`))
      errors.push('unknown webhook header')
  }
  // Mapped text uses Make braces; uppercase names are explicit operator placeholders.
  for (const match of raw.matchAll(/\{\{([a-z][A-Za-z0-9_.]*)\}\}/g)) {
    if (!payloadFields.includes(match[1] ?? '')) errors.push('unknown mapped payload field')
  }
  // JSON examples (including curl --data and inline update bodies) must fit an
  // operation declared by this document, with no undeclared nested properties.
  const jsonExamples = [
    ...raw.matchAll(/```json\s*\n([\s\S]*?)\n```/g),
    ...raw.matchAll(/(?:`|--data ')(\{\s*"[^\n]*?\})(?:`|')/g),
  ]
  for (const match of jsonExamples) {
    try {
      const body = JSON.parse(match[1] ?? '')
      const candidates = requests.filter((request) => request.body)
      if (
        !candidates.some(
          (request) =>
            !validateMakeFields(
              { requests: [{ method: request.method, path: request.path, body }] },
              document,
              payloadFields,
            ).length,
        )
      )
        errors.push('unknown JSON example field')
    } catch {
      errors.push('invalid JSON example')
    }
  }
  // The actual HTTP module settings and body table remain authoritative even
  // if someone forgets to update their field-declaration fence.
  for (const match of raw.matchAll(
    /Method `([A-Z]+)`; URL\s+`[^`]*?(\/api\/v1\/[A-Za-z0-9_/{}/-]+)`/g,
  )) {
    if (!document.paths[match[2] ?? '']?.[match[1]?.toLowerCase() ?? ''])
      errors.push('unknown module REST method')
  }
  for (const table of raw.matchAll(/\| Field \| Type \| Mapping \|\n([\s\S]*?)(?:\n\s*\n|$)/g)) {
    for (const match of (table[1] ?? '').matchAll(/\| `(?:body:)?([A-Za-z][A-Za-z0-9_.]*)` \|/g)) {
      const candidates = requests.filter((request) => request.body)
      if (
        candidates.length !== 1 ||
        validateMakeFields(
          {
            requests: [
              {
                method: candidates[0]?.method ?? '',
                path: candidates[0]?.path ?? '',
                body: [match[1] ?? ''],
              },
            ],
          },
          document,
          payloadFields,
        ).length
      )
        errors.push('unknown body table field')
    }
  }
  return errors
}
export function validateMakeInventory(names: string[]) {
  const required = [
    'booking-created-sheets.recipe.json',
    'booking-cancelled-slack.recipe.json',
    'find-slots-create-booking.recipe.json',
  ]
  return required.filter((name) => !names.includes(name))
}
