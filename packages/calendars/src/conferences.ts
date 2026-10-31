import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import { defineJob, type EnqueueOptions } from '@hourmere/jobs'
import type { ServiceContext } from '@hourmere/scheduling'
import { conferenceJoinUrl, zoomMeetingId } from '@hourmere/scheduling/conference-url'
import {
  type ConferenceResult,
  conferenceOrganizerAvailable,
  conferenceRoot,
} from '@hourmere/scheduling/conferences'
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

export const CONFERENCE_JOB = 'booking-conference'
const POLL_LIMIT = 12
const LEASE_MS = 120_000
const clock = (deps: CalendarDeps) => new Date((deps.now ?? Date.now)())
interface ConferenceQueue {
  enqueue(
    name: typeof CONFERENCE_JOB,
    payload: { rootBookingId: string },
    options?: EnqueueOptions,
  ): Promise<string | null>
}
export function conferenceBookingNotifier(queue: ConferenceQueue) {
  return async (trx: Db, event: { bookingId: string }) => {
    if (!trx.isTransaction) throw Error('Conference jobs require the booking transaction')
    const root = await conferenceRoot(trx, event.bookingId)
    if (
      root &&
      (await trx
        .selectFrom('booking_conferences')
        .select('root_booking_id')
        .where('root_booking_id', '=', root)
        .executeTakeFirst())
    )
      await queue.enqueue(
        CONFERENCE_JOB,
        { rootBookingId: root },
        { transaction: trx, singletonKey: root },
      )
  }
}
export function bookingConferenceJob(deps: CalendarDeps) {
  return defineJob({
    name: CONFERENCE_JOB,
    payload: z.strictObject({ rootBookingId: z.uuid() }),
    policy: 'stately',
    concurrency: 2,
    retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 120 },
    expireInSeconds: 180,
    handler: ({ rootBookingId }, { signal }) =>
      writeBookingConference(
        deps,
        rootBookingId,
        AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      ),
  })
}
export function conferenceDispatchJob(
  deps: CalendarDeps,
  enqueue: (id: string) => Promise<unknown>,
) {
  return defineJob({
    name: 'conference-dispatch',
    payload: z.strictObject({}),
    policy: 'exclusive',
    concurrency: 1,
    schedule: { cron: '* * * * *', payload: {} },
    expireInSeconds: 120,
    handler: async () => {
      const due = await deps.db
        .selectFrom('booking_conferences')
        .select('root_booking_id')
        .where('state', '=', 'pending')
        .where('next_attempt_at', '<=', clock(deps))
        .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', clock(deps))]))
        .orderBy('next_attempt_at')
        .limit(100)
        .execute()
      for (const row of due) await enqueue(row.root_booking_id)
    },
  })
}

