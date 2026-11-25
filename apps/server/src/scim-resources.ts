import type { Db } from '@hourmere/db'
import type { ScimResourceHandler } from './scim.ts'
import { createScimDiscovery } from './scim-discovery.ts'
import { scimGroupRetirement } from './scim-group-retirement.ts'
import { scimGroups } from './scim-groups.ts'
import type { ScimMappingNoticeQueue } from './scim-team-mapping-notices.ts'
import { type ScimUserCreationDeps, scimUserCreation } from './scim-user-create.ts'
import { scimUserReplacement } from './scim-user-replace.ts'
import { scimUserRetirement } from './scim-user-retirement.ts'
import { scimUsers } from './scim-users.ts'

export function scimResourceHandlers(
  db: Db,
  creation: Omit<ScimUserCreationDeps, 'db'>,
  notices: ScimMappingNoticeQueue,
): ScimResourceHandler {
  const handlers = [
    scimUsers(db),
    scimUserCreation({ db, ...creation }),
    scimUserReplacement(db),
    scimUserRetirement(db),
    scimGroups(db),
    scimGroupRetirement(db, notices),
  ]
  const discovery = createScimDiscovery(handlers)
  return (request) => {
    for (const handler of handlers) {
      const reply = handler(request)
      if (reply) return reply
    }
    return discovery(request)
  }
}
