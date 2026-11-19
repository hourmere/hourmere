import { createHash } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { sql } from 'kysely'
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

/** Owner-session connection dependencies; credential inputs never pass through agent tools. */
export interface CalDavConnectionDeps {
  db: Db
  client: CalDavDiscoveryClient
  encryptionKey: string
  now?: () => number
  enqueueSync?: ((calendarId: string, transaction: Db) => Promise<unknown>) | undefined
  enqueueWritebackRecovery?:
    | ((connectionId: string, transaction: Db) => Promise<unknown>)
    | undefined
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
  settings?: {
    connectionId?: string | undefined
    conflictCalendarUrls: readonly string[]
    destinationCalendarUrl: string | null
  },
) {
  const session = requireCalendarSession(principal)
  return safe(async () => {
    const selectedUrls = [...selectedCalendarUrls]
    const choices = settings
      ? { ...settings, conflictCalendarUrls: [...settings.conflictCalendarUrls] }
      : undefined
    const key = calendarEncryptionKey(deps.encryptionKey)
    const candidate = createCalDavCredentialRecord(key, session.user.id, input)
    const credentials = readCalDavCredentials(key, candidate)
    await authorizeCalDavConnection(deps, principal, choices?.connectionId)
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
      calendars.some((calendar) => !calendar.supportsEvents) ||
      (choices &&
        (new Set(choices.conflictCalendarUrls).size !== choices.conflictCalendarUrls.length ||
          choices.conflictCalendarUrls.some((url) => !selected.has(url)) ||
          (choices.destinationCalendarUrl !== null &&
            !calendars.some(
              (calendar) => calendar.url === choices.destinationCalendarUrl && calendar.canWrite,
            ))))
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
      if (choices?.connectionId && existing?.id !== choices.connectionId)
        throw new DomainError('conflict', 'caldav_connection_identity_changed')
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
          sync_state: sql`jsonb_set(coalesce(sync_state, '{}'::jsonb), '{caldavDiscovery}', '{"version":1,"available":false,"color":null}'::jsonb)`,
          sync_error: 'provider_unavailable',
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
              sync_state: sql`jsonb_set(coalesce(calendars.sync_state, '{}'::jsonb), '{caldavDiscovery}', ${JSON.stringify({ version: 1, available: true, color })}::jsonb)`,
            }),
          )
          .execute()
      }
      if (choices) {
        const inventory = await trx
          .selectFrom('calendars')
          .select(['id', 'external_id', 'check_conflicts'])
          .where('connection_id', '=', record.id)
          .execute()
        const conflicts = inventory.filter((calendar) =>
          choices.conflictCalendarUrls.includes(calendar.external_id),
        )
        const other = await trx
          .selectFrom('calendars as c')
          .innerJoin('calendar_connections as cc', 'cc.id', 'c.connection_id')
          .select(sql<number>`count(*)::int`.as('count'))
          .where('cc.user_id', '=', session.user.id)
          .where('cc.id', '!=', record.id)
          .where('c.check_conflicts', '=', true)
          .executeTakeFirstOrThrow()
        const missingSelections = inventory.filter(
          (calendar) => calendar.check_conflicts && !selected.has(calendar.external_id),
        ).length
        if (other.count + conflicts.length + missingSelections > 20)
          throw new DomainError('conflict', 'calendar_selection_limit')
        if (selectedUrls.length)
          await trx
            .updateTable('calendars')
            .set({ check_conflicts: false })
            .where('connection_id', '=', record.id)
            .where('external_id', 'in', selectedUrls)
            .execute()
        for (const calendar of conflicts) {
          await trx
            .updateTable('calendars')
            .set({ check_conflicts: true })
            .where('id', '=', calendar.id)
            .execute()
          await deps.enqueueSync?.(calendar.id, trx)
        }
        const destination = inventory.find(
          (calendar) => calendar.external_id === choices.destinationCalendarUrl,
        )
        if (destination) {
          const updated = await trx
            .updateTable('profiles')
            .set({ destination_calendar_id: destination.id })
            .where('user_id', '=', session.user.id)
            .executeTakeFirst()
          if (!updated.numUpdatedRows) throw new DomainError('not_found', 'profile_not_found')
        } else {
          await trx
            .updateTable('profiles')
            .set({ destination_calendar_id: null })
            .where('user_id', '=', session.user.id)
            .where(
              'destination_calendar_id',
              'in',
              trx.selectFrom('calendars').select('id').where('connection_id', '=', record.id),
            )
            .execute()
        }
      }
      if (existing) await deps.enqueueWritebackRecovery?.(record.id, trx)
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

