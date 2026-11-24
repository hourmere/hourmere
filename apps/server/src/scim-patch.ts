import { invalidSyntax, invalidValue, refuse, scimAttributes } from './scim-user-write.ts'

const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:patchop'
const MAX_OPERATIONS = 100
export const SCIM_PATCH_PATH_LIMIT = 512

export type ScimPatchOperation = {
  op: 'add' | 'replace' | 'remove'
  path: string | undefined
  value?: unknown
}

export const invalidPath = () => refuse(400, 'The PATCH path is not supported.', 'invalidPath')
const noTarget = () => refuse(400, 'The PATCH path has no target.', 'noTarget')

/** Parse the shared PatchOp envelope. Each resource validates its own paths and values. */
export function parseScimPatch(body: unknown, resource: 'User' | 'Group'): ScimPatchOperation[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw invalidSyntax('The request body must be a PatchOp object.')
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
  return operations.map((item): ScimPatchOperation => {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      throw invalidSyntax('Each PATCH operation must be an object.')
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
      if (resource === 'User' && operation.has('value'))
        throw invalidValue('A User remove operation takes only a path.')
    } else if (!operation.has('value')) {
      throw invalidValue('The PATCH operation requires a value.')
    }
    return {
      op,
      path: typeof path === 'string' ? path : undefined,
      ...(operation.has('value') && { value: operation.get('value') }),
    }
  })
}
