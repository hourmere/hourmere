import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { groupFixture, occupiedSlot } from '../../db/src/group-seats-fixtures.ts'
import { DomainError } from './errors.ts'
import { bookingHostIds, resolvedBookingHosts } from './hosts.ts'

const serverUrl = process.env.DATABASE_URL

type HostModule = Pick<typeof import('./hosts.ts'), 'resolvedBookingHosts' | 'bookingHostIds'>
function sourceCopy(omitSeats = false): HostModule {
  let source = readFileSync('packages/scheduling/src/hosts.ts', 'utf8')
  if (omitSeats) {
    const anchor = ".select(['seat.id as booking_id', 'host.user_id'])"
    expect(source.includes(anchor), 'mutation must match source').toBe(true)
    source = source.replace(
      anchor,
      `.where('seat.id', '=', '00000000-0000-0000-0000-000000000000')${anchor}`,
    )
  }
  source = stripTypeScriptTypes(source.replace(/^import .*\n/gm, '')).replace(/\bexport /g, '')
  return new Function('DomainError', `${source}; return { resolvedBookingHosts, bookingHostIds }`)(
    DomainError,
  ) as HostModule
}

describe.skipIf(!serverUrl)('slot and seat host resolution', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'group_hosts' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture() {
    const f = await groupFixture(owned.pool)
    await owned.pool.query(
      `INSERT INTO auth.member ("organizationId","userId",role,"createdAt") VALUES ($1,$2,'owner',now())`,
      [f.organization, f.host],
    )
    return f
  }

  it('resolves each seat through one shared occupancy and keeps ordinary hosts', async () => {
    const f = await fixture()
    const { slot, bookings } = await occupiedSlot(f, 2)
    const legacy = (
      await owned.pool.query<{ id: string }>(
        `INSERT INTO bookings (organization_id,start_at,end_at,title,source,required_host_user_ids)
         VALUES ($1,'2032-01-03T10:00Z','2032-01-03T10:30Z','Ordinary','web',ARRAY[$2::uuid]) RETURNING id`,
        [f.organization, f.host],
      )
    ).rows[0]?.id as string
    await owned.pool.query('INSERT INTO booking_hosts (booking_id,user_id) VALUES ($1,$2)', [
      legacy,
      f.host,
    ])
    const ids = [...bookings, legacy].sort()
    const rows = await db
      .selectFrom(resolvedBookingHosts(db).as('h'))
      .selectAll()
      .where('booking_id', 'in', ids)
      .orderBy('booking_id')
      .execute()
    expect(rows).toEqual(ids.map((booking_id) => ({ booking_id, user_id: f.host })))
    expect(
      (await owned.pool.query('SELECT id FROM booking_hosts WHERE group_slot_id=$1', [slot])).rows,
    ).toHaveLength(1)
    for (const id of ids)
      expect(await bookingHostIds(db, id, f.organization, [f.host])).toEqual([f.host])
  })

  it('retains host resolution for cancelled seats without resurrecting their occupancy', async () => {
    const f = await fixture()
    const { slot, bookings } = await occupiedSlot(f)
    const booking = bookings[0] as string
    await owned.pool.query(
      `UPDATE bookings SET status='cancelled',cancelled_at=now() WHERE id=$1`,
      [booking],
    )
    expect(await bookingHostIds(db, booking, f.organization, [f.host])).toEqual([f.host])
    expect(
      (await owned.pool.query('SELECT active FROM booking_hosts WHERE group_slot_id=$1', [slot]))
        .rows,
    ).toEqual([{ active: false }])
  })

  it('fails closed after membership withdrawal or account deletion', async () => {
    const f = await fixture()
    const { bookings } = await occupiedSlot(f)
    const booking = bookings[0] as string
    await expect(bookingHostIds(db, booking, f.organization, [f.otherHost])).rejects.toMatchObject({
      code: 'booking_hosts_unavailable',
    })
    await expect(bookingHostIds(db, booking, f.otherHost, [f.host])).rejects.toMatchObject({
      code: 'booking_hosts_unavailable',
    })
    await owned.pool.query('DELETE FROM auth.member WHERE "organizationId"=$1 AND "userId"=$2', [
      f.organization,
      f.host,
    ])
    await expect(bookingHostIds(db, booking, f.organization, [f.host])).rejects.toMatchObject({
      code: 'booking_hosts_unavailable',
    })
    await owned.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.host])
    await expect(bookingHostIds(db, booking, f.organization, [f.host])).rejects.toMatchObject({
      code: 'booking_hosts_unavailable',
    })
    expect(
      await db
        .selectFrom(resolvedBookingHosts(db).as('h'))
        .selectAll()
        .where('booking_id', '=', booking)
        .execute(),
    ).toEqual([])
  })

  it('detects source-copy omission of slot hosts with the real seat membership assertion', async () => {
    const f = await fixture()
    const { bookings } = await occupiedSlot(f, 2)
    const verify = async (copy: HostModule) => {
      const rows = await db
        .selectFrom(copy.resolvedBookingHosts(db).as('h'))
        .selectAll()
        .where('booking_id', 'in', bookings)
        .orderBy('booking_id')
        .execute()
      expect(rows, 'every seat resolves its shared slot host').toEqual(
        [...bookings].sort().map((booking_id) => ({ booking_id, user_id: f.host })),
      )
    }
    await verify(sourceCopy())
    await expect(verify(sourceCopy(true))).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(sourceCopy())
  })
})

import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
