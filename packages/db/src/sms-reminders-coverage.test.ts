import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { attempts } from './meeting-poll-protections.ts'
import { checkConstraintCoverage } from './testing/constraint-coverage.ts'

const setup = `INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ('10000000-0000-4000-8000-000000000001','SMS','sms-test',now());
INSERT INTO event_types (id,organization_id,slug,title,duration_minutes) VALUES ('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','sms','SMS',30);
INSERT INTO bookings (id,organization_id,event_type_id,start_at,end_at,title,source) VALUES ('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','2026-11-02T09:00Z','2026-11-02T09:30Z','SMS','web');
INSERT INTO booking_attendees (booking_id,name,email,time_zone) VALUES ('10000000-0000-4000-8000-000000000003','Invitee','invitee@example.test','UTC');`
export async function assertSmsReminderProtections(pool: pg.Pool) {
  const cases: { sql: string }[] = []
  const expected: (string | undefined)[] = []
  for (const [table, column] of [
    ['sms_suppressions', 'recipient_hash'],
    ['sms_inbound_receipts', 'key_hash'],
  ]) {
    cases.push({
      sql: `INSERT INTO ${table} (${column}) VALUES (decode(repeat('ab',32),'hex')), (decode(repeat('ab',32),'hex'))`,
    })
    expected.push('23505')
    cases.push({ sql: `INSERT INTO ${table} (${column}) VALUES (decode('ab','hex'))` })
    expected.push('23514')
  }
  for (const [table, column] of [
    ['event_types', 'sms_reminders_enabled'],
    ['bookings', 'sms_reminders_enabled'],
    ['booking_attendees', 'sms_consent'],
  ]) {
    cases.push({ sql: `UPDATE ${table} SET ${column}=NULL` })
    expected.push('23502')
  }
  const errors = await attempts(pool, cases, setup)
  expect(errors.map((e) => e?.code)).toEqual(expected)
}
describe.skipIf(!process.env.DATABASE_URL)('SMS reminder constraint coverage', () => {
  it('covers every new constraint', async () => {
    const report = await checkConstraintCoverage({
      serverUrl: process.env.DATABASE_URL as string,
      migration: '0100_sms_reminders.sql',
      assertions: assertSmsReminderProtections,
    })
    expect(report.problems).toEqual([])
  }, 600000)
})