/** Claims no booking/advisory lock; the transaction is finished before provider work. */
async function claim(deps: CalendarDeps, root: string) {
  return deps.db.transaction().execute(async (trx) => {
    const c = await trx
      .selectFrom('booking_conferences')
      .selectAll()
      .where('root_booking_id', '=', root)
      .forUpdate()
      .executeTakeFirst()
    const now = clock(deps)
    if (c?.state !== 'pending' || c.next_attempt_at > now || (c.lease_until && c.lease_until > now))
      return
    const booking = await trx
      .selectFrom('bookings')
      .select(['id', 'start_at', 'end_at', 'status', 'title'])
      .where('id', '=', c.booking_id)
      .executeTakeFirst()
    if (!booking) return
    const lease = randomUUID()
    const create =
      !c.create_started &&
      !c.external_event_id &&
      !c.zoom_meeting_id &&
      booking.status === 'confirmed'
    await trx
      .updateTable('booking_conferences')
      .set({
        lease_id: lease,
        lease_until: new Date(now.getTime() + LEASE_MS),
        create_started: c.create_started || create,
        attempts: c.attempts + 1,
        updated_at: now,
      })
      .where('root_booking_id', '=', root)
      .execute()
    return { ...c, booking, lease, create, attempts: c.attempts + 1 }
  })
}
type Claim = NonNullable<Awaited<ReturnType<typeof claim>>>
type Outcome = ConferenceResult & {
  event?: GoogleEvent
  conferencePatchRequestId?: string
}
const valueFor = (c: Claim): GoogleEventWrite => ({
  iCalUID: `${c.root_booking_id}@hourmere`,
  summary: c.booking.title,
  start: { dateTime: c.booking.start_at.toISOString() },
  end: { dateTime: c.booking.end_at.toISOString() },
  sequence: c.revision,
  status: c.booking.status === 'confirmed' ? 'confirmed' : 'cancelled',
  transparency: 'opaque',
})
const sameTimes = (event: GoogleEvent, c: Claim) => {
  try {
    return (
      Temporal.Instant.from(event.start?.dateTime ?? '').equals(
        Temporal.Instant.from(c.booking.start_at.toISOString()),
      ) &&
      Temporal.Instant.from(event.end?.dateTime ?? '').equals(
        Temporal.Instant.from(c.booking.end_at.toISOString()),
      )
    )
  } catch {
    return false
  }
}
function interpretation(event: GoogleEvent, c: Claim): Outcome {
  if (
    !safeGoogleEventId(event.id) ||
    (c.external_event_id && c.external_event_id !== event.id) ||
    event.iCalUID !== `${c.root_booking_id}@hourmere`
  )
    return { error: 'invalid_response' }
  if (c.booking.status === 'cancelled')
    return event.status === 'cancelled'
      ? { event, cancelled: true }
      : { event, error: 'invalid_response' }
  if (!sameTimes(event, c) || event.status === 'cancelled')
    return { event, error: 'invalid_response' }
  const conference = event.conferenceData
  const status = conference?.createRequest?.status?.statusCode
  if (status === 'failure') return { event, error: 'conference_failed' }
  if (status === 'pending') return { event, pending: true }
  const video = conference?.entryPoints?.filter((p) => p.entryPointType === 'video') ?? []
  const url = video.length === 1 ? googleMeetUrl(video[0]?.uri) : undefined
  if (
    conference?.conferenceSolution?.key.type === 'hangoutsMeet' &&
    url &&
    (status === 'success' || status === undefined)
  )
    return { event, url }
  return { event, error: 'invalid_response' }
}
async function providerWork(deps: CalendarDeps, c: Claim, signal: AbortSignal): Promise<Outcome> {
  if (c.booking.status === 'confirmed' && !(await conferenceOrganizerAvailable(deps.db, c)))
    return { error: 'organizer_unavailable', knownNoCreate: c.create }
  if (c.provider === 'zoom')
    return deps.zoomConferenceWork
      ? deps.zoomConferenceWork(
          {
            rootBookingId: c.root_booking_id,
            organizerUserId: c.organizer_user_id,
            connectionId: c.zoom_connection_id,
            externalUserId: c.zoom_user_id,
            meetingId: c.zoom_meeting_id,
            create: c.create,
            createStarted: c.create_started,
            booking: c.booking,
          },
          signal,
        )
      : { error: 'disabled', knownNoCreate: c.create }
  if (c.booking.status === 'cancelled' && !c.create_started && !c.external_event_id)
    return { cancelled: true }
  if (!deps.google || !c.connection_id || !c.calendar_id)
    return { error: 'calendar_unavailable', knownNoCreate: c.create }
  let attemptedImport = false
  let knownEvent: GoogleEvent | undefined
  // An import and its conference PATCH are distinct provider operations. Preserve
  // the imported identity even when a later PATCH fails or its response is lost.
  const remember = (event: GoogleEvent) => {
    if (
      !safeGoogleEventId(event.id) ||
      event.iCalUID !== `${c.root_booking_id}@hourmere` ||
      (c.external_event_id && c.external_event_id !== event.id) ||
      (knownEvent && knownEvent.id !== event.id)
    )
      return false
    knownEvent = event
    return true
  }
  try {
    const result = await useGoogleConnection(
      deps,
      c.connection_id,
      signal,
      async (trx, token, userId): Promise<Outcome> => {
        const calendar = await trx
          .selectFrom('calendars')
          .select(['external_id', 'access_role', 'supports_google_meet'])
          .where('id', '=', c.calendar_id as string)
          .where('connection_id', '=', c.connection_id as string)
          .executeTakeFirst()
        if (!calendar || userId !== c.organizer_user_id || calendar.access_role !== 'owner')
          return { error: 'calendar_unavailable', knownNoCreate: c.create }
        const client = deps.google?.client
        if (!client) return { error: 'calendar_unavailable', knownNoCreate: c.create }
        const value = valueFor(c)
        let found: GoogleEvent | undefined
        if (c.create) {
          if (!calendar.supports_google_meet)
            return { error: 'calendar_unavailable', knownNoCreate: true }
          attemptedImport = true
          // Google accepts createRequest on import without necessarily processing
          // it. First import the private copy, then PATCH that known event below.
          found = await client.importEvent(token, calendar.external_id, value, signal)
        } else
          found = c.external_event_id
            ? await client.getConferenceEvent(
                token,
                calendar.external_id,
                c.external_event_id,
                signal,
              )
            : await client.findConferenceEvent(token, calendar.external_id, value.iCalUID, signal)
        if (!found) return c.create_started ? { error: 'ambiguous_create' } : { cancelled: true }
        if (!remember(found)) return { error: 'invalid_response' }
        if (c.booking.status === 'cancelled') {
          if (found.status === 'cancelled') return { event: found, cancelled: true }
          const updated = await client.updateEvent(
            token,
            calendar.external_id,
            found.id,
            found.etag,
            value,
            signal,
          )
          return remember(updated)
            ? interpretation(updated, c)
            : { event: found, error: 'invalid_response' }
        }
        if (found.status === 'cancelled' || (c.create && !sameTimes(found, c)))
          return { event: found, error: 'invalid_response' }
        if (!sameTimes(found, c)) {
          const updated = await client.updateEvent(
            token,
            calendar.external_id,
            found.id,
            found.etag,
            value,
            signal,
          )
          if (!remember(updated)) return { event: found, error: 'invalid_response' }
          found = updated
        }
        if (!sameTimes(found, c) || found.status === 'cancelled')
          return { event: found, error: 'invalid_response' }
        const observed = interpretation(found, c)
        // Existing successful links survive retries and moves. Acknowledged
        // pending/failing requests only poll; NULL on legacy rows requires the
        // same-ID PATCH first, even if import left a pending createRequest.
        if (observed.url || c.conference_patch_request_id === c.request_id) return observed
        const conference = found.conferenceData
        const status = conference?.createRequest?.status?.statusCode
        if (
          status !== 'pending' &&
          status !== 'failure' &&
          (status === 'success' ||
            conference?.conferenceSolution ||
            conference?.entryPoints?.length)
        )
          return observed
        if (!calendar.supports_google_meet) return { event: found, error: 'calendar_unavailable' }
        const updated = await client.createConferenceEvent(
          token,
          calendar.external_id,
          found.id,
          found.etag,
          c.request_id,
          signal,
        )
        if (!remember(updated)) return { event: found, error: 'invalid_response' }
        const acceptedId = updated.conferenceData?.createRequest?.requestId
        if (acceptedId && acceptedId !== c.request_id)
          return { event: updated, error: 'invalid_response' }
        const outcome = interpretation(updated, c)
        return {
          ...outcome,
          ...(outcome.pending || outcome.url || outcome.error === 'conference_failed'
            ? { conferencePatchRequestId: c.request_id }
            : {}),
        }
      },
    )
    return result ?? { error: 'calendar_unavailable', knownNoCreate: c.create }
  } catch (error) {
    if (
      error instanceof GoogleCalendarError &&
      error.status === 404 &&
      c.booking.status === 'cancelled' &&
      c.external_event_id
    )
      return { cancelled: true }
    if (
      error instanceof GoogleCalendarError &&
      attemptedImport &&
      !knownEvent &&
      [400, 401, 403, 404, 429].includes(error.status ?? 0)
    )
      return {
        error:
          error.status === 400
            ? 'invalid_response'
            : error.status === 404
              ? 'calendar_unavailable'
              : error.code,
        knownNoCreate: true,
      }
    if (error instanceof GoogleCalendarError)
      return {
        ...(knownEvent ? { event: knownEvent } : {}),
        error:
          attemptedImport && !knownEvent
            ? 'ambiguous_create'
            : knownEvent && error.status === 400
              ? 'invalid_response'
              : error.code,
        knownNoCreate: c.create && !attemptedImport,
      }
    // Transport aborts and shutdown can occur after the provider committed the import.
    return {
      ...(knownEvent ? { event: knownEvent } : {}),
      error: attemptedImport && !knownEvent ? 'ambiguous_create' : 'provider_unavailable',
      knownNoCreate: c.create && !attemptedImport,
    }
  }
}

