// Migration 0089 adds invitee change deadlines to event_types and bookings. These checks pass
// on the migration as written and fail when any constraint it creates is dropped
// (change-deadlines-coverage.test.ts) or lost by an upgrade (change-deadlines-migration.test.ts).
// Every check runs in a rolled-back transaction.
import type pg from 'pg'
import { expect } from 'vitest'
import { attempts } from './meeting-poll-protections.ts'

const SETUP = `
  INSERT INTO auth.organization (id, name, slug, "createdAt")
    VALUES ('0890a000-0000-4000-8000-000000000001', 'Deadlines', 'deadline-protections', now());
  INSERT INTO event_types (id, organization_id, slug, title, duration_minutes)
    VALUES ('0890a000-0000-4000-8000-000000000002', '0890a000-0000-4000-8000-000000000001',
      'deadlines', 'Deadlines', 30);
  INSERT INTO bookings (id, organization_id, event_type_id, start_at, end_at, title, source)
    VALUES ('0890a000-0000-4000-8000-000000000003', '0890a000-0000-4000-8000-000000000001',
      '0890a000-0000-4000-8000-000000000002', '2026-11-02T09:00Z', '2026-11-02T09:30Z',
      'Deadlines', 'web');`

const set = (table: string, column: string, value: number | null) => ({
  sql: `UPDATE ${table} SET ${column} = $1 WHERE id = $2`,
  params: [
    value,
    table === 'event_types'
      ? '0890a000-0000-4000-8000-000000000002'
      : '0890a000-0000-4000-8000-000000000003',
  ],
})

/** Throws when either table admits a deadline outside 1–525600 minutes (NULL = none). */
export async function assertChangeDeadlineProtections(pool: pg.Pool): Promise<void> {
  const cases: Record<string, ReturnType<typeof set>> = {}
  for (const table of ['event_types', 'bookings'])
    for (const column of ['reschedule_cutoff_minutes', 'cancel_cutoff_minutes'])
      for (const [label, value] of [
        ['none', null],
        ['min', 1],
        ['max', 525_600],
        ['zero', 0],
        ['negative', -1],
        ['over', 525_601],
      ] as const)
        cases[`${table}.${column}.${label}`] = set(table, column, value)
  const errors = await attempts(pool, Object.values(cases), SETUP)
  const outcome = (error: pg.DatabaseError | undefined) =>
    error ? [error.code, error.constraint] : ['accepted']
  const expected: Record<string, unknown[]> = {}
  for (const table of ['event_types', 'bookings'])
    for (const [column, kind] of [
      ['reschedule_cutoff_minutes', 'reschedule'],
      ['cancel_cutoff_minutes', 'cancel'],
    ])
      for (const label of ['none', 'min', 'max', 'zero', 'negative', 'over'])
        expected[`${table}.${column}.${label}`] = ['none', 'min', 'max'].includes(label)
          ? ['accepted']
          : ['23514', `${table}_${kind}_cutoff_range`]
  expect(
    Object.fromEntries(Object.keys(cases).map((name, i) => [name, outcome(errors[i])])),
  ).toEqual(expected)
}
