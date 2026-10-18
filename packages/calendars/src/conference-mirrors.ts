import { randomUUID } from 'node:crypto'
import { defineJob } from '@hourmere/jobs'
import type { ServiceContext } from '@hourmere/scheduling'
import { conferenceOrganizerAvailable } from '@hourmere/scheduling/conferences'
import { DomainError } from '@hourmere/scheduling/errors'
import { sql } from 'kysely'
import { z } from 'zod'
import { GoogleCalendarError } from './google.ts'
import {
  type GoogleEvent,
  type GoogleEventWrite,
  googleMeetUrl,
  safeGoogleEventId,
} from './google-events.ts'
import type { CalendarDeps } from './index.ts'
import { useGoogleConnection } from './sync.ts'

const clock = (d: CalendarDeps) => new Date((d.now ?? Date.now)())
const LIMIT = 8

/** A separate durable due scan recovers booking-calendar jobs that ran before root readiness. */
export function conferenceMirrorDispatchJob(
  deps: CalendarDeps,
  enqueue: (id: string) => Promise<unknown>,
) {
  return defineJob({
    name: 'conference-mirror-dispatch',
    payload: z.strictObject({}),
    policy: 'exclusive',
    concurrency: 1,
    schedule: { cron: '* * * * *', payload: {} },
    expireInSeconds: 120,
    handler: async () => {
      const due = await deps.db
        .selectFrom('booking_conference_mirrors as m')
        .innerJoin('booking_conferences as c', 'c.root_booking_id', 'm.root_booking_id')
        .innerJoin('bookings as b', 'b.id', 'c.booking_id')
        .select('m.root_booking_id')
        .distinct()
        .where('m.state', '=', 'pending')
        .where('m.next_attempt_at', '<=', clock(deps))
        .where((eb) =>
          eb.or([eb('m.lease_until', 'is', null), eb('m.lease_until', '<=', clock(deps))]),
        )
        .where((eb) =>
          eb.or([
            eb('b.status', '=', 'cancelled'),
            eb.and([
              eb('c.state', '=', 'ready'),
              eb('c.applied_revision', '=', eb.ref('c.revision')),
            ]),
          ]),
        )
        .orderBy('m.root_booking_id')
        .limit(100)
        .execute()
      for (const r of due) await enqueue(r.root_booking_id)
    },
  })
}
async function claim(deps: CalendarDeps, root: string, userId: string) {
  return deps.db.transaction().execute(async (trx) => {
    const m = await trx
      .selectFrom('booking_conference_mirrors')
      .selectAll()
      .where('root_booking_id', '=', root)
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst()
    const now = clock(deps)
    if (
      m?.state !== 'pending' ||
      !m.calendar_id ||
      !m.connection_id ||
      m.next_attempt_at > now ||
      (m.lease_until && m.lease_until > now)
    )
      return
    const c = await trx
      .selectFrom('booking_conferences')
      .selectAll()
      .where('root_booking_id', '=', root)
      .executeTakeFirst()
    if (!c || c.invitation_organizer_email === null) return
    const b = await trx
      .selectFrom('bookings')
      .select(['id', 'status', 'start_at', 'end_at', 'title', 'location'])
      .where('id', '=', c.booking_id)
      .executeTakeFirst()
    if (
      !b ||
      (b.status === 'confirmed' &&
        (c.state !== 'ready' || c.applied_revision !== c.revision || c.revision !== m.revision))
    )
      return
    const url =
      typeof b.location === 'object' &&
      b.location !== null &&
      !Array.isArray(b.location) &&
      'url' in b.location
        ? googleMeetUrl(b.location.url)
        : undefined
    if (b.status === 'confirmed' && !url) return
    const lease = randomUUID(),
      create = b.status === 'confirmed' && !m.create_started && !m.external_event_id
    await trx
      .updateTable('booking_conference_mirrors')
      .set({
        lease_id: lease,
        lease_until: new Date(now.getTime() + 120_000),
        create_started: m.create_started || create,
        attempts: m.attempts + 1,
        updated_at: now,
      })
      .where('root_booking_id', '=', root)
      .where('user_id', '=', userId)
      .execute()
    return {
      ...m,
      calendar_id: m.calendar_id,
      connection_id: m.connection_id,
      c,
      b,
      url,
      lease,
      create,
      attempts: m.attempts + 1,
    }
  })
}
type Claim = NonNullable<Awaited<ReturnType<typeof claim>>>
type Outcome = { event?: GoogleEvent; cancelled?: boolean; error?: string; knownNoCreate?: boolean }
const valueFor = (c: Claim): GoogleEventWrite => ({
  iCalUID: `${c.root_booking_id}@hourmere`,
  summary: c.b.title,
  start: { dateTime: c.b.start_at.toISOString() },
  end: { dateTime: c.b.end_at.toISOString() },
  sequence: c.revision,
  status: c.b.status === 'confirmed' ? 'confirmed' : 'cancelled',
  transparency: 'opaque',
  ...(c.url ? { location: c.url, description: `Join: ${c.url}` } : {}),
})
function valid(event: GoogleEvent, c: Claim): boolean {
  return (
    safeGoogleEventId(event.id) &&
    (!c.external_event_id || c.external_event_id === event.id) &&
    event.iCalUID === `${c.root_booking_id}@hourmere` &&
    !event.conferenceData &&
    !event.recurringEventId &&
    !event.recurrence?.length
  )
}
function matches(event: GoogleEvent, c: Claim) {
  if (c.b.status === 'cancelled') return event.status === 'cancelled'
  try {
    return (
      event.status !== 'cancelled' &&
      event.location === c.url &&
      Temporal.Instant.from(event.start?.dateTime ?? '').equals(
        Temporal.Instant.from(c.b.start_at.toISOString()),
      ) &&
      Temporal.Instant.from(event.end?.dateTime ?? '').equals(
        Temporal.Instant.from(c.b.end_at.toISOString()),
      )
    )
  } catch {
    return false
  }
}
async function provider(deps: CalendarDeps, c: Claim, signal: AbortSignal): Promise<Outcome> {
  if (c.b.status === 'cancelled' && !c.create_started && !c.external_event_id)
    return { cancelled: true }
  if (c.b.status === 'confirmed' && !(await conferenceOrganizerAvailable(deps.db, c.c)))
    return { error: 'organizer_unavailable', knownNoCreate: c.create }
  if (c.b.status === 'confirmed' && c.b.start_at <= clock(deps))
    return { error: 'meeting_started', knownNoCreate: c.create }
  let posted = false
  try {
    const result = await useGoogleConnection(
      deps,
      c.connection_id,
      signal,
      async (trx, token, userId): Promise<Outcome> => {
        const calendar = await trx
          .selectFrom('calendars')
          .select(['external_id', 'access_role'])
          .where('id', '=', c.calendar_id)
          .where('connection_id', '=', c.connection_id)
          .executeTakeFirst()
        if (calendar?.access_role !== 'owner' || userId !== c.user_id || !deps.google)
          return { error: 'calendar_unavailable', knownNoCreate: c.create }
        const client = deps.google.client,
          value = valueFor(c)
        if (c.create) {
          posted = true
          const event = await client.importEvent(token, calendar.external_id, value, signal)
          return valid(event, c)
            ? { event, ...(!matches(event, c) ? { error: 'invalid_response' } : {}) }
            : { error: 'invalid_response' }
        }
        const found = c.external_event_id
          ? await client.getConferenceEvent(
              token,
              calendar.external_id,
              c.external_event_id,
              signal,
            )
          : await client.findConferenceEvent(token, calendar.external_id, value.iCalUID, signal)
        if (!found) return c.create_started ? { error: 'ambiguous_create' } : { cancelled: true }
        if (!valid(found, c)) return { error: 'invalid_response' }
        if (c.b.status === 'cancelled' && found.status === 'cancelled')
          return { event: found, cancelled: true }
        const event = await client.updateEvent(
          token,
          calendar.external_id,
          found.id,
          found.etag,
          value,
          signal,
        )
        if (!valid(event, c) || event.id !== found.id || !matches(event, c))
          return { event: found, error: 'invalid_response' }
        return { event, ...(c.b.status === 'cancelled' ? { cancelled: true } : {}) }
      },
    )
    return result ?? { error: 'calendar_unavailable', knownNoCreate: c.create }
  } catch (error) {
    if (error instanceof GoogleCalendarError) {
      if (error.status === 404 && c.b.status === 'cancelled' && c.external_event_id)
        return { cancelled: true }
      const known = posted && [400, 401, 403, 404].includes(error.status ?? 0)
      return {
        error: known
          ? error.status === 400
            ? 'invalid_response'
            : error.status === 404
              ? 'calendar_unavailable'
              : error.code
          : posted
            ? 'ambiguous_create'
            : error.code,
        knownNoCreate: known || (c.create && !posted),
      }
    }
    // Unknown application/SQL errors propagate. The committed create_started still prevents
    // another POST after lease expiry; transport failure after POST is explicitly ambiguous.
    throw error
  }
}
async function apply(deps: CalendarDeps, c: Claim, outcome: Outcome) {
  await deps.db.transaction().execute(async (trx) => {
    const b = await trx
      .selectFrom('bookings')
      .select(['status', 'start_at'])
      .where('id', '=', c.c.booking_id)
      .forUpdate()
      .executeTakeFirst()
    const current = await trx
      .selectFrom('booking_conferences')
      .selectAll()
      .where('root_booking_id', '=', c.root_booking_id)
      .forUpdate()
      .executeTakeFirst()
    const m = await trx
      .selectFrom('booking_conference_mirrors')
      .selectAll()
      .where('root_booking_id', '=', c.root_booking_id)
      .where('user_id', '=', c.user_id)
      .forUpdate()
      .executeTakeFirst()
    if (!b || !current || !m) return
    const target = () =>
      trx
        .updateTable('booking_conference_mirrors')
        .where('root_booking_id', '=', c.root_booking_id)
        .where('user_id', '=', c.user_id)
    // Preserve a late discovered ID even when an intervening move/cancel invalidated its revision.
    if (
      outcome.event &&
      valid(outcome.event, c) &&
      (!m.external_event_id || m.external_event_id === outcome.event.id)
    )
      await target()
        .set({
          external_event_id: outcome.event.id,
          ...(!m.external_event_id && m.state === 'failed' && m.error_code === 'ambiguous_create'
            ? { state: 'pending', error_code: null, next_attempt_at: clock(deps) }
            : {}),
        })
        .execute()
    if (m.lease_id !== c.lease) return
    if (
      current.booking_id !== c.c.booking_id ||
      current.revision !== c.c.revision ||
      m.revision !== c.revision ||
      b.status !== c.b.status
    ) {
      await target()
        .set({ lease_id: null, lease_until: null, next_attempt_at: clock(deps) })
        .execute()
      return
    }
    // Another expired lease may discover the ID while this lease's empty UID lookup is
    // in flight. A stale absence must not strand a now-known copy in a terminal state.
    if (outcome.error === 'ambiguous_create' && !c.external_event_id && m.external_event_id) {
      await target()
        .set({
          state: 'pending',
          error_code: null,
          lease_id: null,
          lease_until: null,
          next_attempt_at: clock(deps),
        })
        .execute()
      return
    }
    const now = clock(deps),
      error = outcome.error
    const ready = Boolean(outcome.cancelled || (outcome.event && !error))
    const retryable = !ready && error === 'provider_unavailable' && c.attempts < LIMIT
    await target()
      .set({
        state: ready ? 'ready' : retryable ? 'pending' : 'failed',
        applied_revision: ready ? c.revision : null,
        error_code: ready || retryable ? null : (error ?? 'provider_unavailable'),
        lease_id: null,
        lease_until: null,
        ...(outcome.knownNoCreate ? { create_started: false } : {}),
        next_attempt_at: new Date(
          now.getTime() + Math.min(60_000, 5_000 * 2 ** Math.min(c.attempts, 4)),
        ),
        updated_at: now,
      })
      .execute()
    if (ready && outcome.cancelled && m.external_event_id)
      await trx
        .deleteFrom('calendar_busy')
        .where('calendar_id', '=', c.calendar_id)
        .where('external_event_id', '=', m.external_event_id)
        .execute()
    if (!ready || !outcome.event) return
    const calendar = await trx
      .selectFrom('calendars')
      .select('id')
      .where('id', '=', c.calendar_id)
      .forKeyShare()
      .executeTakeFirst()
    if (!calendar) return
    await trx
      .insertInto('booking_calendar_events')
      .values({
        booking_id: c.c.booking_id,
        calendar_id: c.calendar_id,
        external_event_id: outcome.event.id,
        etag: outcome.event.etag ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['booking_id', 'calendar_id']).doUpdateSet({
          external_event_id: outcome.event?.id as string,
          etag: outcome.event?.etag ?? null,
        }),
      )
      .execute()
    if (b.status === 'confirmed')
      await trx
        .insertInto('calendar_busy')
        .values({
          calendar_id: c.calendar_id,
          external_event_id: outcome.event.id,
          period: sql<string>`tstzrange(${c.b.start_at}::timestamptz,${c.b.end_at}::timestamptz,'[)')`,
        })
        .onConflict((oc) =>
          oc
            .columns(['calendar_id', 'external_event_id'])
            .doUpdateSet((eb) => ({ period: eb.ref('excluded.period') })),
        )
        .execute()
    else
      await trx
        .deleteFrom('calendar_busy')
        .where('calendar_id', '=', c.calendar_id)
        .where('external_event_id', '=', outcome.event.id)
        .execute()
  })
}
export async function writeConferenceMirrors(
  deps: CalendarDeps,
  root: string,
  signal = AbortSignal.timeout(60_000),
) {
  const targets = await deps.db
    .selectFrom('booking_conference_mirrors')
    .select('user_id')
    .where('root_booking_id', '=', root)
    .orderBy('user_id')
    .limit(7)
    .execute()
  for (const target of targets) {
    const c = await claim(deps, root, target.user_id)
    if (c) await apply(deps, c, await provider(deps, c, signal))
  }
}
export async function retryConferenceMirror(ctx: ServiceContext, bookingId: string) {
  await ctx.db.transaction().execute(async (trx) => {
    const user = await trx
      .selectFrom('auth.user')
      .select('id')
      .where('id', '=', ctx.principal.user.id)
      .where('emailVerified', '=', true)
      .forShare()
      .executeTakeFirst()
    const org = await trx
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', ctx.principal.organization.id)
      .forKeyShare()
      .executeTakeFirst()
    const member = await trx
      .selectFrom('auth.member')
      .select('id')
      .where('organizationId', '=', ctx.principal.organization.id)
      .where('userId', '=', ctx.principal.user.id)
      .forShare()
      .executeTakeFirst()
    const b = await trx
      .selectFrom('bookings')
      .select(['organization_id', 'status', 'start_at'])
      .where('id', '=', bookingId)
      .forUpdate()
      .executeTakeFirst()
    const c = await trx
      .selectFrom('booking_conferences')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .forUpdate()
      .executeTakeFirst()
    const m = c
      ? await trx
          .selectFrom('booking_conference_mirrors')
          .selectAll()
          .where('root_booking_id', '=', c.root_booking_id)
          .where('user_id', '=', ctx.principal.user.id)
          .forUpdate()
          .executeTakeFirst()
      : undefined
    if (
      !user ||
      !org ||
      !member ||
      !b ||
      b.organization_id !== ctx.principal.organization.id ||
      !c ||
      !m
    )
      throw new DomainError('not_found', 'calendar_copy_not_found')
    if (
      m.state !== 'failed' ||
      !m.calendar_id ||
      (b.status === 'confirmed' && b.start_at <= new Date(ctx.now().epochMilliseconds))
    )
      throw new DomainError('conflict', 'calendar_copy_not_retryable')
    await trx
      .updateTable('booking_conference_mirrors')
      .set({
        state: 'pending',
        error_code: null,
        attempts: 0,
        next_attempt_at: ctx.now().toString(),
      })
      .where('root_booking_id', '=', m.root_booking_id)
      .where('user_id', '=', m.user_id)
      .execute()
  })
}
