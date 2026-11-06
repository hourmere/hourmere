import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import {
  type GroupFixture,
  groupFixture,
  insertRecord,
  insertSeat,
  insertSlot,
  occupiedSlot,
  slotState,
  transaction,
} from './group-seats-fixtures.ts'

export const groupProtections: Record<string, (f: GroupFixture) => Promise<void>> = {
  configuration: async (f) => {
    for (const values of [
      { booking_mode: 'unknown' },
      { booking_mode: 'individual', group_capacity: 3 },
      { group_capacity: null },
      { group_capacity: 1 },
      { group_capacity: 101 },
      { scheduling_type: 'collective' },
      { scheduling_type: 'round_robin' },
      { allow_guests: true },
    ]) {
      const fields = Object.keys(values)
      await expect(
        f.pool.query(
          `UPDATE event_types SET ${fields.map((key, i) => `${key}=$${i + 1}`).join(',')} WHERE id=$${fields.length + 1}`,
          [...Object.values(values), f.event],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    }
  },
  'ECMAScript normalized mailboxes': async (f) => {
    const { slot } = await occupiedSlot(f)
    const whitespace =
      '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
    for (const character of whitespace)
      await expect(
        transaction(f.pool, (sql) =>
          insertSeat(sql, f, slot, 'normalized@example.test', {
            group_booker_key: `${character}normalized@example.test${character}`,
          }),
        ),
      ).rejects.toMatchObject({ code: '23514' })
    await transaction(f.pool, (sql) =>
      insertSeat(sql, f, slot, `${whitespace}Mixed@Example.Test${whitespace}`),
    )
    await expect(
      transaction(f.pool, (sql) => insertSeat(sql, f, slot, 'mixed@example.test')),
    ).rejects.toMatchObject({ code: '23505' })
  },
  'parent XOR': async (f) => {
    const { slot, bookings } = await occupiedSlot(f)
    for (const values of [
      { user_id: f.otherHost },
      { booking_id: bookings[0], group_slot_id: slot, user_id: f.otherHost },
    ])
      await expect(insertRecord(f.pool, 'booking_hosts', values)).rejects.toMatchObject({
        code: 'booking_id' in values ? '23514' : '23502',
      })
  },
  'derived occupancy': async (f) => {
    const { slot } = await occupiedSlot(f)
    await f.pool.query(
      `UPDATE booking_hosts SET active=false,period=tstzrange('2040-01-01','2040-01-02') WHERE group_slot_id=$1`,
      [slot],
    )
    const rows = (
      await f.pool.query(
        'SELECT active,lower(period) AS start,upper(period) AS end FROM booking_hosts WHERE group_slot_id=$1',
        [slot],
      )
    ).rows
    expect(rows).toEqual([{ active: true, start: new Date(f.start), end: new Date(f.end) }])
    await expect(
      transaction(f.pool, async (sql) => {
        const id = await insertRecord(sql, 'bookings', {
          organization_id: f.organization,
          start_at: f.start,
          end_at: f.end,
          source: 'web',
          title: 'Bypassed availability',
        })
        await sql.query('INSERT INTO booking_hosts(booking_id,user_id) VALUES ($1,$2)', [
          id,
          f.host,
        ])
      }),
    ).rejects.toMatchObject({ code: '23P01' })
  },
  'pinned host': async (f) => {
    await expect(
      transaction(f.pool, async (sql) => {
        const slot = await insertSlot(sql, f)
        await sql.query('INSERT INTO booking_hosts(group_slot_id,user_id) VALUES ($1,$2)', [
          slot,
          f.otherHost,
        ])
        await insertSeat(sql, f, slot)
      }),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'seat cannot own occupancy': async (f) => {
    const { bookings } = await occupiedSlot(f)
    await expect(
      f.pool.query('INSERT INTO booking_hosts(booking_id,user_id) VALUES ($1,$2)', [
        bookings[0],
        f.otherHost,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'seat binding': async (f) => {
    const { slot } = await occupiedSlot(f)
    const other = await groupFixture(f.pool)
    for (const values of [
      { organization_id: other.organization, event_type_id: other.event },
      { event_type_id: other.event },
      { start_at: '2032-01-02T10:01Z' },
      { end_at: '2032-01-02T11:00Z' },
      { required_host_user_ids: [f.otherHost] },
    ])
      await expect(
        transaction(f.pool, (sql) => insertSeat(sql, f, slot, undefined, values)),
      ).rejects.toMatchObject({ code: '23514' })
  },
  'immutable slot': async (f) => {
    const { slot } = await occupiedSlot(f)
    for (const values of [
      { host_user_id: f.otherHost },
      { original_event_type_id: randomUUID() },
      { start_at: '2032-01-02T10:01Z' },
      { end_at: '2032-01-02T10:31Z' },
      { capacity: 4 },
      { title: 'Rewritten title' },
      { location: { kind: 'link', url: 'https://example.test/changed' } },
    ]) {
      const fields = Object.keys(values)
      await expect(
        f.pool.query(
          `UPDATE group_slots SET ${fields.map((key, i) => `${key}=$${i + 1}`).join(',')} WHERE id=$${fields.length + 1}`,
          [...Object.values(values), slot],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    }
  },
  'immutable seat': async (f) => {
    const { bookings } = await occupiedSlot(f)
    const other = await groupFixture(f.pool)
    const target = await occupiedSlot(other)
    for (const values of [
      { group_slot_id: target.slot },
      { group_slot_id: null, group_booker_key: null },
      { group_booker_key: 'another@example.test' },
      { start_at: '2032-01-02T10:01Z' },
      { end_at: '2032-01-02T10:31Z' },
    ]) {
      const fields = Object.keys(values)
      await expect(
        f.pool.query(
          `UPDATE bookings SET ${fields.map((key, i) => `${key}=$${i + 1}`).join(',')} WHERE id=$${fields.length + 1}`,
          [...Object.values(values), bookings[0]],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    }
    await f.pool.query(
      `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
      [bookings[0]],
    )
    await expect(
      f.pool.query(`UPDATE bookings SET status='confirmed',cancelled_at=NULL WHERE id=$1`, [
        bookings[0],
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  },
  capacity: async (f) => {
    const { slot } = await occupiedSlot(f, 3)
    await expect(transaction(f.pool, (sql) => insertSeat(sql, f, slot))).rejects.toMatchObject({
      code: '23514',
    })
    expect(await slotState(f, slot)).toEqual({
      state: 'open',
      active_seats: 3,
      confirmed: 3,
      hosts: 1,
      active_hosts: 1,
    })
  },
  'counter ownership': async (f) => {
    const { slot } = await occupiedSlot(f)
    for (const value of [0, 2, -1, 4])
      await expect(
        f.pool.query('UPDATE group_slots SET active_seats=$1 WHERE id=$2', [value, slot]),
      ).rejects.toMatchObject({ code: '23514' })
    await expect(
      transaction(f.pool, (sql) =>
        insertSlot(sql, f, { active_seats: 1, start_at: '2033-01-01', end_at: '2033-01-02' }),
      ),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'booker shape': async (f) => {
    const { slot } = await occupiedSlot(f)
    for (const [overrides, attendee] of [
      [{ group_booker_key: 'UPPER@example.test' }, {}],
      [{ group_booker_key: ' spaced@example.test ' }, {}],
      [{ group_booker_key: null }, {}],
      [{ group_booker_key: '' }, {}],
      [{}, false],
      [{}, { is_booker: false }],
      [{}, { email: 'different@example.test' }],
    ] as const)
      await expect(
        transaction(f.pool, (sql) => insertSeat(sql, f, slot, undefined, overrides, attendee)),
      ).rejects.toMatchObject({ code: '23514' })
    const booker = (
      await f.pool.query<{ id: string }>(
        'SELECT a.id FROM booking_attendees a JOIN bookings b ON b.id=a.booking_id WHERE b.group_slot_id=$1',
        [slot],
      )
    ).rows[0]?.id
    await expect(
      f.pool.query('DELETE FROM booking_attendees WHERE id=$1', [booker]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      f.pool.query(`UPDATE booking_attendees SET email='changed@example.test' WHERE id=$1`, [
        booker,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'no guests': async (f) => {
    const { bookings } = await occupiedSlot(f)
    await expect(
      insertRecord(f.pool, 'booking_attendees', {
        booking_id: bookings[0],
        name: 'Guest',
        email: 'guest@example.test',
        time_zone: 'UTC',
        is_booker: false,
      }),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'mailbox uniqueness': async (f) => {
    const { slot, bookings } = await occupiedSlot(f)
    await transaction(f.pool, (sql) => insertSeat(sql, f, slot, ' Mixed.Case@Example.Test '))
    await expect(
      transaction(f.pool, (sql) => insertSeat(sql, f, slot, 'mixed.case@example.test')),
    ).rejects.toMatchObject({ code: '23505' })
    await f.pool.query(
      `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
      [bookings[0]],
    )
    const active = (
      await f.pool.query<{ id: string }>(
        `SELECT id FROM bookings WHERE group_slot_id=$1 AND status='confirmed'`,
        [slot],
      )
    ).rows[0]?.id
    await f.pool.query(
      `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
      [active],
    )
    expect((await slotState(f, slot))?.state).toBe('retired')
  },
  'surviving occupancy': async (f) => {
    await expect(
      transaction(f.pool, async (sql) => {
        const slot = await insertSlot(sql, f)
        await insertSeat(sql, f, slot)
      }),
    ).rejects.toMatchObject({ code: '23514' })
    const { slot } = await occupiedSlot(f)
    await expect(
      f.pool.query('DELETE FROM booking_hosts WHERE group_slot_id=$1', [slot]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      f.pool.query(`UPDATE group_slots SET state='retired' WHERE id=$1`, [slot]),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      f.pool.query(`UPDATE group_slots SET state='host_cancelled' WHERE id=$1`, [slot]),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'no empty open slot': async (f) => {
    await expect(transaction(f.pool, (sql) => insertSlot(sql, f))).rejects.toMatchObject({
      code: '23514',
    })
  },
  'confirmed seat deletion': async (f) => {
    const { bookings } = await occupiedSlot(f)
    await expect(
      f.pool.query('DELETE FROM bookings WHERE id=$1', [bookings[0]]),
    ).rejects.toMatchObject({ code: '23514' })
  },
}
