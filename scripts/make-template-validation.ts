import { createHmac } from 'node:crypto'

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
type Fields = { requests: Request[]; webhookEvents?: string[]; webhookPayloadFields?: string[] }
type Recipe = Fields & {
  format: string
  id: string
  title: string
  webhookEvents: string[]
  connections: { kind: string; purpose: string }[]
  settings: { documentation: string; apiKeyScope?: string }
}
/**
 * Accepted events with the field paths of each event's real payload, the delivery headers,
 * one real delivery's signing inputs with the signature it sent, and the timestamp tolerance
 * of the n8n trigger's verifier.
 */
export type WebhookContract = {
  events: Readonly<Record<string, readonly string[]>>
  headers: readonly string[]
  signature: { secret: string; timestamp: string; body: string; value: string }
  timestampToleranceSeconds: number
}
/** API-key requirements from the scope matrix, keyed by `METHOD /api/v1/path`. */
export type ApiKeyOperations = Readonly<
  Record<string, { authentication: string; allowedScopes: readonly string[] }>
>

/** Diagnostics never echo the potentially sensitive input. */
export function validateMakeSecrets(raw: string) {
  const errors: string[] = []
  if (/\bhm_[A-Za-z0-9_-]+/i.test(raw)) errors.push('embedded API key')
  if (/\bwhsec_[A-Za-z0-9_-]+/i.test(raw)) errors.push('embedded webhook secret')
  if (/\bBearer[ \t]+(?!<YOUR_[A-Z0-9_]+>)[A-Za-z0-9_~+/.=-]+/i.test(raw))
    errors.push('embedded bearer token')
  // Make hook hosts, with or without a scheme: current, Celonis and legacy Integromat names.
  if (/\bhooks?\.(?:[a-z0-9-]+\.)*(?:make\.com|make\.celonis\.com|integromat\.com)\//i.test(raw))
    errors.push('embedded Make hook URL')
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
export function validateMakeFields(value: Fields, document: Document, webhooks: WebhookContract) {
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
  const events = value.webhookEvents ?? []
  for (const event of events) {
    if (!Object.hasOwn(webhooks.events, event)) errors.push('unknown webhook event')
  }
  if (value.webhookPayloadFields?.length && !events.length)
    errors.push('missing webhook event context')
  // A scenario subscribed to several events may map only fields that every one of them sends.
  for (const field of value.webhookPayloadFields ?? []) {
    if (!events.every((event) => webhooks.events[event]?.includes(field)))
      errors.push('unknown webhook payload field')
  }
  return errors
}

/** Offline metadata is deliberately not a Make blueprint or credential container. */
export function validateMakeRecipe(value: unknown, document: Document, webhooks: WebhookContract) {
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
  errors.push(...validateMakeFields(recipe, document, webhooks))
  errors.push(...validateMakeReferences(raw, document, webhooks))
  return errors
}

const signatureTables =
  /^\| Set variable \| Value \(braces mark mapped items\) \|\n\|[- |]+\|\n((?:\|[^\n]*\|(?:\n|$))*)/gm
/**
 * Evaluates a Make text value: literal text plus `{{…}}` items that are variables or Make's
 * documented `sha256(text; encoding; key; key encoding)`, which is HMAC-SHA256 given a key.
 */
function makeText(template: string, variables: ReadonlyMap<string, string>, calls: string[]) {
  let text = ''
  for (const [index, part] of template.split(/\{\{([^{}]*)\}\}/).entries()) {
    if (index % 2 === 0) {
      text += part
      continue
    }
    const call = part.match(/^sha256\((\w+); "(hex|base64|latin1)"; (\w+); "(text|hex|base64)"\)$/)
    const message = variables.get(call?.[1] ?? '')
    const key = variables.get(call?.[3] ?? '')
    const value = !call
      ? variables.get(part)
      : message === undefined || key === undefined
        ? undefined
        : createHmac('sha256', Buffer.from(key, call[4] === 'text' ? 'utf8' : (call[4] as 'hex')))
            .update(message, 'utf8')
            .digest(call[2] as 'hex')
    if (value === undefined) return undefined
    if (call) calls.push(part)
    text += value
  }
  return text
}

/**
 * hourmere-fields fences declare operation and webhook event context; inline kind:field
 * markers are checked too. `recipes` maps each event to the recipe document covering it.
 */
export function validateMakeReferences(
  raw: string,
  document: Document,
  webhooks: WebhookContract,
  recipes: Readonly<Record<string, string>> = {},
) {
  const errors = validateMakeSecrets(raw)
  const accepted = Object.keys(webhooks.events)
  for (const match of raw.matchAll(/(?<![A-Za-z0-9_.-])booking\.[a-z_]+/g)) {
    if (
      !accepted.includes(match[0]) &&
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
  const events: string[] = []
  for (const match of raw.matchAll(/```hourmere-fields\s*\n([\s\S]*?)\n```/g)) {
    try {
      const fields = JSON.parse(match[1] ?? '') as Fields
      errors.push(...validateMakeFields(fields, document, webhooks))
      requests.push(...fields.requests)
      events.push(...(fields.webhookEvents ?? []))
    } catch {
      errors.push('invalid field declaration')
    }
  }
  // Payload references in prose use the events this document's fences subscribe to.
  const payloadErrors = (field: string) =>
    validateMakeFields(
      { requests: [], webhookEvents: events, webhookPayloadFields: [field] },
      document,
      webhooks,
    )
  for (const match of raw.matchAll(/`(body|query|headers|payload|response):([A-Za-z0-9_.:-]+)`/g)) {
    const [, kind, field = ''] = match
    if (kind === 'response' && !/^\d{3}:/.test(field)) continue
    if (kind === 'payload') {
      errors.push(...payloadErrors(field))
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
            webhooks,
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
        webhooks,
      ),
    )
  }
  // Header names appear in prose (`Webhook-Id`) and in quoted lookup expressions.
  for (const match of raw.matchAll(/["'`](webhook-[A-Za-z0-9-]+)["'`]/gi)) {
    if (!webhooks.headers.includes(match[1]?.toLowerCase() ?? ''))
      errors.push('unknown webhook header')
  }
  // Lookups run after names are lowercased, so each must name a delivery header exactly.
  for (const match of raw.matchAll(/map\([^;()]*; "value"; "name"; "([^"]*)"\)/g)) {
    if (!webhooks.headers.includes(match[1] ?? '')) errors.push('unknown webhook header lookup')
  }
  // A signature table, evaluated row by row with Make's semantics, must reproduce the
  // signature of a real delivery; any other quoted sha256 call must be one it verified.
  const verifiedCalls = new Set<string>()
  for (const table of raw.matchAll(signatureTables)) {
    const variables = new Map([
      ['timestamp', webhooks.signature.timestamp],
      ['rawBody', webhooks.signature.body],
      ['signingSecret', webhooks.signature.secret],
    ])
    const calls: string[] = []
    let evaluated = true
    for (const row of (table[1] ?? '').split('\n').filter(Boolean)) {
      const [, name = '', template = ''] = row.match(/^\| `([A-Za-z]+)` \| `([^`]+)` \|$/) ?? []
      const value = makeText(template, variables, calls)
      if (!name || value === undefined) {
        evaluated = false
        break
      }
      variables.set(name, value)
    }
    if (!evaluated || variables.get('expectedSignature') !== webhooks.signature.value)
      errors.push('wrong webhook signature formula')
    else for (const call of calls) verifiedCalls.add(call)
  }
  for (const match of raw.matchAll(/sha256\([^()]*"[^()]*\)/g)) {
    if (!verifiedCalls.has(match[0])) errors.push('unverified webhook signature formula')
  }
  // A timestamp condition is the expression, Make's inclusive "Less than or equal to"
  // operator and the verifier's tolerance; every stated tolerance uses that value too.
  for (const match of raw.matchAll(
    /`abs\(formatDate\(now; "X"\) - timestamp\)`(?:\s+\*\*(?:Numeric operators: )?Less than or equal to\*\*\s+`(\d+)`)?|\b(\d+)(?:\*\*)?[ -]seconds?(?:\*\*)?(?= (?:of|from) current UTC time| tolerance)/g,
  )) {
    const seconds = match[1] ?? match[2]
    if (seconds === undefined) errors.push('wrong timestamp comparison')
    else if (Number(seconds) !== webhooks.timestampToleranceSeconds)
      errors.push('wrong timestamp tolerance')
  }
  // Mapped text uses Make braces; uppercase names are explicit operator placeholders.
  // Signature tables map verification inputs, not payload fields.
  for (const match of raw.replace(signatureTables, '').matchAll(/\{\{([a-z][A-Za-z0-9_.]*)\}\}/g)) {
    if (payloadErrors(match[1] ?? '').length) errors.push('unknown mapped payload field')
  }
  // An event table lists exactly the accepted events, the recipe covering each one (or
  // None) and the payload fields each event adds to the snapshot that every event shares.
  const payloads = Object.values(webhooks.events)
  const shared = payloads.length ? payloads.reduce((a, b) => a.filter((f) => b.includes(f))) : []
  for (const table of raw.matchAll(
    /^\| Event \| Make recipe \| Additional payload fields \|\n\|[- |]+\|\n((?:\|[^\n]*\|(?:\n|$))*)/gm,
  )) {
    const listed: string[] = []
    for (const row of (table[1] ?? '').split('\n').filter(Boolean)) {
      const [eventCell = '', recipeCell = '', fieldCell = ''] = row
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
      const event = eventCell.match(/^`(booking\.[a-z_]+)`$/)?.[1] ?? ''
      if (!event || listed.includes(event)) errors.push('invalid webhook event table row')
      listed.push(event)
      const recipe = recipes[event]
      if (
        recipe
          ? !recipeCell.includes(`(${recipe})`) && !recipeCell.includes(`/${recipe})`)
          : recipeCell !== 'None'
      )
        errors.push('wrong event recipe coverage')
      const added =
        fieldCell === 'None' ? [] : [...fieldCell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '')
      errors.push(
        ...validateMakeFields(
          { requests: [], webhookEvents: [event], webhookPayloadFields: added },
          document,
          webhooks,
        ),
      )
      const expected = (webhooks.events[event] ?? []).filter((field) => !shared.includes(field))
      if (
        added.length !== expected.length ||
        expected.some((field) => !added.includes(field)) ||
        (!added.length && fieldCell !== 'None')
      )
        errors.push('wrong additional payload fields')
    }
    if (accepted.some((event) => !listed.includes(event)))
      errors.push('incomplete webhook event table')
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
              webhooks,
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
          webhooks,
        ).length
      )
        errors.push('unknown body table field')
    }
  }
  return errors
}
/** A recipe's Markdown must subscribe to exactly the events its manifest declares. */
export function validateMakeRecipeEvents(manifestEvents: readonly string[], raw: string) {
  const declared = new Set<string>()
  for (const match of raw.matchAll(/```hourmere-fields\s*\n([\s\S]*?)\n```/g)) {
    try {
      for (const event of (JSON.parse(match[1] ?? '') as Fields).webhookEvents ?? [])
        declared.add(event)
    } catch {
      // validateMakeReferences reports invalid declarations.
    }
  }
  return declared.size === new Set(manifestEvents).size &&
    manifestEvents.every((event) => declared.has(event))
    ? []
    : ['recipe events differ from manifest']
}
/**
 * A documented credential must be exactly what the scope matrix requires for every listed
 * operation: `none` means no key is needed, and a scope means `full` or that scope, no other.
 */
function requireScope(scope: string, ids: readonly string[], operations: ApiKeyOperations) {
  const errors: string[] = []
  for (const id of ids) {
    const operation = Object.hasOwn(operations, id) ? operations[id] : undefined
    if (!operation) errors.push('unknown scoped operation')
    else if (
      scope === 'none'
        ? !['optional_key', 'public_metadata'].includes(operation.authentication)
        : operation.authentication !== 'key' ||
          [...new Set(operation.allowedScopes)].sort().join() !==
            [...new Set(['full', scope])].sort().join()
    )
      errors.push('wrong documented API key scope')
  }
  return errors
}
// These booking operations reach only bookings the caller hosts in the key's organization
// (listHostBookings, cancelHostBooking and rescheduleHostBooking filter on the caller's host
// rows; apps/server/src/team-booking-host-scope.test.ts guards the listings), so a leaked
// key's reach is stated as "every booking you host".
const leakedKeyActions: Readonly<Record<string, string>> = {
  list: 'GET /api/v1/bookings',
  cancel: 'POST /api/v1/bookings/{id}/cancel',
  reschedule: 'POST /api/v1/bookings/{id}/reschedule',
}
/** Credential tables and leaked-key statements in a Make document match the scope matrix. */
export function validateMakeScopes(raw: string, operations: ApiKeyOperations) {
  const errors: string[] = []
  for (const table of raw.matchAll(
    /^\| Purpose \| Hourmere operations \| Credential \|\n\|[- |]+\|\n((?:\|[^\n]*\|(?:\n|$))*)/gm,
  )) {
    for (const row of (table[1] ?? '').split('\n').filter(Boolean)) {
      const [, operationCell = '', credential = ''] = row.split('|').slice(1, -1)
      const ids = [...operationCell.matchAll(/`([A-Z]+ \/api\/v1\/[^`]+)`/g)].map((m) => m[1] ?? '')
      const scope = credential.includes('**No authentication**')
        ? 'none'
        : credential.match(/\(`(full|read|bookings)`\)/)?.[1]
      if (ids.length > 0 !== Boolean(scope)) errors.push('unbound API key scope')
      else if (scope) errors.push(...requireScope(scope, ids, operations))
    }
  }
  // Every "A leaked `x` key" statement, up to the end of its clause, states exactly the
  // hosted-only reach: its actions, "every booking you host" (optionally "in that
  // organization"), then at most the consequence ", exposing invitee data" (optionally
  // "including"). Any other wording of the statement or of its trailing clause fails, even a
  // harmless one, so a new wording must be added here deliberately.
  for (const match of raw.matchAll(/A leaked `([a-z]+)` key\b[^.;]*/g)) {
    const actions = match[0]
      .replace(/\s+/g, ' ')
      .match(
        /^A leaked `[a-z]+` key could ((?:[a-z]+(?:, | and ))*[a-z]+) every booking you host(?: in that organization)?(?:, (?:including )?exposing invitee data)?$/,
      )?.[1]
    if (!actions) {
      errors.push('overstated leaked key reach')
      continue
    }
    for (const action of actions.split(/, | and /)) {
      const id = Object.hasOwn(leakedKeyActions, action) ? leakedKeyActions[action] : undefined
      const operation = id && Object.hasOwn(operations, id) ? operations[id] : undefined
      if (operation?.authentication !== 'key' || !operation.allowedScopes.includes(match[1] ?? ''))
        errors.push('unsupported leaked key action')
    }
  }
  return errors
}
/** A manifest's `settings.apiKeyScope` must match the scope matrix for each of its requests. */
export function validateMakeRecipeScope(value: unknown, operations: ApiKeyOperations) {
  const recipe = value as Recipe
  const scope = recipe?.settings?.apiKeyScope?.match(/^(none|full|read|bookings)\b/)?.[1]
  if (!scope || !Array.isArray(recipe.requests)) return ['unbound API key scope']
  return requireScope(
    scope,
    recipe.requests.map((request) => `${request.method} ${request.path}`),
    operations,
  )
}
export function validateMakeInventory(names: string[]) {
  const required = [
    'booking-created-sheets.recipe.json',
    'booking-cancelled-slack.recipe.json',
    'find-slots-create-booking.recipe.json',
  ]
  return required.filter((name) => !names.includes(name))
}
