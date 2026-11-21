import { SCIM_URN, scimUserSchemas } from './scim-discovery.ts'
import { invalidPath, SCIM_PATCH_PATH_LIMIT, type ScimPatchOperation } from './scim-patch.ts'
import {
  immutableScimPrivileges,
  invalidSyntax,
  invalidValue,
  parseScimUserProfile,
  refuse,
  type ScimUserProfile,
  scimAttributes,
} from './scim-user-write.ts'

const core = SCIM_URN.user.toLowerCase()
const enterprise = SCIM_URN.enterpriseUser.toLowerCase()
const workEmailPath = /^emails\[[ \t]*type[ \t]+eq[ \t]+"work"[ \t]*\]\.value$/

type ObjectValue = Record<string, unknown>
const isObject = (value: unknown): value is ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const noTarget = () => refuse(400, 'The PATCH path has no target.', 'noTarget')
const readOnly = () => refuse(400, 'The PATCH attribute is read-only.', 'mutability')

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
  op: ScimPatchOperation['op'],
  profile: ScimUserProfile,
  pathless = false,
) {
  if (path.length > SCIM_PATCH_PATH_LIMIT || path !== path.trim()) throw invalidPath()
  const lower = path.toLowerCase()
  const target = lower.startsWith(`${core}:`) ? lower.slice(core.length + 1) : lower
  if (target.startsWith(enterprise) && (target !== lower || (target === enterprise && !pathless)))
    throw invalidPath()
  if (workEmailPath.test(target)) {
    if (op !== 'add' && profile.work_email === null) throw noTarget()
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
  if (
    /^(?:roles|entitlements)[.[]/.test(target) ||
    (op === 'remove' && (target === 'roles' || target === 'entitlements'))
  )
    throw immutableScimPrivileges()
  if (!targets.has(target)) throw invalidPath()
  if (target === 'username' && op === 'remove')
    throw refuse(400, 'The userName attribute is required.', 'mutability')
  if (target === 'active') {
    if (op === 'remove' || value === undefined)
      throw refuse(403, 'The active attribute cannot be removed or unassigned.', 'mutability')
    const boolean =
      typeof value === 'string' && /^(?:true|false)$/i.test(value) && value === value.trim()
        ? value.toLowerCase() === 'true'
        : value
    if (typeof boolean !== 'boolean')
      throw invalidValue('The active attribute is not a valid value.')
    setField(draft, ['active'], boolean)
    return
  }

  if (complex.has(target) && value !== undefined) {
    const separator = target === enterprise ? ':' : '.'
    for (const [child, item] of scimAttributes(value, 'PATCH complex')) {
      applyField(draft, target + separator + child, item, op, profile)
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
  entry: ScimUserProfile,
  operations: readonly ScimPatchOperation[],
) {
  let profile: ScimUserProfile = entry
  let active: boolean | undefined
  let deactivationRequested = false
  let roleWrite = false
  const managers: string[] = []
  for (const { op, path, value } of operations) {
    const draft: ObjectValue = {}
    if (path === undefined) {
      const fields = scimAttributes(value, 'PATCH value')
      if (fields.size === 0) throw invalidValue('A pathless PATCH value must name attributes.')
      for (const [name, item] of fields) applyField(draft, name, item, op, profile, true)
    } else {
      applyField(draft, path, value, op, profile)
    }
    if (typeof draft.active === 'boolean') {
      active = draft.active
      deactivationRequested ||= !active
    }
    roleWrite ||= Object.hasOwn(draft, 'roles') || Object.hasOwn(draft, 'entitlements')
    profile = parseScimUserProfile(scimAttributes(draft, 'PATCH attributes'), profile, op === 'add')
    const extension = draft[enterprise]
    if (isObject(extension) && isObject(extension.manager) && profile.manager_id !== null)
      managers.push(profile.manager_id)
  }
  return { profile, managers, active, deactivationRequested, roleWrite }
}
