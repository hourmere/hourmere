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

interface Entry {
  id: string
  recipient_hash: Buffer
  window_start: Date
  window_end: Date
  expires_at: Date
}

interface Work {
  dirty_generation: number
  cursor_start_at: Date | null
}

/** Resolve current handles from stable identity; renamed/hidden direct links still work. */
async function resolveById(db: Db, eventTypeId: string) {
  const { rows } = await sql<{
    slug: string
    handle: string | null
    team_slug: string
    owner_user_id: string | null
  }>`SELECT et.slug, et.owner_user_id, p.handle, o.slug AS team_slug
      FROM event_types et JOIN auth.organization o ON o.id=et.organization_id
      LEFT JOIN profiles p ON p.user_id=et.owner_user_id
      WHERE et.id=${eventTypeId} FOR SHARE OF et`.execute(db)
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

const PAGE_MS = 7 * 24 * 60 * 60 * 1000

/** One bounded range page, selecting every matching verified entry without ordering people. */
export async function scanWaitlistEvent(
  ctx: WaitlistContext,
  eventTypeId: string,
): Promise<number> {
  return ctx.db.transaction().execute(async (trx) => {
    await ensureWaitlistKey(trx, ctx.secret)
    // Event before work: configuration writers take these in this order too. No host or
    // booking lock is taken and no provider or SMTP request occurs during discovery.
    const event = await resolveById(trx, eventTypeId)
    if (!event) return 0
    await sql`INSERT INTO waitlist_scan_work(event_type_id) VALUES (${eventTypeId})
      ON CONFLICT (event_type_id) DO NOTHING`.execute(trx)
    const work = (
      await sql<Work>`SELECT dirty_generation,cursor_start_at FROM waitlist_scan_work
        WHERE event_type_id=${eventTypeId} FOR UPDATE`.execute(trx)
    ).rows[0]
    if (!work) return 0
    const beforeEntries = await waitlistNow(
      trx,
      ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined,
    )
    const lockedEntries = (
      await sql<Entry>`SELECT id,recipient_hash,window_start,window_end,expires_at
        FROM waitlist_entries WHERE event_type_id=${eventTypeId}
        AND status IN ('active','notified') AND verified_at IS NOT NULL
        AND expires_at>${beforeEntries} ORDER BY id FOR UPDATE`.execute(trx)
    ).rows
    // Serialize self-removal/attribution with cohort creation, then sample wall time again
    // after those locks. A removed entry cannot acquire fresh unsent work behind erasure.
    const at = await waitlistNow(trx, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
    const now = Temporal.Instant.fromEpochMilliseconds(at.getTime())
    const entries = lockedEntries.filter((entry) => entry.expires_at.getTime() > at.getTime())
    if (!entries.length) {
      await finishScan(trx, eventTypeId, work.dirty_generation, at, null)
      return 0
    }

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
    if (!window) {
      await finishScan(trx, eventTypeId, work.dirty_generation, at, null)
      return 0
    }
    const startMs = cursor >= window.start && cursor < window.end ? cursor : window.start
    const pageEndMs = Math.min(startMs + PAGE_MS, window.end)
    const endMs = Math.min(pageEndMs + event.durationMinutes * 60_000, window.end)
    const rangeStart = Temporal.Instant.fromEpochMilliseconds(startMs)
    const rangeEnd = Temporal.Instant.fromEpochMilliseconds(endMs)
    // An error aborts this transaction, preserving observations, cursor and tombstones.
    const offered = (
      await (event.team ? listPublicTeamSlots : listPublicSlots)(
        { ...ctx, db: trx, now: () => now },
        {
          handle: event.team?.slug ?? event.handle,
          slug: event.slug,
          start: rangeStart,
          end: rangeEnd,
        },
      )
    ).filter((slot) => Date.parse(slot.start) < pageEndMs)
    const slots = offered

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
            ${slot.end}::timestamptz,${new Date(slotEnd + 172_800_000)})
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
    const nextWindow = merged.find((range) => range.start >= window.end)
    const nextCursor = pageEndMs < window.end ? pageEndMs : (nextWindow?.start ?? null)
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
  generation: number,
  at: Date,
  cursor: Date | null,
) {
  await sql`UPDATE waitlist_scan_work SET scanned_generation=${generation},
    cursor_start_at=${cursor},last_scanned_at=${at},updated_at=${at},
    next_due_at=${new Date(at.getTime() + 60_000)} WHERE event_type_id=${eventTypeId}`.execute(db)
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
  const at = await waitlistNow(ctx.db, ctx.now ? new Date(ctx.now().epochMilliseconds) : undefined)
  const now = Temporal.Instant.fromEpochMilliseconds(at.getTime())
  const events = (
    await sql<{ event_type_id: string }>`SELECT w.event_type_id FROM waitlist_scan_work w
      JOIN event_types et ON et.id=w.event_type_id
      WHERE et.waitlist_enabled AND et.is_active AND et.deleted_at IS NULL
      AND w.next_due_at<=${new Date(now.epochMilliseconds)}
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
