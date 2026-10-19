import { randomUUID } from 'node:crypto'
import type { Db } from '@hourmere/db'
import type { ConferenceResult, ConferenceWork } from '@hourmere/scheduling/conferences'
import { sql } from 'kysely'
import { conferenceEncryptionKey } from './credentials.ts'
import type { ConferenceDeps } from './index.ts'
import { type TokenOperation, tryTokenRetirement, withTokenOperation } from './token-operation.ts'
import { credentials, readTokens } from './tokens.ts'
import { matchingZoomScopes, refreshZoomTokens, ZoomError, type ZoomTokens } from './zoom.ts'
import type { ZoomMeeting, ZoomMeetingsClient } from './zoom-meetings.ts'

const clock = (deps: ConferenceDeps) => (deps.now ?? Date.now)()
/** Short owner/connection phases only; provider I/O never runs under their row locks. */
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
        .select(sql<string>`xmin::text`.as('revision'))
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
    type Grant = { access: string; revision: string }
    const active = (r: Awaited<ReturnType<typeof row>>) =>
      r?.status === 'active' &&
      !!r.credentials &&
      r.mode === 'meetings' &&
      r.external_user_id === c.externalUserId &&
      matchingZoomScopes(r.scopes, 'meetings')
    const current = (grant: Grant) =>
      connection(deps, c, async (_db, r) => active(r) && r?.revision === grant.revision)
    async function retire(grant: Grant, error: string) {
      await connection(deps, c, async (db, r) => {
        // A delayed rejection of old credentials must never retire a newer grant.
        if (!active(r) || r?.revision !== grant.revision) return
        if (!(await tryTokenRetirement(db, c.organizerUserId))) return
        await db
          .updateTable('conference_connections')
          .set({
            credentials: null,
            operation_id: null,
            status: 'needs_reauth',
            last_error: error,
          })
          .where('id', '=', c.connectionId as string)
          .execute()
      })
    }
    async function perform(grant: Grant): Promise<ConferenceResult> {
      if (!(await current(grant))) return failure('needs_reauth', c)
      const token = grant.access
      let result: ConferenceResult
      try {
        result = await request()
      } catch (error) {
        if (
          error instanceof ZoomError &&
          (error.code === 'needs_reauth' || error.code === 'permissions_missing')
        )
          await retire(grant, error.code)
        return failure(
          error instanceof ZoomError ? error.code : 'provider_unavailable',
          c,
          attempted && !(error instanceof ZoomError && error.knownNoCreate),
        )
      }
      // Keep a validated discovered ID for cleanup, but do not publish readiness after
      // disconnect, deletion or a credential/mode change during provider I/O.
      return (await current(grant))
        ? result
        : result.meetingId
          ? { meetingId: result.meetingId, error: 'needs_reauth' }
          : failure('needs_reauth', c)
      async function request(): Promise<ConferenceResult> {
        const identity = await zoom.client.identity(token, signal)
        if (identity.id !== c.externalUserId) {
          await retire(grant, 'identity_mismatch')
          return failure('needs_reauth', c)
        }
        if (!(await current(grant))) return failure('needs_reauth', c)
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
          if (!(await current(grant))) return failure('needs_reauth', c)
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
      }
    }
    async function sample(db: Db, r: Awaited<ReturnType<typeof row>>, lease?: TokenOperation) {
      if (r?.status === 'refreshing') {
        if (!lease) return failure('provider_unavailable', c)
        // A live token lease excludes every earlier refresh. Its cleared grant cannot
        // be recovered after a crash or a discarded late result; reconnect safely.
        await db
          .updateTable('conference_connections')
          .set({
            credentials: null,
            operation_id: null,
            status: 'needs_reauth',
            last_error: 'needs_reauth',
          })
          .where('id', '=', r.id)
          .execute()
        return failure('needs_reauth', c)
      }
      if (!active(r) || !r?.credentials) return failure('needs_reauth', c)
      try {
        return {
          tokens: readTokens(
            key,
            c.organizerUserId,
            r.id,
            c.externalUserId as string,
            r.credentials,
            'meetings',
          ),
          original: r.credentials,
          revision: r.revision,
        }
      } catch {
        // A callback may already be exchanging a new grant against this revision.
        if (!(await tryTokenRetirement(db, c.organizerUserId, lease)))
          return failure('needs_reauth', c)
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
    }
    try {
      // A refreshing row needs a lease check: the holder may still be working, or
      // its lease may have expired and left an abandoned credential-free claim.
      const first = await connection(deps, c, async (db, r) =>
        r?.status === 'refreshing' ? undefined : sample(db, r),
      )
      if (first && !('tokens' in first)) return first
      if (first && first.tokens.expiresAt > clock(deps) + 60000)
        return await perform({ access: first.tokens.accessToken, revision: first.revision })
      const refreshed = await withTokenOperation(
        deps.db,
        c.organizerUserId,
        async (db, lease) => {
          const scoped = { ...deps, db }
          const claim = await connection(scoped, c, async (db, r) => {
            // Waiting for another token operation may have produced a fresh grant.
            if (!(await lease.current(db))) return failure('provider_unavailable', c)
            const sampled = await sample(db, r, lease)
            if (!('tokens' in sampled)) return sampled
            if (sampled.tokens.expiresAt > clock(deps) + 60000)
              return { access: sampled.tokens.accessToken, revision: sampled.revision }
            // Commit retirement before any call to a rotating refresh endpoint.
            const claimed = await db
              .updateTable('conference_connections')
              .set({
                credentials: null,
                operation_id: operation,
                status: 'refreshing',
                last_error: null,
              })
              .where('id', '=', c.connectionId as string)
              .returning(sql<string>`xmin::text`.as('revision'))
              .executeTakeFirstOrThrow()
            return { ...sampled, revision: claimed.revision }
          })
          if (!('tokens' in claim)) return claim
          const ownsClaim = (r: Awaited<ReturnType<typeof row>>) =>
            r?.status === 'refreshing' &&
            r.operation_id === operation &&
            r.mode === 'meetings' &&
            r.external_user_id === c.externalUserId &&
            r.revision === claim.revision
          async function claimed(db: Db, r: Awaited<ReturnType<typeof row>>) {
            if (!(await lease.current(db))) return false
            if (ownsClaim(r)) return true
            // A changed revision invalidates storage, but a still-owned abandoned claim
            // must become terminal rather than leave booking retries waiting forever.
            if (r?.status === 'refreshing' && r.operation_id === operation)
              await db
                .updateTable('conference_connections')
                .set({
                  credentials: null,
                  operation_id: null,
                  status: 'needs_reauth',
                  last_error: 'needs_reauth',
                })
                .where('id', '=', c.connectionId as string)
                .execute()
            return false
          }
          if (!(await connection(scoped, c, claimed))) return failure('needs_reauth', c)
          let tokens: ZoomTokens | undefined,
            recoverable = false,
            error: string | null = null
          try {
            const refreshSignal = AbortSignal.any([signal, lease.signal])
            tokens = await refreshZoomTokens(
              () => zoom.client.refresh(claim.tokens.refreshToken, refreshSignal, 'meetings'),
              refreshSignal,
            )
            if (!matchingZoomScopes(tokens.scopes, 'meetings')) {
              tokens = undefined
              throw new ZoomError('permissions_missing')
            }
          } catch (e) {
            error = e instanceof ZoomError ? e.code : 'provider_unavailable'
            recoverable = e instanceof ZoomError && e.code === 'provider_unavailable'
          }
          return connection(scoped, c, async (db, r) => {
            if (!(await claimed(db, r))) return failure('needs_reauth', c)
            const stored = await db
              .updateTable('conference_connections')
              .set({
                credentials: tokens
                  ? credentials(
                      key,
                      c.organizerUserId,
                      c.connectionId as string,
                      c.externalUserId as string,
                      tokens,
                      'meetings',
                    )
                  : recoverable
                    ? claim.original
                    : null,
                status: tokens || recoverable ? 'active' : 'needs_reauth',
                operation_id: null,
                last_error: error,
                ...(tokens ? { scopes: tokens.scopes } : {}),
              })
              .where('id', '=', c.connectionId as string)
              .returning(sql<string>`xmin::text`.as('revision'))
              .executeTakeFirstOrThrow()
            return tokens
              ? { access: tokens.accessToken, revision: stored.revision }
              : failure(error ?? 'needs_reauth', c)
          })
        },
        async () => failure('provider_unavailable', c),
        deps.timeoutMs ?? 15000,
      )
      return 'access' in refreshed ? await perform(refreshed) : refreshed
    } catch {
      // A provider result can arrive before credential-transaction commit fails. Keep its
      // validated ID for reconciliation/cleanup, while withholding an unconfirmed ready URL.
      return discovered?.meetingId
        ? { meetingId: discovered.meetingId, error: 'provider_unavailable' }
        : failure('provider_unavailable', c, attempted)
    }
  }
}