/** Provider/credential protection has committed before booking -> intent result locks. */
export async function writeBookingConference(
  deps: CalendarDeps,
  root: string,
  signal = AbortSignal.timeout(60_000),
) {
  const c = await claim(deps, root)
  if (!c) return
  let outcome: Outcome =
    c.booking.status === 'confirmed' && c.booking.start_at <= clock(deps)
      ? { error: 'meeting_started', knownNoCreate: c.create }
      : await providerWork(deps, c, signal)
  if (
    outcome.url &&
    !conferenceJoinUrl(c.provider, outcome.url, outcome.meetingId ?? c.zoom_meeting_id)
  )
    outcome = { ...outcome, url: undefined, error: 'invalid_response' }
  await deps.db.transaction().execute(async (trx) => {
    // Actual service order: booking before intent. Never take these locks over network.
    const booking = await trx
      .selectFrom('bookings')
      .select(['status', 'start_at'])
      .where('id', '=', c.booking_id)
      .forUpdate()
      .executeTakeFirst()
    const current = await trx
      .selectFrom('booking_conferences')
      .selectAll()
      .where('root_booking_id', '=', root)
      .forUpdate()
      .executeTakeFirst()
    if (!current || !booking) return
    if (
      outcome.event &&
      safeGoogleEventId(outcome.event.id) &&
      (!current.external_event_id || current.external_event_id === outcome.event.id)
    )
      await trx
        .updateTable('booking_conferences')
        .set({
          external_event_id: outcome.event.id,
          ...(!current.external_event_id &&
          current.state === 'failed' &&
          current.error_code === 'ambiguous_create'
            ? { state: 'pending', error_code: null, next_attempt_at: clock(deps) }
            : {}),
        })
        .where('root_booking_id', '=', root)
        .execute()
    if (
      outcome.meetingId &&
      zoomMeetingId(outcome.meetingId) === outcome.meetingId &&
      current.provider === 'zoom' &&
      (!current.zoom_meeting_id || current.zoom_meeting_id === outcome.meetingId)
    )
      await trx
        .updateTable('booking_conferences')
        .set({
          zoom_meeting_id: outcome.meetingId,
          ...(!current.zoom_meeting_id &&
          current.state === 'failed' &&
          current.error_code === 'ambiguous_create'
            ? { state: 'pending', error_code: null, next_attempt_at: clock(deps) }
            : {}),
        })
        .where('root_booking_id', '=', root)
        .execute()
    if (current.lease_id !== c.lease) return
    if (current.request_id !== c.request_id) {
      await trx
        .updateTable('booking_conferences')
        .set({ lease_id: null, lease_until: null, next_attempt_at: clock(deps) })
        .where('root_booking_id', '=', root)
        .execute()
      return
    }
    const acknowledgedPatch = outcome.conferencePatchRequestId === c.request_id
    const attempts =
      acknowledgedPatch && current.conference_patch_request_id !== c.request_id ? 1 : c.attempts
    if (acknowledgedPatch)
      await trx
        .updateTable('booking_conferences')
        .set({ conference_patch_request_id: c.request_id })
        .where('root_booking_id', '=', root)
        .execute()
    if (
      current.booking_id !== c.booking_id ||
      current.revision !== c.revision ||
      booking.status !== c.booking.status
    ) {
      await trx
        .updateTable('booking_conferences')
        .set({ lease_id: null, lease_until: null, next_attempt_at: clock(deps) })
        .where('root_booking_id', '=', root)
        .execute()
      return
    }
    if (
      outcome.error === 'ambiguous_create' &&
      !(c.external_event_id || c.zoom_meeting_id) &&
      (current.external_event_id || current.zoom_meeting_id)
    ) {
      await trx
        .updateTable('booking_conferences')
        .set({
          state: 'pending',
          error_code: null,
          lease_id: null,
          lease_until: null,
          next_attempt_at: clock(deps),
        })
        .where('root_booking_id', '=', root)
        .execute()
      return
    }
    const now = clock(deps)
    const expired = booking.status === 'confirmed' && booking.start_at <= now
    const organizerAvailable =
      booking.status === 'cancelled' || (await conferenceOrganizerAvailable(trx, current))
    const error = !organizerAvailable
      ? 'organizer_unavailable'
      : expired
        ? 'meeting_started'
        : (outcome.error ??
          (c.provider === 'google_meet' && outcome.pending && attempts >= POLL_LIMIT
            ? 'conference_pending_timeout'
            : undefined))
    const retryable =
      organizerAvailable &&
      !expired &&
      (outcome.pending || error === 'provider_unavailable') &&
      attempts < POLL_LIMIT
    const ready =
      organizerAvailable &&
      !expired &&
      !outcome.error &&
      (Boolean(outcome.url) || outcome.cancelled === true)
    const state = ready ? 'ready' : retryable ? 'pending' : 'failed'
    await trx
      .updateTable('booking_conferences')
      .set({
        state,
        applied_revision: ready ? c.revision : null,
        error_code: ready ? null : retryable ? null : (error ?? 'provider_unavailable'),
        lease_id: null,
        lease_until: null,
        attempts,
        ...(outcome.knownNoCreate ? { create_started: false } : {}),
        next_attempt_at: new Date(
          now.getTime() + Math.min(60_000, 5_000 * 2 ** Math.min(attempts, 4)),
        ),
        updated_at: now,
      })
      .where('root_booking_id', '=', root)
      .execute()
    if (outcome.event && c.calendar_id) {
      // The target can disappear after the credential transaction. Preserve the intent,
      // and only write FK-bound mirrors if the same pinned calendar still exists.
      const calendar = await trx
        .selectFrom('calendars')
        .select('id')
        .where('id', '=', c.calendar_id)
        .forKeyShare()
        .executeTakeFirst()
      if (calendar) {
        await trx
          .insertInto('booking_calendar_events')
          .values({
            booking_id: c.booking_id,
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
        if (booking.status === 'confirmed')
          await trx
            .insertInto('calendar_busy')
            .values({
              calendar_id: c.calendar_id,
              external_event_id: outcome.event.id,
              period: sql<string>`tstzrange(${c.booking.start_at}::timestamptz,${c.booking.end_at}::timestamptz,'[)')`,
            })
            .onConflict((oc) =>
              oc.columns(['calendar_id', 'external_event_id']).doUpdateSet((eb) => ({
                period: eb.ref('excluded.period'),
                all_day_start: null,
                all_day_end: null,
              })),
            )
            .execute()
        else
          await trx
            .deleteFrom('calendar_busy')
            .where('calendar_id', '=', c.calendar_id)
            .where('external_event_id', '=', outcome.event.id)
            .execute()
      }
    }
    if (outcome.cancelled && c.calendar_id && c.external_event_id)
      await trx
        .deleteFrom('calendar_busy')
        .where('calendar_id', '=', c.calendar_id)
        .where('external_event_id', '=', c.external_event_id)
        .execute()
    if (ready && outcome.url && booking.status === 'confirmed') {
      await trx
        .updateTable('bookings')
        .set({
          location: JSON.stringify({
            kind: c.provider === 'zoom' ? 'zoom' : 'google_meet',
            autoCreate: true,
            url: outcome.url,
          }),
        })
        .where('id', '=', c.booking_id)
        .execute()
      const kind = c.booking_id === root ? 'confirmed' : 'rescheduled'
      await trx
        .insertInto('booking_conference_notifications')
        .values({ booking_id: c.booking_id, kind, due_at: now })
        .onConflict((oc) => oc.doNothing())
        .execute()
      const savedPolicy = await trx
        .selectFrom('bookings')
        .select('notification_snapshot')
        .where('id', '=', c.booking_id)
        .executeTakeFirstOrThrow()
      const configurable =
        typeof savedPolicy.notification_snapshot === 'object' &&
        savedPolicy.notification_snapshot !== null &&
        !Array.isArray(savedPolicy.notification_snapshot) &&
        savedPolicy.notification_snapshot.executionMode === 'configurable'
      if (configurable) {
        // Wake only durable existing rules; readiness cannot create another reminder,
        // revive a terminal row or reset the finite attempt budget.
        await sql`UPDATE booking_scheduled_messages SET next_attempt_at=LEAST(next_attempt_at,${now}),updated_at=clock_timestamp()
          WHERE booking_id=${c.booking_id} AND kind='reminder' AND state='pending' AND attempts < 13 AND due_at <= ${now} AND expires_at > ${now}`.execute(
          trx,
        )
      }
      const reminder = new Date(c.booking.start_at.getTime() - 86_400_000)
      if (!configurable && reminder.getTime() > now.getTime() + 60 * 60_000)
        await trx
          .insertInto('booking_conference_notifications')
          .values({ booking_id: c.booking_id, kind: 'reminder', due_at: reminder })
          .onConflict((oc) => oc.doNothing())
          .execute()
    } else if (state === 'failed' && booking.status === 'confirmed') {
      await trx
        .insertInto('booking_conference_notifications')
        .values({ booking_id: c.booking_id, kind: 'conference_failed', due_at: now })
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  })
}

export async function retryBookingConference(ctx: ServiceContext, bookingId: string) {
  await ctx.db.transaction().execute(async (trx) => {
    await ctx.authorizeOrganizationWrite?.(trx, ctx.principal.organization.id, bookingId)
    // Match the service's parent protection before booking -> intent, and retain current
    // membership through the retry commit. These share locks are compatible with a
    // provider's owner KEY SHARE and never cover network work.
    const user = await trx
      .selectFrom('auth.user')
      .select('id')
      .where('id', '=', ctx.principal.user.id)
      .where('emailVerified', '=', true)
      .forShare()
      .executeTakeFirst()
    const organization = await trx
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', ctx.principal.organization.id)
      .forKeyShare()
      .executeTakeFirst()
    const member = await trx
      .selectFrom('auth.member')
      .select('id')
      .where('userId', '=', ctx.principal.user.id)
      .where('organizationId', '=', ctx.principal.organization.id)
      .forShare()
      .executeTakeFirst()
    if (!user || !organization || !member)
      throw new DomainError('not_found', 'conference_not_found')
    const b = await trx
      .selectFrom('bookings')
      .select(['status', 'start_at', 'organization_id'])
      .where('id', '=', bookingId)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('booking_hosts')
            .select('booking_id')
            .whereRef('booking_id', '=', 'bookings.id')
            .where('user_id', '=', ctx.principal.user.id),
        ),
      )
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('auth.member')
            .innerJoin('auth.user', 'auth.user.id', 'auth.member.userId')
            .select('auth.member.id')
            .where('auth.member.organizationId', '=', ctx.principal.organization.id)
            .where('auth.member.userId', '=', ctx.principal.user.id)
            .where('auth.user.emailVerified', '=', true),
        ),
      )
      .forUpdate()
      .executeTakeFirst()
    const c = await trx
      .selectFrom('booking_conferences')
      .selectAll()
      .where('booking_id', '=', bookingId)
      .forUpdate()
      .executeTakeFirst()
    if (
      !b ||
      !c ||
      b.organization_id !== ctx.principal.organization.id ||
      c.organizer_user_id !== ctx.principal.user.id
    )
      throw new DomainError('not_found', 'conference_not_found')
    if (
      (b.status === 'confirmed' && b.start_at <= new Date(ctx.now().epochMilliseconds)) ||
      c.state !== 'failed'
    )
      throw new DomainError('conflict', 'conference_not_retryable')
    const knownFailure = c.external_event_id && c.error_code === 'conference_failed'
    await trx
      .updateTable('booking_conferences')
      .set({
        state: 'pending',
        attempts: 0,
        error_code: null,
        next_attempt_at: ctx.now().toString(),
        ...(knownFailure ? { request_id: randomUUID() } : {}),
      })
      .where('root_booking_id', '=', c.root_booking_id)
      .execute()
    // The durable dispatcher also covers retry if an immediate enqueue is unavailable.
  })
}
