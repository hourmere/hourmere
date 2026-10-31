import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getPublicEventType, getPublicTeamEventType } from './availability.ts'
import {
  cancelManagedBooking,
  createPublicBooking,
  createPublicTeamBooking,
  getManagedBooking,
  rescheduleManagedBooking,
} from './bookings.ts'
import {
  createEventType,
  type EventTypeInput,
  getEventType,
  updateEventType,
} from './event-types.ts'
import { putProfile } from './profile.ts'
import { createSchedule } from './schedules.ts'
import type { SuccessRedirectInput } from './success-redirect.ts'
import { createTestTeam, createTestUser, testContext, weekdays } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2026-11-01T00:00:00Z')
const start = Temporal.Instant.from('2026-11-02T09:00Z')
const invitee = {
  name: 'Invitee & 東京',
  email: 'invitee+tag@example.com',
  timeZone: 'Europe/Berlin',
}

async function sourceCopy(mutate: (source: string) => string) {
  const location = new URL('./bookings.ts', import.meta.url)
  const original = readFileSync(location, 'utf8')
  const modified = mutate(original)
  expect(modified).not.toBe(original)
  const source = stripTypeScriptTypes(modified).replace(
    /from '([^']+)'/g,
    (_, specifier: string) =>
      `from '${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as Promise<
    typeof import('./bookings.ts')
  >
}

describe.skipIf(!serverUrl)('public booking success redirects', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  async function setup(successRedirect?: SuccessRedirectInput, teamPage = false) {
    const user = await createTestUser(db, 'Host & 東京')
    const personal = testContext(db, user.principal, now)
    const handle = `host-${randomUUID().slice(0, 8)}`
    await putProfile(personal, { handle, timeZone: 'UTC', locale: 'en' })
    await createSchedule(personal, {
      name: 'Hours',
      timeZone: 'UTC',
      weeklyHours: weekdays({ start: '09:00', end: '17:00' }),
    })
    const team = teamPage ? await createTestTeam(db, [{ user, role: 'owner' }]) : undefined
    const ctx = team ? testContext(db, team.as(user), now) : personal
    const event = await createEventType(ctx, {
      title: 'Call',
      slug: 'call',
      durationMinutes: 30,
      allowGuests: true,
      successRedirect,
      questions: [{ id: 'private-answer', type: 'short_text', label: 'Private answer' }],
    })
    const target = { handle: team ? ctx.principal.organization.slug : handle, slug: event.slug }
    const notify = vi.fn(async () => {})
    const pub = { db, now, notify }
    const book = (extra = {}, context = pub) =>
      (team ? createPublicTeamBooking : createPublicBooking)(context, {
        ...target,
        start,
        invitee,
        ...extra,
      })
    return { user, ctx, event, target, notify, pub, book }
  }
  it('keeps the ordinary confirmation when unset and ignores request targets', async () => {
    const s = await setup()
    const result = await s.book({
      redirectUrl: 'https://attacker.example',
      successRedirect: { url: 'https://attacker.example' },
    })
    expect(s.event.successRedirect).toBeNull()
    expect(result).not.toHaveProperty('successRedirect')
    expect(result.manageToken !== null).toBe(true)
    expect((await getManagedBooking(s.pub, result.manageToken as string)).id).toBe(
      result.booking.id,
    )
    expect(
      (
        await owned.pool.query('SELECT success_redirect FROM bookings WHERE id=$1', [
          result.booking.id,
        ])
      ).rows,
    ).toEqual([{ success_redirect: null }])
  })
  it.each([false, true])('uses only saved settings with safe defaults (team=%s)', async (team) => {
    const s = await setup(
      {
        url: 'https://target.example/thanks?campaign=existing#done',
        parameters: ['eventTypeSlug', 'start', 'end', 'timeZone', 'hostName'],
      },
      team,
    )
    expect(s.event.successRedirect).toMatchObject({
      includeInviteePersonalData: false,
      allowEmbedParent: false,
    })
    const page = await (team ? getPublicTeamEventType : getPublicEventType)(s.pub, s.target)
    expect(page).not.toHaveProperty('successRedirect')
    const result = await s.book({
      redirectUrl: 'https://attacker.example',
      successRedirect: { url: 'https://attacker.example' },
      guests: [{ name: 'Private Guest', email: 'private-guest@example.com' }],
      responses: { 'private-answer': 'Private response' },
    })
    const target = new URL(result.successRedirect?.url as string)
    expect(target.origin).toBe('https://target.example')
    expect(Object.fromEntries(target.searchParams)).toEqual({
      campaign: 'existing',
      eventTypeSlug: 'call',
      start: '2026-11-02T09:00:00.000Z',
      end: '2026-11-02T09:30:00.000Z',
      timeZone: 'Europe/Berlin',
      hostName: 'Host & 東京',
    })
    expect(target.hash).toBe('#done')
    expect(result.successRedirect?.allowEmbedParent).toBe(false)
    expect(result.booking).not.toHaveProperty('successRedirect')
    expect(target.searchParams.has('inviteeEmail')).toBe(false)
    expect(target.searchParams.has('inviteeName')).toBe(false)
    expect(s.notify).toHaveBeenCalledTimes(1)
  })
  it('validates configuration in both create and update services, then allows explicit personal data and parent opt-in', async () => {
    const s = await setup()
    const invalid = { url: 'https://target.example', parameters: ['inviteeEmail'] as const }
    await expect(
      createEventType(s.ctx, {
        title: 'Other',
        slug: 'other',
        durationMinutes: 30,
        successRedirect: invalid,
      } as unknown as EventTypeInput),
    ).rejects.toMatchObject({ code: 'invalid_success_redirect' })
    await expect(
      updateEventType(s.ctx, s.event.id, { successRedirect: invalid } as unknown as EventTypeInput),
    ).rejects.toMatchObject({ code: 'invalid_success_redirect' })
    await updateEventType(s.ctx, s.event.id, {
      successRedirect: {
        url: 'https://target.example',
        parameters: ['inviteeName', 'inviteeEmail'],
        includeInviteePersonalData: true,
        allowEmbedParent: true,
      },
    })
    expect((await getEventType(s.ctx, s.event.id)).successRedirect?.allowEmbedParent).toBe(true)
    const result = await s.book()
    expect(result.successRedirect?.allowEmbedParent).toBe(true)
    expect(Object.fromEntries(new URL(result.successRedirect?.url as string).searchParams)).toEqual(
      { inviteeName: invitee.name, inviteeEmail: invitee.email },
    )
    const changed = await updateEventType(s.ctx, s.event.id, { title: 'Renamed' })
    expect(changed.successRedirect?.parameters).toEqual(['inviteeName', 'inviteeEmail'])
    expect(
      (await updateEventType(s.ctx, s.event.id, { successRedirect: null })).successRedirect,
    ).toBeNull()
  })
  it('replays the immutable destination after event settings and host name change', async () => {
    const s = await setup({
      url: 'https://target.example/first',
      parameters: ['hostName', 'start'],
      allowEmbedParent: true,
    })
    const idempotencyKey = randomUUID()
    const first = await s.book({ idempotencyKey })
    await updateEventType(s.ctx, s.event.id, { successRedirect: null })
    await db
      .updateTable('auth.user')
      .set({ name: 'Changed Host' })
      .where('id', '=', s.user.id)
      .execute()
    const replay = await s.book({ idempotencyKey })
    expect(replay.replayed).toBe(true)
    expect(replay.successRedirect).toEqual(first.successRedirect)
    expect(replay.manageToken).toBeNull()
    expect(
      (
        await owned.pool.query('SELECT success_redirect FROM bookings WHERE id=$1', [
          first.booking.id,
        ])
      ).rows,
    ).toEqual([{ success_redirect: first.successRedirect }])
    expect(s.notify).toHaveBeenCalledTimes(1)
  })
  it('keeps an originally unset destination absent when replayed after enabling redirects', async () => {
    const s = await setup()
    const idempotencyKey = randomUUID()
    const first = await s.book({ idempotencyKey })
    await updateEventType(s.ctx, s.event.id, {
      successRedirect: { url: 'https://target.example/new' },
    })
    const replay = await s.book({ idempotencyKey })
    expect(first).not.toHaveProperty('successRedirect')
    expect(replay).not.toHaveProperty('successRedirect')
    expect(replay.replayed).toBe(true)
    expect(
      (
        await owned.pool.query('SELECT success_redirect FROM bookings WHERE id=$1', [
          first.booking.id,
        ])
      ).rows,
    ).toEqual([{ success_redirect: null }])
    expect(s.notify).toHaveBeenCalledTimes(1)
  })
  it.each(['api', 'mcp'] as const)(
    'omits a configured redirect from %s-origin creation and replay',
    async (source) => {
      const s = await setup({
        url: 'https://target.example',
        parameters: ['inviteeEmail'],
        includeInviteePersonalData: true,
        allowEmbedParent: true,
      })
      const input = { ...s.target, start, invitee, idempotencyKey: randomUUID() }
      const origin = { source, apiKeyId: null }
      const first = await createPublicBooking(s.pub, input, origin)
      const replay = await createPublicBooking(s.pub, input, origin)
      expect(first).not.toHaveProperty('successRedirect')
      expect(replay).not.toHaveProperty('successRedirect')
      expect(replay.replayed).toBe(true)
      expect(
        (
          await owned.pool.query('SELECT success_redirect FROM bookings WHERE id=$1', [
            first.booking.id,
          ])
        ).rows,
      ).toEqual([{ success_redirect: null }])
      expect(s.notify).toHaveBeenCalledTimes(1)
    },
  )
  it('returns the same snapshot through concurrent retry paths', async () => {
    const s = await setup({ url: 'https://target.example/first', parameters: ['hostName'] })
    const idempotencyKey = randomUUID()
    const results = await Promise.all(Array.from({ length: 4 }, () => s.book({ idempotencyKey })))
    expect(results.filter((result) => result.replayed)).toHaveLength(3)
    expect(new Set(results.map((result) => result.booking.id)).size).toBe(1)
    for (const result of results)
      expect(result.successRedirect).toEqual(results[0]?.successRedirect)
    expect(s.notify).toHaveBeenCalledTimes(1)
  })
  it('does not return redirects for manage, reschedule or cancel and stores no snapshot for the successor', async () => {
    const s = await setup({ url: 'https://target.example' })
    const first = await s.book()
    expect(await getManagedBooking(s.pub, first.manageToken as string)).not.toHaveProperty(
      'successRedirect',
    )
    const moved = await rescheduleManagedBooking(s.pub, first.manageToken as string, {
      start: start.add({ hours: 1 }),
    })
    expect(moved).not.toHaveProperty('successRedirect')
    expect(
      (
        await owned.pool.query('SELECT success_redirect FROM bookings WHERE id=$1', [
          moved.booking.id,
        ])
      ).rows,
    ).toEqual([{ success_redirect: null }])
    expect(await cancelManagedBooking(s.pub, moved.manageToken as string)).not.toHaveProperty(
      'successRedirect',
    )
  })
  it('creates no redirect or snapshot when booking fails', async () => {
    const s = await setup({ url: 'https://target.example' })
    await expect(s.book({ start: start.add({ hours: 20 }) })).rejects.toMatchObject({
      code: 'slot_unavailable',
    })
    expect(
      (await owned.pool.query('SELECT id FROM bookings WHERE event_type_id=$1', [s.event.id]))
        .rowCount,
    ).toBe(0)
    expect(s.notify).not.toHaveBeenCalled()
  })
  it.each(['locked', 'constraint'])(
    'preserves snapshots on the %s replay path and detects its removal',
    async (path) => {
      const s = await setup({ url: 'https://target.example/saved', parameters: ['start'] })
      const idempotencyKey = randomUUID()
      const first = await s.book({ idempotencyKey })
      const replayPath = (source: string) => {
        const skippedFastReplay = source.replace(
          'const replay = await findReplay(ctx.db, scope)',
          'const replay = undefined',
        )
        return path === 'locked'
          ? skippedFastReplay
          : skippedFastReplay.replace(
              'return await ctx.db.transaction().execute(async (trx) => {',
              "throw { code: '23505', constraint: 'bookings_idempotency' }; return await ctx.db.transaction().execute(async (trx) => {",
            )
      }
      const input = { ...s.target, start, invitee, idempotencyKey }
      const baseline = await sourceCopy(replayPath)
      const result = await baseline.createPublicBooking(s.pub, input)
      expect(result.replayed).toBe(true)
      expect(result.successRedirect).toEqual(first.successRedirect)
      const broken = await sourceCopy((source) =>
        replayPath(source).replace('...(row.success_redirect && {', '...(false && {'),
      )
      const badResult = await broken.createPublicBooking(s.pub, input)
      expect(() => expect(badResult.successRedirect).toEqual(first.successRedirect)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
      expect(s.notify).toHaveBeenCalledTimes(1)
    },
  )
  it('detects request-supplied redirect configuration in a source copy', async () => {
    const s = await setup({ url: 'https://target.example/saved' })
    const broken = await sourceCopy((source) =>
      source.replace(
        'validateSuccessRedirect(current.successRedirect, ctx.successRedirectPolicy)',
        'validateSuccessRedirect(input.successRedirect ?? current.successRedirect, ctx.successRedirectPolicy)',
      ),
    )
    const input = {
      ...s.target,
      start,
      invitee,
      successRedirect: { url: 'https://attacker.example' },
    }
    const bad = await broken.createPublicBooking(s.pub, input)
    expect(() =>
      expect(new URL(bad.successRedirect?.url as string).origin).toBe('https://target.example'),
    ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
  it('detects missing transactional snapshot storage in a source copy', async () => {
    const s = await setup({ url: 'https://target.example/saved' })
    const broken = await sourceCopy((source) =>
      source.replace(
        'success_redirect: b.successRedirect ? JSON.stringify(b.successRedirect) : null',
        'success_redirect: null',
      ),
    )
    const input = { ...s.target, start, invitee, idempotencyKey: randomUUID() }
    const first = await broken.createPublicBooking(s.pub, input)
    const replay = await broken.createPublicBooking(s.pub, input)
    expect(() => expect(replay.successRedirect).toEqual(first.successRedirect)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('rechecks saved settings after waiting for the host lock and detects a stale-settings source copy', async () => {
    const broken = await sourceCopy((source) =>
      source.replace(
        'validateSuccessRedirect(current.successRedirect, ctx.successRedirectPolicy)',
        'validateSuccessRedirect(et.successRedirect, ctx.successRedirectPolicy)',
      ),
    )
    async function waitingBooking(book: typeof createPublicBooking) {
      const s = await setup({ url: 'https://target.example/old' })
      const client = await owned.pool.connect()
      const key = `booking-host:${s.user.id}`
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key])
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
      const pending = book(s.pub, { ...s.target, start, invitee })
      pending.catch(() => {})
      try {
        for (let attempt = 0; attempt < 500; attempt++) {
          const { rowCount } = await owned.pool.query(
            'SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',
            [pid],
          )
          if (rowCount) break
          if (attempt === 499) throw new Error('booking did not wait for host lock')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        await updateEventType(s.ctx, s.event.id, {
          successRedirect: { url: 'https://target.example/current' },
        })
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key])
        client.release()
      }
      return pending
    }
    expect((await waitingBooking(createPublicBooking)).successRedirect?.url).toBe(
      'https://target.example/current',
    )
    const bad = await waitingBooking(broken.createPublicBooking)
    expect(() => expect(bad.successRedirect?.url).toBe('https://target.example/current')).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  }, 10_000)
})
