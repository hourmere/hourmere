import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { checkSourceMutation } from './mutation-testing.ts'
import { SOURCE_COLUMN_EXCEPTIONS, SOURCE_COLUMNS } from './schema.ts'

// Verbatim input allowlist/never_select from the 2026-10-31 design contract. Keep
// this independent of runtime columns: fixture grants alone cannot prove minimization.
const contract = JSON.parse(
  await readFile(new URL('./source-column-contract.json', import.meta.url), 'utf8'),
) as {
  allowlisted_tables_and_columns: Record<string, string[]>
  never_select: string[]
}
function assertContractColumns(columns: unknown, exceptions: unknown) {
  const expected = Object.fromEntries(
    Object.entries(contract.allowlisted_tables_and_columns)
      .filter(([table]) => !table.includes(' '))
      .map(([table, names]) => [table, names.map((name) => name.replace(/ \(.*/, ''))]),
  )
  expect(columns).toEqual(expected)
  expect(exceptions).toEqual({ EventType: ['metadata'], Booking: ['uid', 'fromReschedule'] })
  const selected = columns as Record<string, readonly string[]>
  for (const forbidden of contract.never_select) {
    const qualified = /^([A-Za-z]+)\.([A-Za-z]+)$/.exec(forbidden)
    if (qualified) expect(selected[qualified[1] as string] ?? []).not.toContain(qualified[2])
    if (/^[A-Za-z]+$/.test(forbidden)) expect(selected).not.toHaveProperty(forbidden)
  }
  expect(selected.EventType).not.toContain('metadata')
  expect(selected.Booking).not.toContain('uid')
  expect(selected.Booking).not.toContain('fromReschedule')
}
describe('contract-pinned source column permissions', () => {
  it('matches every allowlisted column, JSON-path/predicate exception and forbidden column', () => {
    assertContractColumns(SOURCE_COLUMNS, SOURCE_COLUMN_EXCEPTIONS)
  })
  it('detects source-copy mutations widening output or predicate privileges', async () => {
    for (const [before, after] of [
      [
        "BookingReference: ['bookingId', 'type', 'deleted', 'meetingUrl']",
        "BookingReference: ['bookingId', 'type', 'deleted', 'meetingUrl', 'meetingPassword']",
      ],
      [
        "Booking: ['uid', 'fromReschedule']",
        "Booking: ['uid', 'fromReschedule', 'oneTimePassword']",
      ],
    ]) {
      await checkSourceMutation(
        new URL('./schema.ts', import.meta.url),
        before as string,
        after as string,
        (module) => module,
        (module) => assertContractColumns(module.SOURCE_COLUMNS, module.SOURCE_COLUMN_EXCEPTIONS),
      )
    }
  })
})
