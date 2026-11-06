import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  groupFixture,
  insertRecord,
  insertSeat,
  occupiedSlot,
  transaction,
} from './group-seats-fixtures.ts'
import { receiptFixture, receiptProtections } from './group-seats-receipts.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('group operation receipt storage', () => {
  let owned: TestDatabase
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'group_receipts' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it.each(Object.keys(receiptProtections))('enforces %s', async (name) => {
    await receiptProtections[name]?.(await groupFixture(owned.pool))
    expect(owned.pool.totalCount).toBeLessThanOrEqual(2)
  })

  it('retains a valid source/successor receipt and a noop receipt after the later move', async () => {
    const f = await groupFixture(owned.pool)
    const { slot, booking, move } = await receiptFixture(f)
    const noop = await insertRecord(f.pool, 'group_booking_move_receipts', move)
    const target = { ...f, start: '2032-01-03T10:00Z', end: '2032-01-03T10:30Z' }
    const destination = await occupiedSlot(target)
    const successor = await transaction(f.pool, async (sql) => {
      await sql.query(
        `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
        [booking],
      )
      const successor = await insertSeat(sql, target, destination.slot, undefined, {
        rescheduled_from_id: booking,
      })
      await insertRecord(sql, 'group_booking_move_receipts', {
        ...move,
        request_key: 'real-move',
        result_booking_id: successor,
        result_group_slot_id: destination.slot,
        is_noop: false,
      })
      return successor
    })
    expect(
      (
        await f.pool.query(
          'SELECT result_booking_id,is_noop FROM group_booking_move_receipts WHERE id=$1',
          [noop],
        )
      ).rows,
    ).toEqual([{ result_booking_id: booking, is_noop: true }])
    expect(
      (
        await f.pool.query(
          `SELECT source_booking_id,result_booking_id,source_group_slot_id,result_group_slot_id FROM group_booking_move_receipts WHERE request_key='real-move' AND organization_id=$1`,
          [f.organization],
        )
      ).rows,
    ).toEqual([
      {
        source_booking_id: booking,
        result_booking_id: successor,
        source_group_slot_id: slot,
        result_group_slot_id: destination.slot,
      },
    ])
    await f.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.host])
    expect(
      (
        await f.pool.query(
          'SELECT count(*)::int AS n FROM group_booking_move_receipts WHERE organization_id=$1',
          [f.organization],
        )
      ).rows,
    ).toEqual([{ n: 2 }])
    await f.pool.query('DELETE FROM auth.organization WHERE id=$1', [f.organization])
    expect(
      (
        await f.pool.query('SELECT id FROM group_booking_move_receipts WHERE organization_id=$1', [
          f.organization,
        ])
      ).rows,
    ).toEqual([])
  })
})
