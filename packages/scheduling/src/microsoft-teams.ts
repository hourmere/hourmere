import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { DomainError } from './errors.ts'

export function microsoftTeamsLocation(location: unknown): boolean {
  return (
    typeof location === 'object' &&
    location !== null &&
    'kind' in location &&
    location.kind === 'microsoft_teams'
  )
}

interface MicrosoftDestinationFacts {
  provider: string
  status: string
  access_role: string
  sync_error: string | null
  scopes: readonly string[]
}

/** Only cached destination facts are checked. The writeback worker queries Teams support in Graph. */
export function isMicrosoftTeamsDestination(facts: MicrosoftDestinationFacts | undefined) {
  return (
    facts?.provider === 'microsoft' &&
    facts.status === 'active' &&
    facts.access_role === 'owner' &&
    facts.sync_error !== 'calendar_removed' &&
    facts.scopes.includes('Calendars.ReadWrite')
  )
}

export async function hasMicrosoftTeamsDestination(
  db: Db,
  userId: string,
  eventTypeId?: string,
  lock = false,
) {
  // Destination setters take the user lock before updating the profile.
  if (lock) {
    const owner = await db
      .selectFrom('auth.user')
      .select('id')
      .where('id', '=', userId)
      .forKeyShare()
      .executeTakeFirst()
    if (!owner) return false
  }
  const destination = await db
    .selectFrom('profiles as p')
    .leftJoin('event_type_hosts as h', (join) =>
      join
        .onRef('h.user_id', '=', 'p.user_id')
        .on('h.event_type_id', '=', sql<string>`${eventTypeId ?? null}::uuid`),
    )
    .innerJoin('calendars as c', (join) =>
      join.on(sql<boolean>`c.id=coalesce(h.destination_calendar_id,p.destination_calendar_id)`),
    )
    .innerJoin('calendar_connections as cc', (join) =>
      join.onRef('cc.id', '=', 'c.connection_id').onRef('cc.user_id', '=', 'p.user_id'),
    )
    .select(['cc.provider', 'cc.status', 'cc.scopes', 'c.access_role', 'c.sync_error'])
    .where('p.user_id', '=', userId)
    // Serialize booking destination selection without holding the Graph connection lock.
    .$if(lock, (query) => query.forShare('p'))
    .executeTakeFirst()
  return isMicrosoftTeamsDestination(destination)
}

export async function requireMicrosoftTeamsHost(
  db: Db,
  mode: string,
  hosts: readonly string[],
  eventTypeId: string,
  lock = false,
) {
  const [host] = hosts
  if (
    mode !== 'individual' ||
    !host ||
    hosts.length !== 1 ||
    !(await hasMicrosoftTeamsDestination(db, host, eventTypeId, lock))
  )
    throw new DomainError('conflict', 'location_unavailable', 'The chosen location is unavailable.')
}