/** Credential-bearing surfaces always validate the live owner before outbound work. */
export async function authorizeCalDavConnection(
  deps: CalDavConnectionDeps,
  principal: Principal,
  connectionId?: string,
) {
  const session = requireCalendarSession(principal)
  await deps.db.transaction().execute(async (trx) => {
    await lockUser(trx, session, deps.now ?? Date.now)
    if (connectionId) {
      const existing = await trx
        .selectFrom('calendar_connections')
        .select('id')
        .where('id', '=', connectionId)
        .where('provider', '=', 'caldav')
        .where('user_id', '=', session.user.id)
        .executeTakeFirst()
      if (!existing) throw notFound()
    }
  })
}

const calendarKey = (url: string) => createHash('sha256').update(url).digest('hex')
export async function discoverCalDavConnection(
  deps: CalDavConnectionDeps,
  principal: Principal,
  input: CalDavCredentials & { connectionId?: string | undefined },
) {
  return safe(async () => {
    await authorizeCalDavConnection(deps, principal, input.connectionId)
    const key = calendarEncryptionKey(deps.encryptionKey)
    const credentials = readCalDavCredentials(
      key,
      createCalDavCredentialRecord(key, principal.user.id, input),
    )
    const result = await deps.client.discover(credentials)
    await authorizeCalDavConnection(deps, principal, input.connectionId)
    return {
      calendars: result.calendars
        .filter((calendar) => calendar.supportsEvents)
        .map((calendar) => ({
          key: calendarKey(calendar.url),
          displayName:
            calendar.displayName &&
            ![credentials.username, credentials.password].some((secret) =>
              calendar.displayName?.includes(secret),
            )
              ? calendar.displayName
              : 'Calendar',
          color:
            calendar.color && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(calendar.color)
              ? calendar.color
              : null,
          canWrite: calendar.canWrite,
        })),
    }
  })
}

export async function saveCalDavConnection(
  deps: CalDavConnectionDeps,
  principal: Principal,
  input: CalDavCredentials & {
    connectionId?: string | undefined
    calendarKeys: string[]
    conflictCalendarKeys: string[]
    destinationCalendarKey: string | null
  },
) {
  return safe(async () => {
    await authorizeCalDavConnection(deps, principal, input.connectionId)
    const key = calendarEncryptionKey(deps.encryptionKey)
    const credentials = readCalDavCredentials(
      key,
      createCalDavCredentialRecord(key, principal.user.id, input),
    )
    const result = await deps.client.discover(credentials)
    const urls = new Map(
      result.calendars.map((calendar) => [calendarKey(calendar.url), calendar.url]),
    )
    const resolve = (value: string) => {
      const url = urls.get(value)
      if (!url) throw invalidSelection()
      return url
    }
    return connectCalDav(
      { ...deps, client: { discover: async () => result } },
      principal,
      credentials,
      input.calendarKeys.map(resolve),
      {
        connectionId: input.connectionId,
        conflictCalendarUrls: input.conflictCalendarKeys.map(resolve),
        destinationCalendarUrl:
          input.destinationCalendarKey === null ? null : resolve(input.destinationCalendarKey),
      },
    )
  })
}
