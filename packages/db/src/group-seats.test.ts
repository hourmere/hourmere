// These tests bypass service availability and exercise real COMMIT-time invariants.
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  groupFixture,
  insertRecord,
  insertSeat,
  occupiedSlot,
  slotState,
  transaction,
} from './group-seats-fixtures.ts'
import { groupProtections } from './group-seats-protections.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('group seat storage invariants', () => {
  let owned: TestDatabase
  let pool: pg.Pool
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'group_guards' })
    pool = owned.pool
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it.each(Object.keys(groupProtections))('enforces %s with direct SQL', async (name) => {
    await groupProtections[name]?.(await groupFixture(pool))
    expect(pool.totalCount).toBeLessThanOrEqual(2)
  })

  it('requires seat binding when an ordinary row changes event, time or confirmed state into group mode', async () => {
    const f = await groupFixture(pool)
    const ordinary = await insertRecord(pool, 'bookings', {
      organization_id: f.organization,
      start_at: f.start,
      end_at: f.end,
      title: 'Ordinary',
      source: 'web',
    })
    await expect(
      pool.query('UPDATE bookings SET event_type_id=$1 WHERE id=$2', [f.event, ordinary]),
    ).rejects.toMatchObject({ code: '23514' })
    const historicalEvent = await insertRecord(pool, 'event_types', {
      organization_id: f.organization,
      slug: 'historical',
      title: 'Historical event',
      duration_minutes: 30,
    })
    const historical = await insertRecord(pool, 'bookings', {
      organization_id: f.organization,
      event_type_id: historicalEvent,
      start_at: '2000-01-01T10:00Z',
      end_at: '2000-01-01T10:30Z',
      title: 'Historical',
      source: 'web',
    })
    await pool.query(`UPDATE event_types SET booking_mode='group',group_capacity=3 WHERE id=$1`, [
      historicalEvent,
    ])
    await pool.query(`UPDATE bookings SET title='Retained history' WHERE id=$1`, [historical])
    await expect(
      pool.query('UPDATE bookings SET start_at=$1,end_at=$2 WHERE id=$3', [
        f.start,
        f.end,
        historical,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
    await pool.query(
      `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
      [historical],
    )
    await expect(
      pool.query(`UPDATE bookings SET status='confirmed',cancelled_at=NULL WHERE id=$1`, [
        historical,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
    expect(
      (await pool.query('SELECT title,status FROM bookings WHERE id=$1', [historical])).rows,
    ).toEqual([{ title: 'Retained history', status: 'cancelled' }])
  })

  it('shares one occupancy, cancels one seat independently, retires the last and never resurrects its generation', async () => {
    const f = await groupFixture(pool)
    const { slot, bookings } = await occupiedSlot(f, 2)
    expect(await slotState(f, slot)).toEqual({
      state: 'open',
      active_seats: 2,
      confirmed: 2,
      hosts: 1,
      active_hosts: 1,
    })
    await pool.query(
      `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
      [bookings[0]],
    )
    expect(await slotState(f, slot)).toEqual({
      state: 'open',
      active_seats: 1,
      confirmed: 1,
      hosts: 1,
      active_hosts: 1,
    })
    await pool.query(
      `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
      [bookings[1]],
    )
    expect(await slotState(f, slot)).toEqual({
      state: 'retired',
      active_seats: 0,
      confirmed: 0,
      hosts: 1,
      active_hosts: 0,
    })
    await expect(transaction(pool, (sql) => insertSeat(sql, f, slot))).rejects.toMatchObject({
      code: '23514',
    })
    await expect(
      pool.query(`UPDATE group_slots SET state='open' WHERE id=$1`, [slot]),
    ).rejects.toMatchObject({ code: '23514' })
    const next = await occupiedSlot(f)
    expect(next.slot).not.toBe(slot)
    expect((await slotState(f, next.slot))?.active_seats).toBe(1)
  })

  it('releases a cancelled mailbox while another seat keeps the same slot open', async () => {
    const f = await groupFixture(pool)
    const { slot } = await occupiedSlot(f)
    const id = await transaction(pool, (sql) => insertSeat(sql, f, slot, 'same@example.test'))
    await pool.query(
      `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
      [id],
    )
    await transaction(pool, (sql) => insertSeat(sql, f, slot, ' SAME@example.test '))
    expect((await slotState(f, slot))?.active_seats).toBe(2)
  })

  it('rejects overlapping normal, collective, round-robin and other group occupancy across organizations', async () => {
    const f = await groupFixture(pool)
    await occupiedSlot(f)
    const other = await groupFixture(pool)
    other.host = f.host
    for (const scheduling of ['individual', 'collective', 'round_robin']) {
      const event = await insertRecord(pool, 'event_types', {
        organization_id: other.organization,
        slug: scheduling.replace('_', '-'),
        title: scheduling,
        duration_minutes: 30,
        scheduling_type: scheduling,
      })
      await expect(
        transaction(pool, async (sql) => {
          const booking = await insertRecord(sql, 'bookings', {
            organization_id: other.organization,
            event_type_id: event,
            start_at: f.start,
            end_at: f.end,
            title: scheduling,
            source: 'api',
          })
          if (scheduling === 'collective')
            await sql.query('INSERT INTO booking_hosts(booking_id,user_id) VALUES ($1,$2)', [
              booking,
              other.otherHost,
            ])
          await sql.query('INSERT INTO booking_hosts(booking_id,user_id) VALUES ($1,$2)', [
            booking,
            f.host,
          ])
        }),
      ).rejects.toMatchObject({ code: '23P01', constraint: 'booking_hosts_no_overlap' })
    }
    await expect(occupiedSlot(other)).rejects.toMatchObject({ code: '23P01' })
    other.end = '2032-01-02T11:00Z'
    await expect(occupiedSlot(other)).rejects.toMatchObject({ code: '23P01' })
    other.start = f.end
    other.end = '2032-01-02T11:00Z'
    await occupiedSlot(other)
  })

  it('physical event deletion preserves seats and snapshots, detaches live associations and stops admission', async () => {
    const f = await groupFixture(pool)
    const { slot, bookings } = await occupiedSlot(f, 2)
    const before = (
      await pool.query(
        `SELECT to_jsonb(b)-'event_type_id'-'updated_at' AS value FROM bookings b WHERE group_slot_id=$1 ORDER BY id`,
        [slot],
      )
    ).rows
    await pool.query('DELETE FROM event_types WHERE id=$1', [f.event])
    expect(
      (
        await pool.query(
          `SELECT to_jsonb(b)-'event_type_id'-'updated_at' AS value FROM bookings b WHERE group_slot_id=$1 ORDER BY id`,
          [slot],
        )
      ).rows,
    ).toEqual(before)
    expect(
      (
        await pool.query(
          'SELECT event_type_id,original_event_type_id,host_user_id,start_at,end_at FROM group_slots WHERE id=$1',
          [slot],
        )
      ).rows,
    ).toEqual([
      {
        event_type_id: null,
        original_event_type_id: f.event,
        host_user_id: f.host,
        start_at: new Date(f.start),
        end_at: new Date(f.end),
      },
    ])
    expect(
      (await pool.query('SELECT event_type_id FROM bookings WHERE group_slot_id=$1', [slot])).rows,
    ).toEqual([{ event_type_id: null }, { event_type_id: null }])
    await expect(
      transaction(pool, (sql) => insertSeat(sql, f, slot, undefined, { event_type_id: null })),
    ).rejects.toMatchObject({ code: '23514' })
    await pool.query(
      `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
      [bookings[0]],
    )
    expect((await slotState(f, slot))?.active_seats).toBe(1)
  })

  it('host deletion preserves team seats and immutable identity while allowing later cancellation', async () => {
    const f = await groupFixture(pool)
    const { slot, bookings } = await occupiedSlot(f)
    await pool.query('DELETE FROM auth."user" WHERE id=$1', [f.host])
    expect(await slotState(f, slot)).toEqual({
      state: 'open',
      active_seats: 1,
      confirmed: 1,
      hosts: 0,
      active_hosts: 0,
    })
    expect(
      (await pool.query('SELECT host_user_id FROM group_slots WHERE id=$1', [slot])).rows,
    ).toEqual([{ host_user_id: f.host }])
    await expect(transaction(pool, (sql) => insertSeat(sql, f, slot))).rejects.toMatchObject({
      code: '23514',
    })
    await pool.query(
      `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
      [bookings[0]],
    )
    expect((await slotState(f, slot))?.state).toBe('retired')
  })

  it('organization deletion cascades all owned slots, seats, hosts and attendees', async () => {
    const f = await groupFixture(pool)
    const { slot, bookings } = await occupiedSlot(f, 2)
    await pool.query('DELETE FROM auth.organization WHERE id=$1', [f.organization])
    expect((await pool.query('SELECT id FROM group_slots WHERE id=$1', [slot])).rows).toEqual([])
    expect(
      (await pool.query('SELECT id FROM bookings WHERE id=ANY($1::uuid[])', [bookings])).rows,
    ).toEqual([])
    expect(
      (await pool.query('SELECT id FROM booking_hosts WHERE group_slot_id=$1', [slot])).rows,
    ).toEqual([])
    expect(
      (
        await pool.query('SELECT id FROM booking_attendees WHERE booking_id=ANY($1::uuid[])', [
          bookings,
        ])
      ).rows,
    ).toEqual([])
  })
})
