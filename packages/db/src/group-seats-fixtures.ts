import { randomUUID } from 'node:crypto'
import type pg from 'pg'

export type Sql = pg.Pool | pg.PoolClient
export interface GroupFixture {
  pool: pg.Pool
  organization: string
  event: string
  host: string
  otherHost: string
  start: string
  end: string
}

export async function transaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function groupFixture(pool: pg.Pool): Promise<GroupFixture> {
  const suffix = randomUUID()
  const users = (
    await pool.query<{ id: string }>(
      `INSERT INTO auth."user" (name,email,"emailVerified") VALUES
       ('Group host',$1,true),('Second group host',$2,true) RETURNING id`,
      [`host-${suffix}@example.test`, `second-${suffix}@example.test`],
    )
  ).rows
  const organization = (
    await pool.query<{ id: string }>(
      `INSERT INTO auth.organization (name,slug,"createdAt") VALUES ('Group team',$1,now()) RETURNING id`,
      [`group-${suffix}`],
    )
  ).rows[0]?.id as string
  const event = (
    await pool.query<{ id: string }>(
      `INSERT INTO event_types
       (organization_id,slug,title,duration_minutes,booking_mode,group_capacity)
       VALUES ($1,'group','Group class',30,'group',3) RETURNING id`,
      [organization],
    )
  ).rows[0]?.id as string
  const host = users[0]?.id as string
  await pool.query('INSERT INTO event_type_hosts(event_type_id,user_id) VALUES ($1,$2)', [
    event,
    host,
  ])
  return {
    pool,
    organization,
    event,
    host,
    otherHost: users[1]?.id as string,
    start: '2032-01-02T10:00:00.000Z',
    end: '2032-01-02T10:30:00.000Z',
  }
}

export async function insertRecord(sql: Sql, table: string, values: Record<string, unknown>) {
  const fields = Object.keys(values).map((field) => `"${field}"`)
  return (
    await sql.query<{ id: string }>(
      `INSERT INTO ${table} (${fields.join(',')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      Object.values(values),
    )
  ).rows[0]?.id as string
}

export async function insertSlot(
  sql: Sql,
  f: GroupFixture,
  overrides: Record<string, unknown> = {},
) {
  return insertRecord(sql, 'group_slots', {
    organization_id: f.organization,
    event_type_id: f.event,
    original_event_type_id: f.event,
    host_user_id: f.host,
    start_at: f.start,
    end_at: f.end,
    capacity: 3,
    title: 'Group class',
    ...overrides,
  })
}

export async function insertSeat(
  sql: Sql,
  f: GroupFixture,
  slot: string,
  email = `${randomUUID()}@example.test`,
  overrides: Record<string, unknown> = {},
  attendeeOverrides: Record<string, unknown> | false = {},
) {
  const booking = await insertRecord(sql, 'bookings', {
    organization_id: f.organization,
    event_type_id: f.event,
    group_slot_id: slot,
    group_booker_key: email.trim().toLowerCase(),
    required_host_user_ids: [f.host],
    start_at: f.start,
    end_at: f.end,
    title: 'Independent seat',
    source: 'web',
    ...overrides,
  })
  if (attendeeOverrides !== false)
    await insertRecord(sql, 'booking_attendees', {
      booking_id: booking,
      name: 'Invitee',
      email,
      time_zone: 'UTC',
      is_booker: true,
      ...attendeeOverrides,
    })
  return booking
}

export async function occupiedSlot(
  f: GroupFixture,
  seats = 1,
  overrides: Record<string, unknown> = {},
) {
  return transaction(f.pool, async (sql) => {
    const slot = await insertSlot(sql, f, overrides)
    await sql.query('INSERT INTO booking_hosts(group_slot_id,user_id) VALUES ($1,$2)', [
      slot,
      f.host,
    ])
    const bookings: string[] = []
    for (let i = 0; i < seats; i++) bookings.push(await insertSeat(sql, f, slot))
    return { slot, bookings }
  })
}

export async function slotState(f: GroupFixture, slot: string) {
  return (
    await f.pool.query<{
      state: string
      active_seats: number
      confirmed: number
      hosts: number
      active_hosts: number
    }>(
      `SELECT s.state,s.active_seats,
       (SELECT count(*)::int FROM bookings b WHERE b.group_slot_id=s.id AND status='confirmed') AS confirmed,
       (SELECT count(*)::int FROM booking_hosts h WHERE h.group_slot_id=s.id) AS hosts,
       (SELECT count(*)::int FROM booking_hosts h WHERE h.group_slot_id=s.id AND active) AS active_hosts
       FROM group_slots s WHERE s.id=$1`,
      [slot],
    )
  ).rows[0]
}
