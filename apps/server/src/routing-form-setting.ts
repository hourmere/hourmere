import type { Db } from '@hourmere/db'
import { findLegacyHandleCollisions } from '@hourmere/scheduling'

export function parseRoutingFormsEnabled(value: string | undefined): boolean {
  switch (value) {
    case 'true':
    case '':
    case undefined:
      return true
    case 'false':
      return false
    default:
      throw new Error('ROUTING_FORMS_ENABLED must be true or false')
  }
}

/** Compute the capability once per startup from the requested setting and stored handles. */
export async function resolveRoutingFormsEnabled({
  db,
  routingFormsEnabled,
  warn = console.warn,
}: {
  db: Db
  routingFormsEnabled: boolean
  warn?: (message: string) => void
}): Promise<boolean> {
  const collisions = await findLegacyHandleCollisions(db)
  if (!collisions.some(({ handle }) => handle.toLowerCase() === 'route')) return routingFormsEnabled

  warn(
    'Routing forms are disabled because a legacy personal handle uses the reserved name "route". Coordinate a rename with the owner in Settings > Profile, then restart Hourmere.',
  )
  return false
}
