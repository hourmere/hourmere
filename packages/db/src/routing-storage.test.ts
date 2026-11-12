import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bookingRoutingValues,
  insertRow,
  receiptValues,
  routingFixture,
  versionValues,
} from './routing-storage-fixtures.ts'
import { routingProtections } from './routing-storage-protections.ts'
import { checkQuotaRace } from './routing-storage-quota-races.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('routing storage', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await createTestDatabase(serverUrl as string)
  })
  afterAll(async () => {
    await db?.drop()
  })
  it.each(Object.keys(routingProtections))('%s', async (name) => {
    await routingProtections[name]?.check(await routingFixture(db.pool))
    expect(db.pool.totalCount).toBeLessThanOrEqual(2)
  })

  it('publishes atomically with a deferred same-form pointer and preserves historical authors', async () => {
    const f = await routingFixture(db.pool)
    const client = await db.pool.connect()
    const id = randomUUID()
    try {
      await client.query('BEGIN')
      await client.query(
        'UPDATE routing_forms SET published_version_id=$1,enabled=true WHERE id=$2',
        [id, f.form],
      )
      await insertRow(client, 'routing_form_versions', {
        ...versionValues(f),
        id,
        version_number: 2,
      })
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    await db.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.creator])
    expect(
      (
        await db.pool.query(
          'SELECT created_by_user_id,published_version_id,enabled FROM routing_forms WHERE id=$1',
          [f.form],
        )
      ).rows,
    ).toEqual([{ created_by_user_id: f.creator, published_version_id: id, enabled: true }])
    expect(
      (
        await db.pool.query('SELECT published_by_user_id FROM routing_form_versions WHERE id=$1', [
          id,
        ])
      ).rows,
    ).toEqual([{ published_by_user_id: f.creator }])
    await expect(
      db.pool.query('UPDATE routing_forms SET archived_at=now() WHERE id=$1', [f.form]),
    ).rejects.toMatchObject({ code: '23514' })
    await db.pool.query('UPDATE routing_forms SET enabled=false,archived_at=now() WHERE id=$1', [
      f.form,
    ])
  })

  it.each(['forms', 'versions'] as const)(
    'rejects a stale repeatable-read %s quota writer',
    async (kind) => {
      await checkQuotaRace(await routingFixture(db.pool), kind, true)
    },
  )

  it('keeps snapshots through form cleanup and dependencies through event deletion', async () => {
    const f = await routingFixture(db.pool)
    await insertRow(db.pool, 'routing_target_dependencies', {
      organization_id: f.organization,
      version_id: f.version,
      rule_id: 'fallback',
      event_type_id: f.event,
    })
    await insertRow(db.pool, 'booking_routing', bookingRoutingValues(f))
    await db.pool.query('DELETE FROM event_types WHERE id=$1', [f.event])
    expect(
      (
        await db.pool.query(
          'SELECT event_type_id,health_code FROM routing_target_dependencies WHERE version_id=$1',
          [f.version],
        )
      ).rows,
    ).toEqual([{ event_type_id: f.event, health_code: 'unknown' }])
    await db.pool.query('DELETE FROM routing_forms WHERE id=$1', [f.form])
    expect(
      (
        await db.pool.query('SELECT version_id FROM booking_routing WHERE booking_id=$1', [
          f.booking,
        ])
      ).rows,
    ).toEqual([{ version_id: f.version }])
    expect(
      (
        await db.pool.query('SELECT * FROM routing_target_dependencies WHERE version_id=$1', [
          f.version,
        ])
      ).rows,
    ).toEqual([])
    await db.pool.query('DELETE FROM bookings WHERE id=$1', [f.booking])
    expect(
      (await db.pool.query('SELECT * FROM booking_routing WHERE booking_id=$1', [f.booking])).rows,
    ).toEqual([])
  })

  it('organization deletion cascades all five tables even with current pointers and consumed evidence', async () => {
    const f = await routingFixture(db.pool)
    await db.pool.query('UPDATE routing_forms SET published_version_id=$1 WHERE id=$2', [
      f.version,
      f.form,
    ])
    await insertRow(db.pool, 'routing_target_dependencies', {
      organization_id: f.organization,
      version_id: f.version,
      rule_id: 'fallback',
      event_type_id: f.event,
    })
    await insertRow(db.pool, 'booking_routing', bookingRoutingValues(f))
    await insertRow(db.pool, 'routing_receipts', receiptValues(f))
    await insertRow(db.pool, 'routing_receipts', {
      ...receiptValues(f),
      consumed_booking_id: f.booking,
      answers_ciphertext: null,
    })
    await db.pool.query('DELETE FROM auth.organization WHERE id=$1', [f.organization])
    for (const table of [
      'routing_forms',
      'routing_form_versions',
      'routing_target_dependencies',
      'routing_receipts',
      'booking_routing',
    ])
      expect(
        (await db.pool.query(`SELECT * FROM ${table} WHERE organization_id=$1`, [f.organization]))
          .rows,
      ).toEqual([])
    expect(
      (await db.pool.query('SELECT id FROM routing_forms WHERE id=$1', [f.otherForm])).rows,
    ).toHaveLength(1)
  })
})
