// Synthetic data only. Scalar/FK definitions are the audited import surface from the
// two upstream Prisma schemas; legacy-only columns below distinguish the v6 fixture.
import { randomBytes, randomUUID } from 'node:crypto'
import { createTestDatabase } from '@hourmere/db/testing'
import pg from 'pg'
import { SOURCE_COLUMNS } from './schema.ts'
import { BASELINE_COLUMNS, BASELINE_ENUMS, BASELINE_RELATIONS } from './source-baselines.ts'
import type { SourceRow, SourceTable, SourceVersion } from './types.ts'

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const sqlType = (signature: string, enums: Record<string, readonly string[]>) => {
  const type = signature.replace(/\?$/, '')
  if (type === 'timestamp') return 'timestamp(3) without time zone'
  if (type === 'time') return 'time without time zone'
  if (type === '_int4') return 'integer[]'
  if (type === '_text') return 'text[]'
  return Object.hasOwn(enums, type) ? quote(type) : type
}
export async function createSourceFixture(version: SourceVersion) {
  const db = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
    migrate: false,
    tag: 'calcom_source',
  })
  const role = `calcom_ro_${process.pid}_${randomBytes(6).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  let roleCreated = false
  const roleUrl = new URL(db.url)
  roleUrl.username = role
  roleUrl.password = password
  const restricted = new pg.Pool({ connectionString: roleUrl.toString(), max: 1 })
  try {
    const fullColumns = BASELINE_COLUMNS[version]
    const fullEnums = BASELINE_ENUMS[version]
    for (const [name, labels] of Object.entries(fullEnums)) {
      await db.pool.query(
        `CREATE TYPE ${quote(name)} AS ENUM (${labels.map((label) => `'${label}'`).join(',')})`,
      )
    }
    for (const [table, columns] of Object.entries(fullColumns)) {
      const defs = Object.entries(columns).map(
        ([column, type]) =>
          `${quote(column)} ${sqlType(type, fullEnums)}${type.endsWith('?') ? '' : ' NOT NULL'}`,
      )
      if ('id' in columns) defs.push('PRIMARY KEY (id)')
      if (table === 'Host') defs.push('PRIMARY KEY ("userId","eventTypeId")')
      await db.pool.query(`CREATE TABLE ${quote(table)} (${defs.join(',')})`)
    }
    // Minimal non-readable stubs preserve baseline FK signatures to excluded models.
    const stubColumns = new Map<string, Map<string, string>>()
    for (const [table, columns, target, references] of BASELINE_RELATIONS[version]) {
      if (Object.hasOwn(fullColumns, target)) continue
      const defs = stubColumns.get(target) ?? new Map<string, string>()
      for (const [i, column] of columns.entries()) {
        const referenced = references[i]
        if (referenced)
          defs.set(referenced, (fullColumns[table]?.[column] ?? 'text').replace(/\?$/, ''))
      }
      stubColumns.set(target, defs)
    }
    for (const [table, columns] of stubColumns) {
      const defs = [...columns].map(
        ([column, type]) => `${quote(column)} ${sqlType(type, fullEnums)} UNIQUE`,
      )
      if (table === 'Credential') defs.push('key jsonb')
      await db.pool.query(`CREATE TABLE ${quote(table)} (${defs.join(',')})`)
    }
    for (const [i, [table, columns, target, references]] of BASELINE_RELATIONS[version].entries()) {
      await db.pool.query(`ALTER TABLE ${quote(table)} ADD CONSTRAINT fixture_fk_${i}
        FOREIGN KEY (${columns.map(quote).join(',')}) REFERENCES ${quote(target)} (${references.map(quote).join(',')})`)
    }
    await db.pool.query(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    )
    roleCreated = true
    const database = roleUrl.pathname.slice(1)
    await db.pool.query(`REVOKE ALL ON DATABASE ${quote(database)} FROM PUBLIC`)
    await db.pool.query(`GRANT CONNECT ON DATABASE ${quote(database)} TO ${role}`)
    await db.pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await db.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
    for (const [table, columns] of Object.entries(SOURCE_COLUMNS)) {
      const allowed = [...columns] as string[]
      if (table === 'EventType') allowed.push('metadata')
      if (table === 'Booking') allowed.push('uid', 'fromReschedule')
      await db.pool.query(
        `GRANT SELECT (${allowed.map(quote).join(',')}) ON ${quote(table)} TO ${role}`,
      )
    }
    const insert = async (table: SourceTable, values: SourceRow) => {
      const defaults: SourceRow = {}
      for (const [column, type] of Object.entries(fullColumns[table] ?? {})) {
        if (type.endsWith('?')) defaults[column] = null
        else if (type === 'int4') defaults[column] = 0
        else if (type === 'bool') defaults[column] = false
        else if (type === 'text' || type === 'varchar') defaults[column] = 'fixture'
        else if (type === 'uuid') defaults[column] = randomUUID()
        else if (type === 'jsonb') defaults[column] = {}
        else if (type === 'date') defaults[column] = '2040-01-01'
        else if (type === 'timestamp') defaults[column] = '2040-01-01T00:00:00.000Z'
        else if (type === 'time') defaults[column] = '00:00:00'
        else if (Object.hasOwn(fullEnums, type)) defaults[column] = fullEnums[type]?.[0]
      }
      const row = { ...defaults, ...values }
      const columns = Object.keys(row)
      await db.pool.query(
        `INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(',')})`,
        columns.map((column) => {
          const value = row[column]
          const type = fullColumns[table]?.[column]
          return value !== null && type?.replace(/\?$/, '') === 'jsonb'
            ? JSON.stringify(value)
            : value
        }),
      )
    }
    await insert('users', {
      id: 1,
      email: ' Owner@Example.test ',
      emailVerified: '2040-01-01T00:00:00Z',
      username: 'owner',
      timeZone: 'America/New_York',
      locale: 'en',
      bufferTime: 0,
    })
    await insert('users', {
      id: 2,
      email: 'other@example.test',
      emailVerified: '2040-01-01T00:00:00Z',
      username: 'other',
      timeZone: 'UTC',
      locale: 'en',
    })
    await insert('Schedule', {
      id: 10,
      userId: 1,
      name: 'Working hours',
      timeZone: 'America/New_York',
    })
    await db.pool.query('UPDATE users SET "defaultScheduleId"=10 WHERE id=1')
    await insert('EventType', {
      id: 100,
      userId: 1,
      title: 'Consultation',
      slug: 'consultation',
      length: 30,
      periodType: 'unlimited',
      metadata: {
        multipleDuration: [30, 60],
        arbitraryProviderSecret: 'NEVER_READ_PROVIDER_SECRET',
      },
      scheduleId: 10,
      minimumBookingNotice: 120,
    })
    await insert('EventType', {
      id: 200,
      userId: 2,
      title: 'Other owner',
      slug: 'other',
      length: 30,
      periodType: 'unlimited',
    })
    await insert('Host', { eventTypeId: 100, userId: 1, scheduleId: 10 })
    await insert('_user_eventtype', { A: 100, B: 1 })
    await insert('Availability', {
      id: 1,
      scheduleId: 10,
      days: [1],
      startTime: '09:00:59.125',
      endTime: '23:59:00',
    })
    await insert('Availability', {
      id: 2,
      scheduleId: 10,
      days: [],
      date: '2041-01-01',
      startTime: '00:00:00',
      endTime: '00:00:00',
    })
    await insert('Booking', {
      id: 1000,
      userId: 1,
      eventTypeId: 100,
      title: 'Existing booking',
      uid: 'NEVER_READ_CANCELLATION_CAPABILITY',
      startTime: '2041-01-01T10:00:00.123Z',
      endTime: '2041-01-01T10:45:00.789Z',
      status: 'accepted',
      responses: { email: 'invitee@example.test' },
      location: 'https://meet.example.test/join',
      paid: false,
    })
    await insert('Booking', {
      id: 2000,
      userId: 2,
      eventTypeId: 200,
      title: 'Other owner booking',
      uid: 'NEVER_READ_OTHER_CAPABILITY',
      startTime: '2041-01-01T10:00:00Z',
      endTime: '2041-01-01T11:00:00Z',
      status: 'accepted',
    })
    await insert('Attendee', {
      id: 1,
      bookingId: 1000,
      name: 'Invitee',
      email: 'invitee@example.test',
      timeZone: 'UTC',
      locale: 'en',
    })
    await insert('Attendee', {
      id: 2,
      bookingId: 2000,
      name: 'Other invitee',
      email: 'other-invitee@example.test',
      timeZone: 'UTC',
      locale: 'en',
    })
    return {
      db,
      role,
      connectionString: roleUrl.toString(),
      restricted,
      insert,
      async drop() {
        await restricted.end()
        // Role grants are local to this disposable database; drop it before the role.
        await db.drop()
        const adminUrl = new URL(db.url)
        adminUrl.pathname = '/postgres'
        const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 })
        try {
          await admin.query(`DROP ROLE ${role}`)
        } finally {
          await admin.end()
        }
      },
    }
  } catch (error) {
    await restricted.end()
    await db.drop()
    if (roleCreated) {
      const adminUrl = new URL(db.url)
      adminUrl.pathname = '/postgres'
      const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 })
      try {
        await admin.query(`DROP ROLE ${role}`)
      } finally {
        await admin.end()
      }
    }
    throw error
  }
}
