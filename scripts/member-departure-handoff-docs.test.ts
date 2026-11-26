import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const design = read('docs/member-departure-handoff.md')

function section(heading: string) {
  const body = design.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0] ?? ''
  return body.replace(/\s+/gu, ' ').trim()
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

  it('requires consent from both the booker and every guest on the same version', () => {
    const decisions = section('Decisions')
    expect(decisions).toContain(
      'Both the booker and every distinct guest mailbox on the source must explicitly approve the same offer version before apply.',
    )
    expect(decisions).toContain(
      'One non-responding guest blocks the whole handoff until the offer expires.',
    )
  })

  it('cancels the existing record and preserves the immutable host snapshot', () => {
    expect(section('Decisions')).toContain(
      'In one transaction, cancel the source, preserve its original host snapshot, and insert a fresh confirmed root in an independent booking chain.',
    )
    const apply = section('Data model and atomic apply')
    expect(apply).toContain(
      '| Source booking | Cancel the existing record normally to release occupancy. Preserve `required_host_user_ids` and the original host assignments. The existing immutability trigger remains active. |',
    )
    expect(apply).toContain('No handoff path may issue an `UPDATE` of `required_host_user_ids`.')
  })

  it('creates an independent booking chain with fresh hosts and capabilities', () => {
    const apply = section('Data model and atomic apply')
    expect(apply).toContain(
      '| Replacement chain | Insert a new booking with `rescheduled_from_id = NULL`, a fresh `required_host_user_ids` snapshot and new management capabilities. |',
    )
    expect(apply).toContain(
      'Ordinary booking chain traversal, management tokens, provider writeback and notifications never follow it.',
    )
  })

  it('limits phase one to individual bookings and excludes private or unsupported sources', () => {
    const decisions = section('Decisions')
    expect(decisions).toContain(
      'Phase one supports only single-host individual bookings in non-personal teams.',
    )
    expect(decisions).toContain(
      "with `scheduling_type = 'individual'` and `booking_mode = 'individual'`",
    )
    expect(decisions).toContain(
      'Collective and round-robin bookings remain out of scope even if the event type has since changed to individual.',
    )
    expect(decisions).toContain(
      'Exclude started meetings, imported records, payment holds, paid bookings, group seats, series occurrences, poll-linked bookings, missing host snapshots, unmanaged conference URLs, and any booking with a routing snapshot (`has_routing_snapshot`).',
    )
    expect(section('Data model and atomic apply')).toContain(
      'Check `has_routing_snapshot = false` at proposal and again at apply.',
    )
  })

  it('caps confirmation sends across versions and voids older links for that mailbox', () => {
    const consent = section('Authorization and participant consent')
    expect(consent).toContain(
      'Cap confirmation-link sends at three per normalized recipient mailbox per source booking, including the initial send and sends across offer versions.',
    )
    expect(consent).toContain(
      'atomically revoke all older links for that recipient before minting the new digest.',
    )
    expect(consent).toContain(
      'The administrator UI keeps Apply disabled while any approval is outstanding and explains that a single unanswered guest keeps the handoff blocked.',
    )
  })

  it('keeps Microsoft cleanup and the private Teams URL on the old chain', () => {
    const providers = section('Provider and notification identities')
    expect(providers).toContain(
      "Reconcile the old root's pinned `booking_calendar_targets.microsoft_writeback` state.",
    )
    expect(providers).toContain('recheck `requireMicrosoftTeamsHost` in admission')
    expect(providers).toContain(
      "The old chain's private `teamsJoinUrl` is never copied to the replacement chain.",
    )
    expect(providers).toContain(
      "For `join_url_pending`, `teams_unavailable` and `writeback_failed`, the cancellation describes the old link's status and the confirmation describes the new link's status.",
    )
  })
})
