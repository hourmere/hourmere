import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { z } from 'zod'
import {
  type CalDavCredentials,
  createCalDavCredentialRecord,
  readCalDavCredentials,
} from './caldav-credentials.ts'
import type { CalDavDiscoveryClient } from './caldav-discovery.ts'
import { CalDavError } from './caldav-transport.ts'
import { calendarEncryptionKey } from './credentials.ts'
import { lockUser, requireCalendarSession } from './index.ts'

/** Internal only: no route, worker or provider enablement is registered. */
export interface CalDavConnectionDeps {
  db: Db
  client: CalDavDiscoveryClient
  encryptionKey: string
  now?: () => number
}
const notFound = () => new DomainError('not_found', 'calendar_connection_not_found')
const invalidSelection = () => new DomainError('invalid', 'caldav_calendar_selection_invalid')

/** Never propagate provider/database payloads into errors or their cause chains. */
async function safe<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof DomainError) throw error
    if (error instanceof CalDavError) throw new CalDavError(error.code)
    throw new CalDavError('unavailable')
  }
}

/** Discover before writing. Ownership is personal and does not change with organization context. */
export async function connectCalDav(
  deps: CalDavConnectionDeps,
  principal: Principal,
  input: CalDavCredentials,
  selectedCalendarUrls: readonly string[],
) {
  const session = requireCalendarSession(principal)
  return safe(async () => {
    const selectedUrls = [...selectedCalendarUrls]
    const key = calendarEncryptionKey(deps.encryptionKey)
    const candidate = createCalDavCredentialRecord(key, session.user.id, input)
    const credentials = readCalDavCredentials(key, candidate)
    await deps.db.transaction().execute((trx) => lockUser(trx, session, deps.now ?? Date.now))
    const discovery = await Promise.resolve()
      .then(() => deps.client.discover(credentials))
      .catch((error: unknown) => {
        throw new CalDavError(error instanceof CalDavError ? error.code : 'unavailable')
      })
    const selected = new Set(selectedUrls)
    const calendars = discovery.calendars.filter((calendar) => selected.has(calendar.url))
    if (
      selected.size !== selectedUrls.length ||
      calendars.length !== selected.size ||
      calendars.some((calendar) => !calendar.supportsEvents)
    )
      throw invalidSelection()
    return deps.db.transaction().execute(async (trx) => {
      // Discovery can outlive a session. Serialize reconnects and check authorization again.
      await lockUser(trx, session, deps.now ?? Date.now)
      const existing = await trx
        .selectFrom('calendar_connections')
        .select('id')
        .where('user_id', '=', session.user.id)
        .where('provider', '=', 'caldav')
        .where('external_account_id', '=', candidate.external_account_id)
        .executeTakeFirst()
      const record = existing
        ? createCalDavCredentialRecord(key, session.user.id, credentials, existing.id)
        : candidate
      if (existing) {
        await trx
          .updateTable('calendar_connections')
          .set({
            credentials: record.credentials,
            status: 'active',
            last_error: null,
            updated_at: new Date((deps.now ?? Date.now)()),
          })
          .where('id', '=', existing.id)
          .where('user_id', '=', session.user.id)
          .execute()
      } else {
        await trx.insertInto('calendar_connections').values(record).execute()
      }
      // Preserve identities and pinned references; an absent collection is unavailable,
      // never silently deleted or declared freshly synchronized.
      await trx
        .updateTable('calendars')
        .set({
          sync_state: { caldavDiscovery: { version: 1, available: false, color: null } },
          sync_error: null,
          access_role: 'reader',
        })
        .where('connection_id', '=', record.id)
        .execute()
      for (const calendar of calendars) {
        const color =
          calendar.color && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(calendar.color)
            ? calendar.color
            : null
        const name =
          calendar.displayName &&
          ![credentials.password, credentials.username].some((secret) =>
            calendar.displayName?.includes(secret),
          )
            ? calendar.displayName
            : 'Calendar'
        await trx
          .insertInto('calendars')
          .values({
            connection_id: record.id,
            external_id: calendar.url,
            name,
            access_role: calendar.canWrite ? 'writer' : 'reader',
            check_conflicts: false,
            sync_state: { caldavDiscovery: { version: 1, available: true, color } },
          })
          .onConflict((oc) =>
            oc.columns(['connection_id', 'external_id']).doUpdateSet({
              name,
              access_role: calendar.canWrite ? 'writer' : 'reader',
              sync_error: null,
              sync_state: {
                caldavDiscovery: { version: 1, available: true, color },
              },
            }),
          )
          .execute()
      }
      return { id: record.id }
    })
  })
}

export async function listCalDavConnections(deps: CalDavConnectionDeps, principal: Principal) {
  const session = requireCalendarSession(principal)
  return safe(() =>
    deps.db.transaction().execute(async (trx) => {
      await lockUser(trx, session, deps.now ?? Date.now)
      const connections = await trx
        .selectFrom('calendar_connections')
        .select(['id', 'status'])
        .where('user_id', '=', session.user.id)
        .where('provider', '=', 'caldav')
        .orderBy('id')
        .execute()
      return Promise.all(
        connections.map(async (connection) => {
          const calendars = await trx
            .selectFrom('calendars')
            .select(['id', 'name', 'access_role', 'sync_state'])
            .where('connection_id', '=', connection.id)
            .orderBy('id')
            .execute()
          return {
            ...connection,
            calendars: calendars.map((calendar) => {
              const metadata = z
                .object({
                  caldavDiscovery: z.object({
                    version: z.literal(1),
                    available: z.boolean(),
                    color: z.string().nullable(),
                  }),
                })
                .safeParse(calendar.sync_state)
              return {
                id: calendar.id,
                displayName: calendar.name,
                readOnly: calendar.access_role !== 'writer',
                available: metadata.success && metadata.data.caldavDiscovery.available,
                color: metadata.success ? metadata.data.caldavDiscovery.color : null,
              }
            }),
          }
        }),
      )
    }),
  )
}

export async function disconnectCalDav(
  deps: CalDavConnectionDeps,
  principal: Principal,
  id: string,
) {
  const session = requireCalendarSession(principal)
  if (!z.uuid().safeParse(id).success) throw notFound()
  return safe(() =>
    deps.db.transaction().execute(async (trx) => {
      await lockUser(trx, session, deps.now ?? Date.now)
      const removed = await trx
        .deleteFrom('calendar_connections')
        .where('id', '=', id)
        .where('user_id', '=', session.user.id)
        .where('provider', '=', 'caldav')
        .returning('id')
        .executeTakeFirst()
      if (!removed) throw notFound()
    }),
  )
}
