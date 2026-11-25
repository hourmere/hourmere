// SCIM discovery (RFC 7644 section 4; representations from RFC 7643 sections 5–7).
import {
  type ScimReply,
  type ScimResourceRegistration,
  type ScimResourceRequest,
  type ScimResources,
  scimError,
} from './scim.ts'

export const SCIM_URN = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  enterpriseUser: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  serviceProviderConfig: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  resourceType: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
  schema: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
  listResponse: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
} as const

interface ScimAttribute {
  name: string
  type: 'string' | 'boolean' | 'complex' | 'reference'
  multiValued: boolean
  description: string
  required: boolean
  canonicalValues?: string[]
  referenceTypes?: string[]
  caseExact: boolean
  mutability: 'readOnly' | 'readWrite' | 'immutable'
  returned: 'always' | 'default'
  uniqueness: 'none' | 'server'
  subAttributes?: ScimAttribute[]
}

// RFC 7643 section 2.2 defaults, written out so every definition is explicit.
const attribute = (
  name: string,
  description: string,
  characteristics: Partial<ScimAttribute> = {},
): ScimAttribute => ({
  name,
  type: 'string',
  multiValued: false,
  description,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...characteristics,
})

// id, externalId and meta are common attributes (RFC 7643 section 3.1), not schema fields.
const userAttributes: ScimAttribute[] = [
  attribute('userName', 'Login name local to this provisioning connection.', {
    required: true,
    // Uniqueness compares trimmed, lower-cased names among the connection's live entries.
    uniqueness: 'server',
    // Projection never hides a mandatory identity field.
    returned: 'always',
  }),
  attribute('name', 'Name in the organization-local provisioned profile.', {
    type: 'complex',
    subAttributes: [
      attribute('formatted', 'Full name for display.'),
      attribute('familyName', 'Family name.'),
      attribute('givenName', 'Given name.'),
    ],
  }),
  attribute('displayName', 'Name shown in this organization.'),
  attribute('nickName', 'Casual name.'),
  attribute('title', 'Job title; organization-local profile metadata.'),
  attribute('userType', 'Relationship to the organization; organization-local profile metadata.'),
  attribute('locale', 'Organization-local profile metadata; changes no personal preference.'),
  attribute('timezone', 'Organization-local profile metadata; changes no availability.'),
  attribute('active', 'Desired organization-membership state.', { type: 'boolean' }),
  attribute('emails', 'The work address used for invitation and claim.', {
    type: 'complex',
    multiValued: true,
    subAttributes: [
      attribute('value', 'Email address.'),
      attribute('type', 'Address kind.', { canonicalValues: ['work'] }),
      attribute('primary', 'Whether this is the primary work address.', { type: 'boolean' }),
    ],
  }),
]

const enterpriseAttributes: ScimAttribute[] = [
  attribute('employeeNumber', 'Organization-local profile metadata.'),
  attribute('costCenter', 'Organization-local profile metadata.'),
  attribute('organization', 'Organization-local profile metadata; never selects a tenant.'),
  attribute('division', 'Organization-local profile metadata.'),
  attribute('department', 'Organization-local profile metadata.'),
  attribute('manager', 'Another User of the same provisioning connection.', {
    type: 'complex',
    subAttributes: [
      attribute('value', "The id of the manager's User resource."),
      attribute('displayName', "The manager's display name, derived from that User.", {
        mutability: 'readOnly',
      }),
    ],
  }),
]

const serviceProviderConfig = (
  base: string,
  registrations: readonly ScimResourceRegistration[],
) => ({
  schemas: [SCIM_URN.serviceProviderConfig],
  patch: { supported: registrations.some((route) => route.patch) },
  bulk: {
    supported: registrations.some((route) => route.bulk),
    maxOperations: Math.max(0, ...registrations.map((route) => route.bulk?.maxOperations ?? 0)),
    maxPayloadSize: Math.max(0, ...registrations.map((route) => route.bulk?.maxPayloadSize ?? 0)),
  },
  filter: {
    supported: registrations.some((route) => route.filter),
    maxResults: Math.max(0, ...registrations.map((route) => route.filter?.maxResults ?? 0)),
  },
  changePassword: { supported: registrations.some((route) => route.changePassword) },
  sort: { supported: registrations.some((route) => route.sort) },
  etag: { supported: registrations.some((route) => route.etag) },
  authenticationSchemes: [
    {
      type: 'oauthbearertoken',
      name: 'OAuth Bearer Token',
      description: 'A provisioning token sent in the Authorization header as a bearer token.',
      specUri: 'https://www.rfc-editor.org/info/rfc6750',
    },
  ],
  meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
})

