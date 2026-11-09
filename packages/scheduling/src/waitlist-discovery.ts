// Cache-only discovery. A candidate is a durable opportunity for a later sender, never a
// reservation. All recipients matching this pass enter the same cohort before dispatch.
import type { Db } from '@hourmere/db'
import { sql } from 'kysely'
import { listPublicSlots, listPublicTeamSlots } from './availability.ts'
import {
  ensureWaitlistKey,
  resolveWaitlistEvent,
  type WaitlistContext,
  waitlistNow,
} from './waitlist.ts'
import { WAITLIST_SLOT_RETENTION_DAYS } from './waitlist-policy.ts'

interface Entry {
  id: string
  recipient_hash: Buffer
  window_start: Date
  window_end: Date
  expires_at: Date
}

interface Work {
  dirty_generation: string
  cursor_start_at: Date | null
}

/** Resolve current handles from stable identity; renamed/hidden direct links still work. */
async function resolveById(db: Db, eventTypeId: string, lock = false) {
  const { rows } = await sql<{
    slug: string
    handle: string | null
    team_slug: string
    owner_user_id: string | null
  }>`SELECT et.slug, et.owner_user_id, p.handle, o.slug AS team_slug
      FROM event_types et JOIN auth.organization o ON o.id=et.organization_id
      LEFT JOIN profiles p ON p.user_id=et.owner_user_id
      WHERE et.id=${eventTypeId} ${lock ? sql`FOR SHARE OF et` : sql``}`.execute(db)
  const row = rows[0]
  if (!row) return undefined
  return resolveWaitlistEvent(
    db,
    {
      handle: row.owner_user_id ? (row.handle ?? '') : row.team_slug,
      slug: row.slug,
      team: !row.owner_user_id,
    },
    false,
  )
}

async function readEntries(db: Db, eventTypeId: string, at: Date, lock = false) {
  return (
    await sql<Entry>`SELECT id,recipient_hash,window_start,window_end,expires_at
      FROM waitlist_entries WHERE event_type_id=${eventTypeId}
      AND status IN ('active','notified') AND verified_at IS NOT NULL
      AND expires_at>${at} ORDER BY id ${lock ? sql`FOR UPDATE` : sql``}`.execute(db)
  ).rows
}

const PAGE_MS = 7 * 24 * 60 * 60 * 1000
// Signal batches select their locked IDs in an uncorrelated ARRAY(...) subquery, which
// PostgreSQL evaluates once per statement. An IN (...) subquery can be rescanned for each
// target row (e.g. with statistics taken while the table was empty), and every rescan
// skips rows this DELETE already removed, so one statement could exceed the limit.
const SIGNAL_LIMIT = 1000

/** Only scanners update work rows. Writers append independent, rollback-safe signals. */
async function consumeSignals(db: Db, eventTypeId: string, at: Date) {
  // Delete exactly the visible selected IDs, never an ID/time high-water mark: a
  // transaction can commit an older UUID after this batch has already finished.
  await sql`WITH consumed AS (
    DELETE FROM waitlist_scan_signals WHERE id = ANY(ARRAY(
      SELECT id FROM waitlist_scan_signals WHERE event_type_id=${eventTypeId}
      ORDER BY id LIMIT ${SIGNAL_LIMIT} FOR UPDATE SKIP LOCKED
    )) RETURNING id
  ) UPDATE waitlist_scan_work SET dirty_generation=dirty_generation+1,
      next_due_at=least(next_due_at,${at}),updated_at=${at}
    WHERE event_type_id=${eventTypeId} AND EXISTS(SELECT FROM consumed)`.execute(db)
}

async function hasSignals(db: Db, eventTypeId: string, snapshot: string) {
  return (
    await sql<{ pending: boolean }>`SELECT EXISTS(
      SELECT FROM waitlist_scan_signals WHERE event_type_id=${eventTypeId}
        AND writer_xid>=pg_snapshot_xmin(${snapshot}::pg_snapshot)
        AND NOT pg_visible_in_snapshot(writer_xid,${snapshot}::pg_snapshot)
    ) AS pending`.execute(db)
  ).rows[0]?.pending
}

