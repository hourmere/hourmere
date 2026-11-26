import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const document = readFileSync(
  new URL('../docs/team-ownership-transfer.md', import.meta.url),
  'utf8',
)

it('requires a verified owner to initiate and only the named verified member to confirm', () => {
  expect(document).toContain(
    '| Create | A current, email-verified owner of the active team | Offer ownership to a different, current, email-verified `admin` or `member` of that same team. |',
  )
  expect(document).toContain(
    '| Confirm | The named recipient alone, through their current, email-verified membership in the active team |',
  )
  expect(document).toContain(
    'set the recipient to `owner` and the initiating owner to `admin` atomically.',
  )
})

it('limits confirmation and owner revocation to a pending offer within 24 hours', () => {
  expect(document).toContain(
    '| Revoke | The initiating owner alone, through their current, email-verified owner membership in the active team | Revoke the pending offer before its deadline, without changing any roles. |',
  )
  expect(document).toContain('An offer expires 24 hours after creation on the database clock.')
  expect(document.replace(/\s+/g, ' ')).toContain(
    'Confirmation and revocation require `clock_timestamp() < expires_at` after lock waits.',
  )
})

it('keeps personal calendars and provider authorizations with their original users', () => {
  expect(document.replace(/\s+/g, ' ')).toContain(
    'Personal spaces, personal calendars and provider authorizations stay with their original users. That includes Google, Microsoft and CalDAV calendar connections and Zoom authorization.',
  )
})