const resourceTypes = (base: string) => [
  {
    schemas: [SCIM_URN.resourceType],
    id: 'User',
    name: 'User',
    endpoint: '/Users',
    description: 'Provisioned organization member',
    schema: SCIM_URN.user,
    schemaExtensions: [{ schema: SCIM_URN.enterpriseUser, required: false }],
    meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` },
  },
]

const groupResourceType = (base: string) => ({
  schemas: [SCIM_URN.resourceType],
  id: 'Group',
  name: 'Group',
  endpoint: '/Groups',
  description: 'Directory-managed child team',
  schema: SCIM_URN.group,
  meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` },
})

/** The User schema, then its enterprise extension; the query parser projects these fields. */
export const scimUserSchemas = [
  { id: SCIM_URN.user, name: 'User', description: 'User Account', attributes: userAttributes },
  {
    id: SCIM_URN.enterpriseUser,
    name: 'EnterpriseUser',
    description: 'Enterprise User',
    attributes: enterpriseAttributes,
  },
]

const groupAttributes: ScimAttribute[] = [
  attribute('displayName', 'The mapped child team name.', {
    required: true,
    returned: 'always',
  }),
  attribute('members', 'User memberships managed by this mapping.', {
    type: 'complex',
    multiValued: true,
    subAttributes: [
      attribute('value', 'The User resource ID.', { caseExact: true, mutability: 'immutable' }),
      attribute('$ref', 'The User resource location.', {
        type: 'reference',
        referenceTypes: ['User'],
        mutability: 'immutable',
      }),
      attribute('type', 'The member resource type.', {
        canonicalValues: ['User'],
        mutability: 'immutable',
      }),
    ],
  }),
]

export const scimGroupSchemas = [
  { id: SCIM_URN.group, name: 'Group', description: 'Group', attributes: groupAttributes },
]

const schemas = (base: string, includeUsers: boolean, includeGroups: boolean) =>
  [...(includeUsers ? scimUserSchemas : []), ...(includeGroups ? scimGroupSchemas : [])].map(
    (schema) => ({
      schemas: [SCIM_URN.schema],
      ...schema,
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${schema.id}` },
    }),
  )

const ok = (body: unknown): ScimReply => ({ status: 200, body })

function discover(
  { method, path, query, base }: ScimResourceRequest,
  registrations: readonly ScimResourceRegistration[],
  includeUsers: boolean,
  includeGroups: boolean,
): ScimReply | undefined {
  const match = /^\/(ServiceProviderConfig|ResourceTypes|Schemas)(?:\/([^/]+))?$/.exec(path)
  const [, endpoint, id] = match ?? []
  if (!endpoint || (endpoint === 'ServiceProviderConfig' && id !== undefined)) return undefined
  if (method !== 'GET' && method !== 'HEAD')
    return { status: 501, body: scimError(501, 'Discovery resources are read-only.') }
  // RFC 7644 section 4: other query parameters are ignored, but a filter is refused so a
  // client cannot assume that its conditions matched.
  if (query.has('filter'))
    return { status: 403, body: scimError(403, 'Discovery endpoints do not support filtering.') }
  if (endpoint === 'ServiceProviderConfig') return ok(serviceProviderConfig(base, registrations))
  const resources: { id: string }[] =
    endpoint === 'ResourceTypes'
      ? [
          ...(includeUsers ? resourceTypes(base) : []),
          ...(includeGroups ? [groupResourceType(base)] : []),
        ]
      : schemas(base, includeUsers, includeGroups)
  if (id === undefined)
    return ok({
      schemas: [SCIM_URN.listResponse],
      totalResults: resources.length,
      itemsPerPage: resources.length,
      startIndex: 1,
      Resources: resources,
    })
  let decoded: string | undefined
  try {
    // Clients may encode the colons of a schema URI.
    decoded = decodeURIComponent(id)
  } catch {}
  const resource = resources.find((candidate) => candidate.id === decoded)
  return resource ? ok(resource) : { status: 404, body: scimError(404, 'Resource not found.') }
}

export function createScimDiscovery(
  registrations: readonly ScimResourceRegistration[],
): ScimResources {
  const includeUsers = registrations.some((route) => route.resourceType === 'User')
  const includeGroups = registrations.some((route) => route.resourceType === 'Group')
  return (request) => discover(request, registrations, includeUsers, includeGroups)
}
