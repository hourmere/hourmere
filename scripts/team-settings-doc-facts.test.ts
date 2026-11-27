import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const docs = new URL('../apps/site/src/content/docs/docs/', import.meta.url)

function section(file: string, start: string, end: string) {
  return (readFileSync(new URL(file, docs), 'utf8').split(start)[1]?.split(end)[0] ?? '').replace(
    /\s+/g,
    ' ',
  )
}

it('documents the public link change, hold and booking history covered by team settings tests', () => {
  const guide = section(
    'collective-scheduling.md',
    '## Public links, agents and availability\n',
    '\n## ',
  )
  expect(guide).toContain('`/team/{teamSlug}/{slug}`')
  expect(guide).toContain('Existing links use the exact stored case.')
  expect(guide).toContain('owners and admins can edit the name and public address')
  expect(guide).toContain('Changing the name alone keeps existing URLs.')
  expect(guide).toContain('Replace the old links in shared messages and embeds.')
  expect(guide).toContain('including public event pages, embeds, team routing links')
  expect(guide).toContain(
    'The old address does not redirect. For 90 days after a change, only the same team can reclaim it.',
  )
  expect(guide).toContain('Existing bookings and their history stay in the team.')
  expect(guide).toContain('Invitees can still use their existing booking management links.')
  expect(guide).toContain(
    'A reclaimed address is saved in lowercase. Links using the original mixed-case spelling remain unavailable.',
  )
})

it('documents which links in previously sent waitlist emails remain usable', () => {
  const waitlist = section('booking-waitlist.md', '## When a time opens\n', '\n## ')
  expect(waitlist).toContain(
    'booking links in waitlist notifications that were already sent still point to the old address.',
  )
  expect(waitlist).toContain('They do not redirect to the new address.')
  expect(waitlist).toContain('Confirmation and leave links use private tokens and keep working.')
})

it('documents the team settings write surface and address claim rules', () => {
  const conventions = section('api-conventions.md', '**Team details.**', '\n\nSession webhook')
  expect(conventions).toContain('`POST /api/auth/organization/update`')
  expect(conventions).toContain('as `X-Expected-Team-Name` and `X-Expected-Team-Slug`')
  expect(conventions).toContain('HTTP 409 `TEAM_SETTINGS_CHANGED`')
  expect(conventions).toContain('reserved names return HTTP 400 `ORGANIZATION_SLUG_RESERVED`')
  expect(conventions).toContain('New and edited slugs are saved in lowercase.')
  expect(conventions).toContain('HTTP 400 `ORGANIZATION_SLUG_ALREADY_TAKEN`')
  expect(conventions).toContain('Public links move to the new address immediately.')
  expect(conventions).toContain('MCP and CLI credentials cannot change team details.')
})
