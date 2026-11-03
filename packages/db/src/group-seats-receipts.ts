import { createHash, randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import {
  type GroupFixture,
  groupFixture,
  insertRecord,
  occupiedSlot,
  transaction,
} from './group-seats-fixtures.ts'

const digest = createHash('sha256').update('synthetic receipt authority').digest()

export async function receiptFixture(f: GroupFixture) {
  const { slot, bookings } = await occupiedSlot(f)
  const booking = bookings[0] as string
  const move = {
    organization_id: f.organization,
    authority_kind: 'capability',
    authority_hash: digest,
    request_key: 'receipt-key',
    fingerprint: digest,
    source_booking_id: booking,
    result_booking_id: booking,
    source_group_slot_id: slot,
    result_group_slot_id: slot,
    is_noop: true,
  }
  return { slot, booking, move }
}

export async function cancelledReceiptFixture(f: GroupFixture) {
  const fixture = await receiptFixture(f)
  await transaction(f.pool, async (sql) => {
    await sql.query(`UPDATE group_slots SET state='host_cancelled' WHERE id=$1`, [fixture.slot])
    await sql.query(
      `UPDATE bookings SET status='cancelled',cancelled_at=clock_timestamp() WHERE id=$1`,
      [fixture.booking],
    )
  })
  const revision = (
    await f.pool.query<{ revision: string }>('SELECT revision FROM group_slots WHERE id=$1', [
      fixture.slot,
    ])
  ).rows[0]?.revision
  return {
    ...fixture,
    cancel: {
      organization_id: f.organization,
      group_slot_id: fixture.slot,
      authority_kind: 'session',
      authority_hash: digest,
      request_key: 'cancel-key',
      fingerprint: digest,
      cancelled_seat_count: 1,
      result_revision: revision,
    },
  }
}

export const receiptProtections: Record<string, (f: GroupFixture) => Promise<void>> = {
  'receipt scalar guards': async (f) => {
    const { move } = await receiptFixture(f)
    for (const overrides of [
      { authority_hash: Buffer.alloc(31) },
      { authority_kind: 'unknown' },
      { fingerprint: Buffer.alloc(33) },
      { request_key: '' },
      { request_key: ' ' },
      { request_key: 'x'.repeat(256) },
      { request_key: 'line\nbreak' },
      { request_key: '请求' },
      { is_noop: false },
    ])
      await expect(
        insertRecord(f.pool, 'group_booking_move_receipts', { ...move, ...overrides }),
      ).rejects.toMatchObject({ code: '23514' })
    const other = await groupFixture(f.pool)
    const { cancel } = await cancelledReceiptFixture(other)
    for (const overrides of [
      { authority_hash: Buffer.alloc(31) },
      { authority_kind: 'capability' },
      { fingerprint: Buffer.alloc(33) },
      { request_key: '' },
      { cancelled_seat_count: 0 },
      { cancelled_seat_count: 101 },
      { result_revision: 0 },
    ])
      await expect(
        insertRecord(f.pool, 'group_slot_cancel_receipts', { ...cancel, ...overrides }),
      ).rejects.toMatchObject({ code: '23514' })
  },
  'receipt scope uniqueness': async (f) => {
    const { move } = await receiptFixture(f)
    await insertRecord(f.pool, 'group_booking_move_receipts', move)
    await expect(insertRecord(f.pool, 'group_booking_move_receipts', move)).rejects.toMatchObject({
      code: '23505',
    })
    await insertRecord(f.pool, 'group_booking_move_receipts', {
      ...move,
      authority_kind: 'api_key',
    })
    await insertRecord(f.pool, 'group_booking_move_receipts', {
      ...move,
      authority_hash: createHash('sha256').update('other authority').digest(),
    })
    const other = await groupFixture(f.pool)
    const { cancel } = await cancelledReceiptFixture(other)
    await insertRecord(f.pool, 'group_slot_cancel_receipts', cancel)
    await expect(insertRecord(f.pool, 'group_slot_cancel_receipts', cancel)).rejects.toMatchObject({
      code: '23505',
    })
    await insertRecord(f.pool, 'group_slot_cancel_receipts', {
      ...cancel,
      authority_kind: 'api_key',
    })
    await insertRecord(f.pool, 'group_slot_cancel_receipts', {
      ...cancel,
      authority_hash: createHash('sha256').update('other authority').digest(),
    })
  },
  'receipt binding': async (f) => {
    const { move } = await receiptFixture(f)
    const other = await groupFixture(f.pool)
    const otherSeat = await occupiedSlot(other)
    for (const overrides of [
      { organization_id: other.organization },
      { source_group_slot_id: otherSeat.slot },
      { result_group_slot_id: otherSeat.slot },
      { source_booking_id: otherSeat.bookings[0], is_noop: false },
    ])
      await expect(
        insertRecord(f.pool, 'group_booking_move_receipts', { ...move, ...overrides }),
      ).rejects.toMatchObject({ code: '23514' })
    const cancelled = await cancelledReceiptFixture(await groupFixture(f.pool))
    for (const overrides of [
      { organization_id: f.organization },
      { result_revision: Number(cancelled.cancel.result_revision) + 1 },
      { group_slot_id: otherSeat.slot },
    ])
      await expect(
        insertRecord(f.pool, 'group_slot_cancel_receipts', { ...cancelled.cancel, ...overrides }),
      ).rejects.toMatchObject({ code: '23514' })
  },
  'immutable receipts': async (f) => {
    const { move } = await receiptFixture(f)
    const id = await insertRecord(f.pool, 'group_booking_move_receipts', move)
    await expect(
      f.pool.query(`UPDATE group_booking_move_receipts SET request_key='changed' WHERE id=$1`, [
        id,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
    const other = await groupFixture(f.pool)
    const { cancel } = await cancelledReceiptFixture(other)
    const cancelId = await insertRecord(f.pool, 'group_slot_cancel_receipts', cancel)
    await expect(
      f.pool.query(`UPDATE group_slot_cancel_receipts SET request_key='changed' WHERE id=$1`, [
        cancelId,
      ]),
    ).rejects.toMatchObject({ code: '23514' })
  },
  'attribution binding': async (f) => {
    const { slot, booking } = await receiptFixture(f)
    const other = await groupFixture(f.pool)
    await expect(
      insertRecord(f.pool, 'organization_operations', {
        organization_id: other.organization,
        operation: 'booking_cancelled',
        booking_id: booking,
        group_slot_id: slot,
        source: 'web',
      }),
    ).rejects.toBeDefined()
    const id = await insertRecord(f.pool, 'organization_operations', {
      organization_id: f.organization,
      operation: 'booking_cancelled',
      booking_id: booking,
      group_slot_id: slot,
      source: 'web',
    })
    expect(id[14]).toBe('7')
    await expect(
      f.pool.query('UPDATE organization_operations SET group_slot_id=$1 WHERE id=$2', [
        randomUUID(),
        id,
      ]),
    ).rejects.toBeDefined()
  },
}
