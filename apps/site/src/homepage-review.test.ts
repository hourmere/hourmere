import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const plainText = (source: string) =>
  source
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

describe('reviewed homepage and comparison disclosures', () => {
  const home = plainText(read('./pages/index.astro'))
  const intro = plainText(read('./content/docs/docs/comparison.md').split(/^## /m)[0] ?? '')

  it.each([
    [
      'calendar connection step',
      'Connect Google Calendar. Hourmere reads your free/busy times, so it only offers times when you are actually free.',
    ],
    [
      'calendar synchronization feature',
      'Works with Google Calendar. Hourmere reads free/busy information to avoid conflicts and writes booked meetings to your calendar.',
    ],
    [
      'calendar permission explanation',
      'When you connect Google Calendar, Hourmere asks for permission to read your calendars, so it can work out when you are available, and to add, update and remove the calendar events for your bookings.',
    ],
    ['supported-calendar FAQ', 'Which calendars does Hourmere work with? Google Calendar.'],
    [
      'preview sign-in disclosure',
      'If you sign in with Google, Hourmere receives your Google account ID, name, email address and profile picture (if available).',
    ],
  ])('limits the %s to the enabled Google integration', (_label, disclosure) => {
    expect(home).toContain(disclosure)
  })

  it('states the invitation-only comparison preview and planned self-hosting release', () => {
    expect(intro).toContain(
      'Hourmere Cloud is in an [invitation-only preview](/#faq) with sign-ups closed, and the open-source release for self-hosting is planned for November 30, 2026.',
    )
    expect(intro).not.toMatch(
      /in development and not yet ready to use|Hourmere Cloud has not launched/,
    )
  })

  it('keeps the comparison pinned public image and source alternative visible', () => {
    expect(intro).toContain(
      'Its [self-hosting guide](/docs/self-hosting) installs the published image pinned to an exact release version; building from source remains an alternative.',
    )
    expect(intro).not.toMatch(/no prebuilt public image is published/i)
  })

  it('explains scheduling and agent access in the homepage description alongside preview availability', () => {
    const source = read('./site.ts')
    expect(source).toContain(
      'Open-source scheduling software, an alternative to Calendly: share a booking link, let invitees pick a time, and let AI assistants book through an API and a remote MCP server. Hourmere Cloud is in an invitation-only preview at app.hourmere.com.',
    )
    expect(read('./pages/index.astro')).toContain('description={site.description}')
  })
})
