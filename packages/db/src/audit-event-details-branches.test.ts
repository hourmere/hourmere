import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type DetailsCheckBranch, detailsCheckBranches } from './audit-details-check-source.ts'
import { migrationsDir } from './migrate.ts'

const destinations = (branch: DetailsCheckBranch) =>
  branch.when.startsWith("    WHEN action IN ('webhook.created',") ||
  branch.when.startsWith("    WHEN action IN ('slack_destination.created',")

describe('0080 audit event details', () => {
  const previous = detailsCheckBranches('0078_audit_actions_followups.sql')
  const current = detailsCheckBranches('0080_audit_event_details.sql')

  it('keeps every branch except the webhook and Slack ones byte for byte from 0078', () => {
    expect(current.head).toBe(previous.head)
    expect(current.branches.map((branch) => branch.when)).toEqual(
      previous.branches.map((branch) => branch.when),
    )
    expect(previous.branches.filter(destinations)).toHaveLength(2)
    const others = (check: typeof current) =>
      check.branches.filter((branch) => !destinations(branch)).map((branch) => branch.text)
    expect(others(current)).toEqual(others(previous))
    expect(others(current)).toHaveLength(previous.branches.length - 2)
  })

  it('keeps the webhook and Slack action lists and adds only rules for the events value', () => {
    for (const branch of current.branches.filter(destinations)) {
      const old = previous.branches.find((candidate) => candidate.when === branch.when)
      expect(old?.text).toBe(branch.when)
      expect(branch.when.endsWith(" THEN details - 'events' = '{}'::jsonb")).toBe(true)
      expect(branch.text).toContain(`${branch.when}\n      AND (NOT details ? 'events' OR CASE`)
    }
  })

  it('adds the check NOT VALID and validates it in the same file', () => {
    expect(previous.tail).toBe('\n  END\n);')
    expect(current.tail).toBe('\n  END\n) NOT VALID;')
    const sql = readFileSync(join(migrationsDir, '0080_audit_event_details.sql'), 'utf8')
    expect(
      sql
        .trimEnd()
        .endsWith('ALTER TABLE audit_events VALIDATE CONSTRAINT audit_events_details_check;'),
    ).toBe(true)
  })
})