/** One bounded range page, selecting every matching verified entry without ordering people. */
export async function scanWaitlistEvent(
  ctx: WaitlistContext,
  eventTypeId: string,
): Promise<number> {
  // Snapshot and consume a bounded signal batch under short event/work locks.
  // Availability computation holds no work, entry, host or event row locks.
  const snapshot = await ctx.db.transaction().execute(async (trx) => {
    await ensureWaitlistKey(trx, ctx.secret)
    const event = await resolveById(trx, eventTypeId, true)
    if (!event) return undefined
    await sql`INSERT INTO waitlist_scan_work(event_type_id) VALUES (${eventTypeId})
      ON CONFLICT (event_type_id) DO NOTHING`.execute(trx)
    await sql`SELECT event_type_id FROM waitlist_scan_work
      WHERE event_type_id=${eventTypeId} FOR UPDATE`.execute(trx)
    const at = await waitlistNow(trx, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
    await consumeSignals(trx, eventTypeId, at)
    // Existing backlog predates the availability reads and must not starve them.
    // Keep a transaction snapshot, not an ID/time watermark: an older writer can
    // commit during computation, including from a savepoint, and must invalidate it.
    const signalSnapshot = (
      await sql<{ snapshot: string }>`SELECT pg_current_snapshot()::text AS snapshot`.execute(trx)
    ).rows[0]?.snapshot
    if (!signalSnapshot) return undefined
    const work = (
      await sql<Work>`SELECT dirty_generation,cursor_start_at FROM waitlist_scan_work
        WHERE event_type_id=${eventTypeId}`.execute(trx)
    ).rows[0]
    if (!work) return undefined
    return { event, work, at, signalSnapshot, entries: await readEntries(trx, eventTypeId, at) }
  })
  if (!snapshot) return 0
  const { event: observedEvent, work: observedWork } = snapshot
  const observedNow = Temporal.Instant.fromEpochMilliseconds(snapshot.at.getTime())
  const page = await (async () => {
    const entries = snapshot.entries
    const now = observedNow
    const event = observedEvent
    const work = observedWork
    // Merge overlapping consent windows and skip gaps. A seven-day page plus one duration
    // of overlap stays below 20,000 starts even at a one-minute step. The overlap allows
    // complete slots crossing a page boundary; ownership is by their UTC start.
    const windows = entries
      .map((entry) => ({
        start: Math.max(entry.window_start.getTime(), now.epochMilliseconds),
        end: entry.window_end.getTime(),
      }))
      .filter((window) => window.start < window.end)
      .sort((a, b) => a.start - b.start)
    const merged: { start: number; end: number }[] = []
    for (const window of windows) {
      const previous = merged.at(-1)
      if (previous && window.start <= previous.end)
        previous.end = Math.max(previous.end, window.end)
      else merged.push({ ...window })
    }
    const cursor = work.cursor_start_at?.getTime() ?? 0
    const window = merged.find((range) => range.end > cursor) ?? merged[0]
    if (!window) return undefined
    const startMs = cursor >= window.start && cursor < window.end ? cursor : window.start
    const pageEndMs = Math.min(startMs + PAGE_MS, window.end)
    const endMs = Math.min(pageEndMs + event.durationMinutes * 60_000, window.end)
    const rangeStart = Temporal.Instant.fromEpochMilliseconds(startMs)
    const rangeEnd = Temporal.Instant.fromEpochMilliseconds(endMs)
    // An error leaves observations, cursor and tombstones untouched.
    const offered = (
      await (event.team ? listPublicTeamSlots : listPublicSlots)(
        { ...ctx, now: () => now },
        {
          handle: event.team?.slug ?? event.handle,
          slug: event.slug,
          start: rangeStart,
          end: rangeEnd,
        },
      )
    ).filter((slot) => Date.parse(slot.start) < pageEndMs)
    const nextWindow = merged.find((range) => range.start >= window.end)
    const nextCursor = pageEndMs < window.end ? pageEndMs : (nextWindow?.start ?? null)
    return { slots: offered, startMs, pageEndMs, nextCursor }
  })()

  return ctx.db.transaction().execute(async (trx) => {
    await ensureWaitlistKey(trx, ctx.secret)
    // Publication never takes host or booking locks. Its event -> work -> entry order
    // matches configuration writers. Dirty signals never acquire these row locks.
    // Nothing after these locks waits for or computes ordinary availability.
    const event = await resolveById(trx, eventTypeId, true)
    if (!event) return 0
    const work = (
      await sql<Work>`SELECT dirty_generation,cursor_start_at FROM waitlist_scan_work
        WHERE event_type_id=${eventTypeId} FOR UPDATE`.execute(trx)
    ).rows[0]
    if (
      !work ||
      String(work.dirty_generation) !== String(observedWork.dirty_generation) ||
      work.cursor_start_at?.getTime() !== observedWork.cursor_start_at?.getTime() ||
      (await hasSignals(trx, eventTypeId, snapshot.signalSnapshot))
    )
      return 0
    const beforeEntries = await waitlistNow(
      trx,
      ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined,
    )
    const lockedEntries = await readEntries(trx, eventTypeId, beforeEntries, true)
    // Removal/attribution serialize with publication. Sample time after their locks;
    // erased, expired or unverified entries cannot acquire fresh unsent work.
    const at = await waitlistNow(trx, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
    const now = Temporal.Instant.fromEpochMilliseconds(at.getTime())
    const entries = lockedEntries.filter((entry) => entry.expires_at.getTime() > at.getTime())
    if (!entries.length || !page) {
      await finishScan(trx, eventTypeId, work.dirty_generation, at, null)
      return 0
    }
    const { slots, startMs, pageEndMs, nextCursor } = page

    await sql`UPDATE waitlist_slots SET is_open=false, observed_at=${at}
      WHERE event_type_id=${eventTypeId} AND start_at>=${new Date(startMs)}
      AND start_at<${new Date(pageEndMs)} AND is_open=true
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(slots)}::jsonb)
        AS offered(start timestamptz,"end" timestamptz)
        WHERE offered.start=waitlist_slots.start_at AND offered."end"=waitlist_slots.end_at)`.execute(
      trx,
    )
    if (slots.length) {
      await sql`INSERT INTO waitlist_slots(event_type_id,start_at,end_at,is_open,generation,observed_at)
        SELECT ${eventTypeId}::uuid,offered.start,offered."end",true,1,${at}::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(slots)}::jsonb)
          AS offered(start timestamptz,"end" timestamptz)
        ON CONFLICT(event_type_id,start_at,end_at) DO UPDATE SET is_open=true,
          generation=waitlist_slots.generation + CASE WHEN waitlist_slots.is_open THEN 0 ELSE 1 END,
          observed_at=excluded.observed_at`.execute(trx)
    }

    let cohortId: string | undefined
    let count = 0
    for (const entry of entries) {
      // One indexed read per recipient replaces one round trip for every consumed start.
      // Even a dense page with all 10,080 starts consumed stays bounded to a few hundred
      // statements for the event's maximum 100 entries.
      const consumed = new Set(
        (
          await sql<{ start_at: Date; end_at: Date }>`
        SELECT start_at,end_at FROM waitlist_slot_tombstones
        WHERE event_type_id=${eventTypeId} AND recipient_hash=${entry.recipient_hash}
          AND start_at>=${new Date(startMs)} AND start_at<${new Date(pageEndMs)}`.execute(trx)
        ).rows.map((slot) => `${slot.start_at.getTime()}/${slot.end_at.getTime()}`),
      )
      // The cap is on suggestions per recipient, not on cohort membership.
      const selected: { start: string; end: string }[] = []
      for (const slot of slots) {
        const slotStart = Date.parse(slot.start)
        const slotEnd = Date.parse(slot.end)
        if (slotStart < entry.window_start.getTime() || slotEnd > entry.window_end.getTime())
          continue
        const deadline = Math.min(
          now.epochMilliseconds + 86_400_000,
          entry.expires_at.getTime(),
          slotStart - event.minimumNoticeMinutes * 60_000,
        )
        if (deadline <= now.epochMilliseconds) continue
        const inserted = consumed.has(`${slotStart}/${slotEnd}`)
          ? { rows: [] }
          : await sql`INSERT INTO waitlist_slot_tombstones
          (event_type_id,recipient_hash,start_at,end_at,purge_at)
          VALUES (${eventTypeId},${entry.recipient_hash},${slot.start}::timestamptz,
            ${slot.end}::timestamptz,${new Date(slotEnd + WAITLIST_SLOT_RETENTION_DAYS * 86_400_000)})
          ON CONFLICT DO NOTHING RETURNING event_type_id`.execute(trx)
        if (!inserted.rows.length) continue
        selected.push(slot)
        if (selected.length === 3) break
      }
      if (!selected.length) continue
      if (!cohortId) {
        cohortId = (
          await sql<{ id: string }>`INSERT INTO waitlist_cohorts(event_type_id,discovered_at)
            VALUES (${eventTypeId},${at}) RETURNING id`.execute(trx)
        ).rows[0]?.id
      }
      const expiresAt = new Date(
        Math.min(
          now.epochMilliseconds + 86_400_000,
          entry.expires_at.getTime(),
          Date.parse(selected[0]?.start ?? '') - event.minimumNoticeMinutes * 60_000,
        ),
      )
      await sql`INSERT INTO waitlist_candidates
        (cohort_id,entry_id,event_type_id,slots,due_at,expires_at,next_attempt_at)
        VALUES (${cohortId},${entry.id},${eventTypeId},${JSON.stringify(selected)}::jsonb,
          ${at},${expiresAt},${at})`.execute(trx)
      count++
    }
    await finishScan(
      trx,
      eventTypeId,
      work.dirty_generation,
      at,
      nextCursor === null ? null : new Date(nextCursor),
    )
    return count
  })
}

async function finishScan(
  db: Db,
  eventTypeId: string,
  generation: string,
  at: Date,
  cursor: Date | null,
) {
  await sql`UPDATE waitlist_scan_work SET scanned_generation=${generation},
    cursor_start_at=${cursor},last_scanned_at=${at},updated_at=${at},
    next_due_at=${new Date(at.getTime() + 60_000)} WHERE event_type_id=${eventTypeId}`.execute(db)
}

/** Drain irrelevant signals in short batches, yielding to event scans after five seconds. */
export async function cleanupWaitlistSignals(
  ctx: WaitlistContext,
  options: { timeBudgetMs?: number; now?: () => number } = {},
) {
  const now = options.now ?? (() => performance.now())
  const deadline = now() + Math.max(0, Math.min(5000, options.timeBudgetMs ?? 5000))
  let removed = 0
  while (true) {
    const remaining = Math.floor(deadline - now())
    if (remaining <= 0) break
    let count: number
    try {
      count = await ctx.db.transaction().execute(async (trx) => {
        // Bound the current batch as well as the number of batches begun. A timeout
        // rolls back only this batch; committed progress survives for the next run.
        await sql`SELECT set_config('statement_timeout',${String(remaining)},true)`.execute(trx)
        const at = await waitlistNow(
          trx,
          ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined,
        )
        const { rows } = await sql<{ count: number }>`WITH discarded AS (
          DELETE FROM waitlist_scan_signals WHERE id = ANY(ARRAY(
            SELECT s.id FROM waitlist_scan_signals s
            WHERE NOT EXISTS(SELECT FROM event_types et
              WHERE et.id=s.event_type_id AND et.waitlist_enabled AND et.is_active
                AND et.deleted_at IS NULL AND EXISTS(SELECT FROM waitlist_entries e
                  WHERE e.event_type_id=et.id AND e.status IN ('active','notified')
                    AND e.verified_at IS NOT NULL AND e.expires_at>${at}))
            ORDER BY s.id LIMIT ${SIGNAL_LIMIT} FOR UPDATE OF s SKIP LOCKED
          )) RETURNING id
        ) SELECT count(*)::int AS count FROM discarded`.execute(trx)
        return rows[0]?.count ?? 0
      })
    } catch (error) {
      if ((error as { code?: string }).code === '57014') break
      throw error
    }
    removed += count
    if (count < SIGNAL_LIMIT) break
  }
  return removed
}

/** Fair restart/minute recovery also discovers entries whose dirty job was lost. */
export async function scanWaitlists(ctx: WaitlistContext, options: { limit?: number } = {}) {
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)))
  await ctx.db.transaction().execute(async (trx) => {
    await ensureWaitlistKey(trx, ctx.secret)
    const recoveredAt = await waitlistNow(
      trx,
      ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined,
    )
    await sql`INSERT INTO waitlist_scan_work(event_type_id,next_due_at)
      SELECT DISTINCT e.event_type_id,${recoveredAt}::timestamptz FROM waitlist_entries e
      JOIN event_types et ON et.id=e.event_type_id
      WHERE et.waitlist_enabled AND e.status IN ('active','notified')
      ON CONFLICT DO NOTHING`.execute(trx)
  })
  await cleanupWaitlistSignals(ctx)
  const at = await waitlistNow(ctx.db, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
  const now = Temporal.Instant.fromEpochMilliseconds(at.getTime())
  const events = (
    await sql<{ event_type_id: string }>`SELECT w.event_type_id FROM waitlist_scan_work w
      JOIN event_types et ON et.id=w.event_type_id
      WHERE et.waitlist_enabled AND et.is_active AND et.deleted_at IS NULL
      AND (w.next_due_at<=${new Date(now.epochMilliseconds)}
        OR EXISTS(SELECT FROM waitlist_scan_signals s WHERE s.event_type_id=w.event_type_id))
      AND EXISTS(SELECT FROM waitlist_entries e WHERE e.event_type_id=w.event_type_id
        AND e.status IN ('active','notified') AND e.expires_at>${new Date(now.epochMilliseconds)})
      ORDER BY w.next_due_at,w.event_type_id LIMIT ${limit}`.execute(ctx.db)
  ).rows
  let candidates = 0
  let errors = 0
  for (const event of events) {
    try {
      candidates += await scanWaitlistEvent(ctx, event.event_type_id)
    } catch {
      // Preserve the failed observation but move its next attempt behind this batch,
      // preventing a permanently stale calendar from starving other events.
      errors++
      await sql`UPDATE waitlist_scan_work SET next_due_at=${new Date(now.epochMilliseconds + 60_000)}
        WHERE event_type_id=${event.event_type_id}`.execute(ctx.db)
    }
  }
  return { events: events.length, candidates, errors }
}
