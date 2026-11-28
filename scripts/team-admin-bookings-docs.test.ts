import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_PAGE_SIZE } from '../packages/scheduling/src/booking-page.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const design = read('../docs/team-booking-bulk-cancellation.md')
const prose = design.replaceAll(/\s+/g, ' ')
const existingFields = read('../docs/team-admin-bookings.md')
const parity: unknown = JSON.parse(read('./interface-parity.json'))

describe('team booking bulk cancellation design facts', () => {
  it('starts from the existing browser-only cancellation and bounded booking list', () => {
    expect(parity).toHaveProperty('cancelTeamBooking.exemption', 'browser-session-only')
    expect(existingFields).toContain(`\`limit\` is 1–${MAX_PAGE_SIZE}`)
  })

  it('requires current verified team management authority', () => {
    expect(design).toContain(
      '| Required credential | Current verified team owner/admin browser session |',
    )
  })

  it('bounds selection to the IDs proved by one returned page', () => {
    expect(design).toContain('| Maximum selected rows from one returned page | 25 |')
    expect(prose).toContain(
      'The server rejects the entire preview when any selected ID is absent from the same page proof.',
    )
  })

  it('uses one admission per confirmation and resolves a retry to the same batch', () => {
    expect(design).toContain(
      '| Confirmation identity | Server-generated confirmation ID, single use for admission |',
    )
    expect(prose).toContain('The same confirmation ID always refers to the same batch.')
  })

  it('excludes paid bookings, including rescheduled successors, using the shared predicate', () => {
    expect(prose).toContain('Paid bookings are excluded from bulk cancellation.')
    expect(prose).toContain(
      'Preview and execution use the same `bookingPaymentBindings` lookup as `assertBookingLocallyManaged`.',
    )
    expect(prose).toContain(
      'the root (`booking_id`) or the current booking (`current_booking_id`).',
    )
    expect(prose).toContain(
      'A stored payment hold deadline, payment confirmation timestamp or payment reference also makes a booking ineligible.',
    )
  })

  it('makes accepted batches irreversible', () => {
    expect(prose).toContain('Accepted batches cannot be undone.')
  })
})
