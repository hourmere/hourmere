import { describe, expect, it } from 'vitest'
import type { ScimResources } from './scim.ts'
import { SCIM_URN } from './scim-discovery.ts'
import { scimDiscovery, scimDiscoveryWithGroups } from './scim-discovery-fixture.ts'
import { parseScimListQuery, projectScimResource, scimGroupQuery } from './scim-query.ts'

const organizationId = '00000000-0000-4000-8000-0000000000a1'
const base = `https://public.example/scim/v2/${organizationId}`
const groupUrn = 'urn:ietf:params:scim:schemas:core:2.0:Group'

function discover(path: string, handler: ScimResources = scimDiscoveryWithGroups) {
  const reply = handler({
    method: 'GET',
    path,
    query: new URLSearchParams(),
    principal: { organizationId, tokenId: 'test-token' },
    base,
  })
  return reply?.body
}

describe('Group discovery', () => {
  it('appends Group only to the enabled resource type and schema lists', () => {
    const groupType = {
      schemas: [SCIM_URN.resourceType],
      id: 'Group',
      name: 'Group',
      endpoint: '/Groups',
      description: expect.any(String),
      schema: groupUrn,
      meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` },
    }
    const groupSchema = discover(`/Schemas/${groupUrn}`)
    expect(discover('/ResourceTypes/Group')).toEqual(groupType)
    for (const [path, count, added] of [
      ['/ResourceTypes', 1, groupType],
      ['/Schemas', 2, groupSchema],
    ] as const) {
      const legacy = discover(path, scimDiscovery) as { Resources: unknown[] }
      expect(legacy).toMatchObject({ totalResults: count, itemsPerPage: count })
      expect(legacy.Resources).toHaveLength(count)
      expect(discover(path)).toEqual({
        schemas: [SCIM_URN.listResponse],
        totalResults: count + 1,
        itemsPerPage: count + 1,
        startIndex: 1,
        Resources: [...legacy.Resources, added],
      })
    }
    for (const path of ['/ResourceTypes/Group', `/Schemas/${groupUrn}`]) {
      expect(discover(path, scimDiscovery)).toMatchObject({ status: '404' })
    }
    for (const path of [
      '/ServiceProviderConfig',
      '/ResourceTypes/User',
      `/Schemas/${SCIM_URN.user}`,
      `/Schemas/${SCIM_URN.enterpriseUser}`,
    ]) {
      expect(JSON.stringify(discover(path))).toBe(JSON.stringify(discover(path, scimDiscovery)))
    }
  })

  it('advertises the mapped name and User references only', () => {
    expect(discover(`/Schemas/${encodeURIComponent(groupUrn)}`)).toEqual({
      schemas: [SCIM_URN.schema],
      id: groupUrn,
      name: 'Group',
      description: expect.any(String),
      attributes: [
        expect.objectContaining({
          name: 'displayName',
          type: 'string',
          required: true,
          caseExact: false,
          mutability: 'readWrite',
          returned: 'always',
          uniqueness: 'none',
        }),
        expect.objectContaining({
          name: 'members',
          type: 'complex',
          multiValued: true,
          mutability: 'readWrite',
          subAttributes: [
            expect.objectContaining({ name: 'value', caseExact: true, mutability: 'immutable' }),
            expect.objectContaining({
              name: '$ref',
              type: 'reference',
              referenceTypes: ['User'],
              mutability: 'immutable',
            }),
            expect.objectContaining({
              name: 'type',
              canonicalValues: ['User'],
              mutability: 'immutable',
            }),
          ],
        }),
      ],
      meta: { resourceType: 'Schema', location: `${base}/Schemas/${groupUrn}` },
    })
  })
})

describe('Group queries', () => {
  it('uses Group filter names and case semantics', () => {
    for (const [attribute, caseExact] of [
      ['displayName', false],
      ['externalId', true],
    ] as const) {
      const parsed = parseScimListQuery(
        new URLSearchParams({ filter: `${groupUrn}:${attribute.toUpperCase()} EQ "Example"` }),
        scimGroupQuery,
      )
      expect(parsed).toMatchObject({
        ok: true,
        value: { filter: { attribute, value: 'Example', caseExact }, count: 100, startIndex: 1 },
      })
    }
    for (const filter of ['userName eq "Example"', 'members.value eq "Example"']) {
      expect(parseScimListQuery(new URLSearchParams({ filter }), scimGroupQuery)).toMatchObject({
        ok: false,
        reply: { status: 400, body: { scimType: 'invalidFilter' } },
      })
    }
  })

  it('keeps the required Group name and restricts projected members', () => {
    const required = { schemas: [groupUrn], id: 'group-id', displayName: 'Team' }
    const full = {
      ...required,
      members: [{ value: 'user-id', $ref: `${base}/Users/user-id`, type: 'User' }],
    }
    for (const [parameters, expected] of [
      ['attributes=members.value', { ...required, members: [{ value: 'user-id' }] }],
      ['excludedAttributes=displayName,members', required],
    ] as const) {
      const parsed = parseScimListQuery(new URLSearchParams(parameters), scimGroupQuery)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) {
        expect(projectScimResource(scimGroupQuery, full, parsed.value.projection)).toEqual(expected)
      }
    }
  })
})
