import { SCIM_URN, scimUserSchemas } from './scim-discovery.ts'
import {
  assertScimActiveUnchanged,
  invalidSyntax,
  invalidValue,
  parseScimUserProfile,
  refuse,
  type ScimUserProfile,
  scimAttributes,
} from './scim-user-write.ts'

const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:patchop'
const MAX_OPERATIONS = 100
const MAX_PATH_LENGTH = 512
const core = SCIM_URN.user.toLowerCase()
const enterprise = SCIM_URN.enterpriseUser.toLowerCase()
const workEmailPath = /^emails\[[ \t]*type[ \t]+eq[ \t]+"work"[ \t]*\]\.value$/

type Operation = { op: 'add' | 'replace' | 'remove'; path: string | undefined; value: unknown }
type ObjectValue = Record<string, unknown>
const isObject = (value: unknown): value is ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const invalidPath = () => refuse(400, 'The PATCH path is not supported.', 'invalidPath')
const noTarget = () => refuse(400, 'The PATCH path has no target.', 'noTarget')
const readOnly = () => refuse(400, 'The PATCH attribute is read-only.', 'mutability')

export function parseScimUserPatch(body: unknown): Operation[] {
  if (!isObject(body)) throw invalidSyntax('The request body must be a PatchOp object.')
  const document = scimAttributes(body, 'PatchOp')
  const schemas = document.get('schemas')
  const operations = document.get('operations')
  if (
    document.size !== 2 ||
    !Array.isArray(schemas) ||
    schemas.length !== 1 ||
    typeof schemas[0] !== 'string' ||
    schemas[0].toLowerCase() !== PATCH_SCHEMA ||
    !Array.isArray(operations) ||
    operations.length === 0 ||
    operations.length > MAX_OPERATIONS
  )
    throw invalidSyntax('A PatchOp document must contain its schema and 1 to 100 operations.')
  return operations.map((item): Operation => {
    if (!isObject(item)) throw invalidSyntax('Each PATCH operation must be an object.')
    const operation = scimAttributes(item, 'operation')
    if ([...operation.keys()].some((key) => !['op', 'path', 'value'].includes(key)))
      throw invalidSyntax('The PATCH operation contains an unsupported member.')
    const verb = operation.get('op')
    const op = typeof verb === 'string' ? verb.toLowerCase() : undefined
    if (op !== 'add' && op !== 'replace' && op !== 'remove')
      throw invalidSyntax('The PATCH operation must be add, replace or remove.')
    const path = operation.get('path')
    if (operation.has('path') && (typeof path !== 'string' || path.length === 0))
      throw invalidPath()
    if (op === 'remove') {
      if (path === undefined) throw noTarget()
      if (operation.has('value')) throw invalidValue('A User remove operation takes only a path.')
    } else if (!operation.has('value')) {
      throw invalidValue('The PATCH operation requires a value.')
    }
    return { op, path: typeof path === 'string' ? path : undefined, value: operation.get('value') }
  })
}

// PATCH targets come from the advertised User schema, plus the common externalId and
// explicit guards for server-owned fields and authorization attributes.
const targets = new Set(['externalid', 'roles', 'entitlements', enterprise])
const complex = new Set([enterprise, 'name', `${enterprise}:manager`])
const readOnlyPaths = new Set(['schemas', 'id', 'meta', 'groups', `${enterprise}:manager.$ref`])
for (const schema of scimUserSchemas) {
  const prefix = schema.id === SCIM_URN.user ? '' : `${enterprise}:`
  for (const attribute of schema.attributes) {
    const path = prefix + attribute.name.toLowerCase()
    targets.add(path)
    // Only the explicit work-email filter may target an email subattribute.
    if (attribute.multiValued) continue
    for (const sub of attribute.subAttributes ?? []) {
      const subPath = `${path}.${sub.name.toLowerCase()}`
      if (sub.mutability === 'readOnly') readOnlyPaths.add(subPath)
      else targets.add(subPath)
    }
  }
}

function setField(draft: ObjectValue, parts: string[], value: unknown) {
  let group = draft
  for (const key of parts.slice(0, -1)) {
    if (!Object.hasOwn(group, key)) group[key] = {}
    const next = group[key]
    if (!isObject(next)) throw invalidSyntax('A PATCH attribute is named more than once.')
    group = next
  }
  const key = parts.at(-1)
  if (!key || Object.hasOwn(group, key))
    throw invalidSyntax('A PATCH attribute is named more than once.')
  group[key] = value
}

function applyField(
  draft: ObjectValue,
  path: string,
  value: unknown,
  op: Operation['op'],
  current: { profile: ScimUserProfile; active: boolean },
  pathless = false,
) {
  if (path.length > MAX_PATH_LENGTH || path !== path.trim()) throw invalidPath()
  const lower = path.toLowerCase()
  const target = lower.startsWith(`${core}:`) ? lower.slice(core.length + 1) : lower
  if (target.startsWith(enterprise) && (target !== lower || (target === enterprise && !pathless)))
    throw invalidPath()
  if (workEmailPath.test(target)) {
    if (op !== 'add' && current.profile.work_email === null) throw noTarget()
    setField(
      draft,
      ['emails'],
      op === 'remove' ? undefined : [{ value, type: 'work', primary: true }],
    )
    return
  }

  if (
    readOnlyPaths.has(target) ||
    target.startsWith('meta.') ||
    target.startsWith('groups.') ||
    target.startsWith('groups[')
  )
    throw readOnly()
  if (!targets.has(target)) throw invalidPath()
  if (target === 'username' && op === 'remove')
    throw refuse(400, 'The userName attribute is required.', 'mutability')
  if (target === 'active') {
    if (op === 'remove' || value === undefined) {
      assertScimActiveUnchanged(null, current.active)
      return
    }
    const boolean =
      typeof value === 'string' && /^(?:true|false)$/i.test(value) && value === value.trim()
        ? value.toLowerCase() === 'true'
        : value
    if (typeof boolean !== 'boolean')
      throw invalidValue('The active attribute is not a valid value.')
    assertScimActiveUnchanged(boolean, current.active)
    setField(draft, ['active'], boolean)
    return
  }

  if (complex.has(target) && value !== undefined) {
    const separator = target === enterprise ? ':' : '.'
    for (const [child, item] of scimAttributes(value, 'PATCH complex')) {
      applyField(draft, target + separator + child, item, op, current)
    }
    return
  }
  const parts = target.startsWith(`${enterprise}:`)
    ? [enterprise, ...target.slice(enterprise.length + 1).split('.')]
    : target === enterprise
      ? [enterprise]
      : target.split('.')
  setField(draft, parts, value)
}

/** Applies the bounded operations in order to the write transaction's locked snapshot. */
export function normalizeScimUserPatch(
  entry: ScimUserProfile & { active: boolean },
  operations: readonly Operation[],
) {
  let profile: ScimUserProfile = entry
  const managers: string[] = []
  for (const { op, path, value } of operations) {
    const draft: ObjectValue = {}
    const current = { profile, active: entry.active }
    if (path === undefined) {
      const fields = scimAttributes(value, 'PATCH value')
      if (fields.size === 0) throw invalidValue('A pathless PATCH value must name attributes.')
      for (const [name, item] of fields) applyField(draft, name, item, op, current, true)
    } else {
      applyField(draft, path, value, op, current)
    }
    profile = parseScimUserProfile(scimAttributes(draft, 'PATCH attributes'), profile, op === 'add')
    const extension = draft[enterprise]
    if (isObject(extension) && isObject(extension.manager) && profile.manager_id !== null)
      managers.push(profile.manager_id)
  }
  return { profile, managers }
}
