import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import type { ConferenceResult, ConferenceWork } from '@hourmere/scheduling/conferences'
import { conferenceEncryptionKey } from './credentials.ts'
import type { ConferenceDeps } from './index.ts'
import { credentials, readTokens } from './tokens.ts'
import { matchingZoomScopes, refreshZoomTokens, ZoomError, type ZoomTokens } from './zoom.ts'
import type { ZoomMeeting, ZoomMeetingsClient } from './zoom-meetings.ts'

const clock = (deps: ConferenceDeps) => (deps.now ?? Date.now)()
/** Owner protection then connection lock only. Never a booking/intent/host/fairness lock. */
async function connection<T>(
  deps: ConferenceDeps,
  c: ConferenceWork,
  body: (db: Db, record: Awaited<ReturnType<typeof row>>) => Promise<T>,
) {
  return deps.db.transaction().execute(async (db) => {
    const owner = await db
      .selectFrom('auth.user')
      .select('id')
      .where('id', '=', c.organizerUserId)
      .forKeyShare()
      .executeTakeFirst()
    return body(db, owner ? await row(db, c) : undefined)
  })
}
async function row(db: Db, c: ConferenceWork) {
  return c.connectionId
    ? db
        .selectFrom('conference_connections')
        .selectAll()
        .where('id', '=', c.connectionId)
        .where('user_id', '=', c.organizerUserId)
        .forUpdate()
        .executeTakeFirst()
    : undefined
}
const failure = (code: string, c: ConferenceWork, attempted = false): ConferenceResult => ({
  error: attempted ? 'ambiguous_create' : code,
  knownNoCreate: c.create && !attempted,
})
function interpreted(meeting: ZoomMeeting, c: ConferenceWork): ConferenceResult {
  return meeting.joinUrl &&
    meeting.start === c.booking.start_at.toISOString() &&
    meeting.duration === (c.booking.end_at.getTime() - c.booking.start_at.getTime()) / 60000
    ? { meetingId: meeting.id, url: meeting.joinUrl }
    : { meetingId: meeting.id, error: 'invalid_response' }
}
/** The caller's durable root claim commits before this callback can make its sole POST. */
export function createZoomConferenceWork(deps: ConferenceDeps, meetings: ZoomMeetingsClient) {
  return async (c: ConferenceWork, signal: AbortSignal): Promise<ConferenceResult> => {
    if (c.booking.status === 'cancelled' && !c.createStarted && !c.meetingId)
      return { cancelled: true }
    if (!deps.zoom || !c.connectionId || !c.externalUserId) return failure('needs_reauth', c)
    const zoom = deps.zoom,
      key = conferenceEncryptionKey(zoom.encryptionKey),
      operation = randomUUID()
    let attempted = false,
      discovered: ConferenceResult | undefined
    async function perform(db: Db, token: string): Promise<ConferenceResult> {
      try {
        const identity = await zoom.client.identity(token, signal)
        if (identity.id !== c.externalUserId) {
          await db
            .updateTable('conference_connections')
            .set({
              credentials: null,
              operation_id: null,
              status: 'needs_reauth',
              last_error: 'identity_mismatch',
            })
            .where('id', '=', c.connectionId as string)
            .execute()
          return failure('needs_reauth', c)
        }
        const input = {
          topic: Array.from(c.booking.title).slice(0, 200).join(''),
          start: c.booking.start_at,
          end: c.booking.end_at,
        }
        if (c.meetingId) {
          const existing = await meetings.get(
            token,
            c.externalUserId as string,
            c.meetingId,
            signal,
          )
          if (!existing)
            return c.booking.status === 'cancelled'
              ? { cancelled: true }
              : { error: 'conference_failed' }
          if (c.booking.status === 'cancelled') {
            await meetings.remove(token, c.externalUserId as string, c.meetingId, signal)
            return { cancelled: true }
          }
          if (
            existing.start === c.booking.start_at.toISOString() &&
            existing.duration ===
              (c.booking.end_at.getTime() - c.booking.start_at.getTime()) / 60000
          )
            return interpreted(existing, c)
          const updated = await meetings.update(
            token,
            c.externalUserId as string,
            c.meetingId,
            input,
            signal,
          )
          return updated ? interpreted(updated, c) : { error: 'conference_failed' }
        }
        // No list query, arbitrary ID adoption, marker or empty result can authorize POST.
        if (!c.create) return { error: 'ambiguous_create' }
        attempted = true
        const created = await meetings.create(token, c.externalUserId as string, input, signal)
        discovered = interpreted(created, c)
        return discovered
      } catch (error) {
        if (
          error instanceof ZoomError &&
          (error.code === 'needs_reauth' || error.code === 'permissions_missing')
        )
          await db
            .updateTable('conference_connections')
            .set({
              credentials: null,
              operation_id: null,
              status: 'needs_reauth',
              last_error: error.code,
            })
            .where('id', '=', c.connectionId as string)
            .execute()
        return failure(
          error instanceof ZoomError ? error.code : 'provider_unavailable',
          c,
          attempted && !(error instanceof ZoomError && error.knownNoCreate),
        )
      }
    }
    let rotation: { refresh: string; original: Buffer } | undefined
    try {
      const first = await connection(
        deps,
        c,
        async (db, r): Promise<ConferenceResult | undefined> => {
          if (r?.status === 'refreshing') return failure('provider_unavailable', c)
          if (
            r?.status !== 'active' ||
            !r.credentials ||
            r.mode !== 'meetings' ||
            r.external_user_id !== c.externalUserId ||
            !matchingZoomScopes(r.scopes, 'meetings')
          )
            return failure('needs_reauth', c)
          let tokens: ReturnType<typeof readTokens>
          try {
            tokens = readTokens(
              key,
              c.organizerUserId,
              r.id,
              c.externalUserId as string,
              r.credentials,
              'meetings',
            )
          } catch {
            await db
              .updateTable('conference_connections')
              .set({
                credentials: null,
                status: 'needs_reauth',
                operation_id: null,
                last_error: 'credentials_unavailable',
              })
              .where('id', '=', r.id)
              .execute()
            return failure('needs_reauth', c)
          }
          if (tokens.expiresAt > clock(deps) + 60000) return perform(db, tokens.accessToken)
          // Commit retirement before any call to a rotating refresh endpoint.
          await db
            .updateTable('conference_connections')
            .set({
              credentials: null,
              operation_id: operation,
              status: 'refreshing',
              last_error: null,
            })
            .where('id', '=', r.id)
            .execute()
          rotation = { refresh: tokens.refreshToken, original: r.credentials }
          return undefined
        },
      )
      if (first) return first
      const refresh = rotation?.refresh
      if (!refresh) return failure('needs_reauth', c)
      return await connection(deps, c, async (db, r) => {
        if (
          r?.status !== 'refreshing' ||
          r.operation_id !== operation ||
          r.mode !== 'meetings' ||
          r.external_user_id !== c.externalUserId
        )
          return failure('needs_reauth', c)
        let tokens: ZoomTokens | undefined,
          recoverable = false,
          error: string | null = null
        try {
          tokens = await refreshZoomTokens(
            () => zoom.client.refresh(refresh, signal, 'meetings'),
            signal,
          )
          if (!matchingZoomScopes(tokens.scopes, 'meetings')) {
            tokens = undefined
            throw new ZoomError('permissions_missing')
          }
        } catch (e) {
          error = e instanceof ZoomError ? e.code : 'provider_unavailable'
          recoverable = e instanceof ZoomError && e.code === 'provider_unavailable'
        }
        await db
          .updateTable('conference_connections')
          .set({
            credentials: tokens
              ? credentials(
                  key,
                  c.organizerUserId,
                  r.id,
                  c.externalUserId as string,
                  tokens,
                  'meetings',
                )
              : recoverable
                ? (rotation?.original ?? null)
                : null,
            status: tokens || recoverable ? 'active' : 'needs_reauth',
            operation_id: null,
            last_error: error,
            ...(tokens ? { scopes: tokens.scopes } : {}),
          })
          .where('id', '=', r.id)
          .execute()
        return tokens ? perform(db, tokens.accessToken) : failure(error ?? 'needs_reauth', c)
      })
    } catch {
      // A provider result can arrive before credential-transaction commit fails. Keep its
      // validated ID for reconciliation/cleanup, while withholding an unconfirmed ready URL.
      return discovered?.meetingId
        ? { meetingId: discovered.meetingId, error: 'provider_unavailable' }
        : failure('provider_unavailable', c, attempted)
    }
  }
}
