import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const design = read('docs/member-departure-handoff.md')

// Pin the design's handoff invariants. The SQL and chain query describe the shipped baseline.
const rules = [
  {
    name: 'Source hosts',
    expected:
      'Preserve `required_host_user_ids` and the original host assignments. The existing immutability trigger remains active. Cancel normally to release occupancy.',
    unsafe: 'Update the source booking host snapshot to the replacement hosts.',
  },
  {
    name: 'Replacement chain',
    expected:
      'Insert a new booking with `rescheduled_from_id = NULL`, a fresh `required_host_user_ids` snapshot and new management capabilities.',
    unsafe: 'Insert a successor with `rescheduled_from_id` pointing to the source booking.',
  },
  {
    name: 'Participant consent',
    expected:
      'Every distinct booker and guest mailbox must explicitly approve the exact offer version before apply.',
    unsafe: 'Apply once the booker has approved, regardless of the guests.',
  },
]

function verifyRule(document: string, name: string, expected: string) {
  const section = document.split('## Data model and atomic apply\n')[1]?.split('\n## ')[0] ?? ''
  const rows = section.split('\n').filter((line) => line.startsWith(`| ${name} | `))
  expect(rows, name).toEqual([`| ${name} | ${expected} |`])
}

describe('departure handoff design facts', () => {
  it('matches the existing SQL snapshot guard and reschedule-chain boundary', () => {
    const migration = read('packages/db/migrations/0019_required_booking_hosts.sql')
    expect(migration).toContain(
      'IF NEW.required_host_user_ids IS DISTINCT FROM OLD.required_host_user_ids',
    )
    expect(migration).toContain('BEFORE UPDATE OF required_host_user_ids ON bookings')
    const chain = read('packages/scheduling/src/booking-chain.ts')
    expect(chain).toContain('JOIN chain c ON b.rescheduled_from_id = c.id')
  })

  it.each(rules)('pins $name in the proposed data model', ({ name, expected }) => {
    verifyRule(design, name, expected)
  })

  it.each(rules)('rejects a source-copy change to $name', ({ name, expected, unsafe }) => {
    verifyRule(design, name, expected)
    const copy = design.replace(`| ${name} | ${expected} |`, `| ${name} | ${unsafe} |`)
    expect(copy).not.toBe(design)
    expect(() => verifyRule(copy, name, expected)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
