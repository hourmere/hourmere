import { createScimDiscovery } from './scim-discovery.ts'

export const userDiscoveryRegistration = {
  resourceType: 'User',
  patch: true,
  filter: { maxResults: 100 },
} as const

export const scimDiscovery = createScimDiscovery([userDiscoveryRegistration])
export const scimDiscoveryWithGroups = createScimDiscovery([
  userDiscoveryRegistration,
  { resourceType: 'Group' },
])
