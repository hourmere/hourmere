import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const plainText = (source: string) =>
  source
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const privacy = read('./pages/privacy.astro')
const section = (id: string) => {
  const start = privacy.indexOf(`<h2 id="${id}">`)
  expect(start, `Missing privacy section: ${id}`).toBeGreaterThan(-1)
  const end = privacy.indexOf('<h2 id=', start + 1)
  return plainText(privacy.slice(start, end === -1 ? undefined : end))
}

// These are disclosure boundaries, rather than a snapshot of the owner's draft wording.
describe('comparison review information', () => {
  const pages = readdirSync(new URL('./content/docs/docs/', import.meta.url)).filter((name) =>
    /^comparison.*\.mdx?$/.test(name),
  )

  it('has comparison pages to check', () => {
    expect(pages.length).toBeGreaterThan(0)
  })

  for (const page of pages) {
    it(`${page} has one verification date and no duplicate date in its prose`, () => {
      const source = read(`./content/docs/docs/${page}`)
      const dates = [...source.matchAll(/^lastVerified: ['"]?(\d{4}-\d{2}-\d{2})['"]?$/gm)]
      expect(dates).toHaveLength(1)
      const date = dates[0]?.[1]
      expect(Temporal.PlainDate.from(date ?? '').toString()).toBe(date)
      expect(source.match(/\b\d{4}-\d{2}-\d{2}\b/g)).toHaveLength(1)
      expect(source).not.toMatch(/(?:checked|verified) on [A-Z][a-z]+ \d/i)
      expect(source).not.toMatch(
        /(?:repository|project|link).{0,35}(?:remains?|is|currently) private/i,
      )
    })

    it(`${page} identifies trademark owners with primary sources and disclaims endorsement`, () => {
      const source = read(`./content/docs/docs/${page}`)
      expect(source).toMatch(/Calendly is a trademark of Calendly, LLC/)
      expect(source).toMatch(/Cal\.com is a trademark of Cal\.com, Inc\./)
      expect(source).toMatch(/Cal\.diy is a trademark of Cal\.com, Inc\./)
      expect(source).toContain('[Cal.diy trademark notice](https://www.cal.diy/)')
      expect(source).toMatch(/https:\/\/calendly\.com\/legal\//)
      expect(source).toContain('https://cal.com/shop')
      expect(source).toMatch(/not affiliated with or endorsed by/i)
    })
  }

  it('displays the date from page metadata through the registered Starlight component', () => {
    expect(read('../astro.config.ts')).toMatch(/PageTitle:\s*['"].*DocsPageTitle\.astro/)
    expect(read('./content.config.ts')).toMatch(/lastVerified:\s*z\.iso\.date\(\)/)
    const title = read('./components/DocsPageTitle.astro')
    expect(title).toContain('Astro.locals.starlightRoute.entry.data')
    expect(title).toMatch(/<time datetime=\{lastVerified\}>\{lastVerified\}<\/time>/)
  })
})

describe('privacy data-flow disclosures', () => {
  it('marks the wording as a draft requiring owner approval', () => {
    expect(plainText(privacy)).toMatch(/Draft for owner review:.*approval before.*published/)
  })

  it('distinguishes the hosted operator from the self-hosted operator', () => {
    expect(read('./site.ts')).toContain('Cobaltmere, LLC')
    expect(section('scope')).toMatch(/Hourmere Cloud.*(?:company\.(?:name|shortName)|Cobaltmere)/)
    expect(section('self-hosted')).toMatch(/operator.*(?:responsible|policy)/)
  })

  it('discloses Google busy data, limited booking writes and encrypted credentials', () => {
    const google = section('google-user-data')
    expect(google).toMatch(/event identifiers, start and end times/)
    expect(google).toMatch(/Busy-time synchronization does not request or store event titles/)
    expect(google).toMatch(/ordinary booking copy contains.*title.*start and end times/)
    expect(google).toMatch(
      /does not send an attendee list, booking answers or private management links/,
    )
    expect(google).toMatch(/tokens are stored encrypted/)
  })

  it('explains Google local disconnect separately from provider revocation and retained bookings', () => {
    const google = section('google-user-data')
    expect(google).toMatch(
      /disconnect Google Calendar.*deletes the local connection.*active database/,
    )
    expect(google).toMatch(/does not automatically revoke Google's account-wide grant/)
    expect(google).toMatch(/Disconnecting does not delete them or an existing join link/)
  })

  it('describes Microsoft as list-only with encrypted tokens and separate grant revocation', () => {
    const microsoft = section('microsoft-calendar-data')
    expect(microsoft).toMatch(/calendar list containing identifiers/)
    expect(microsoft).toMatch(
      /does not read event times or busy intervals, synchronize events, or write booking events/,
    )
    expect(microsoft).toMatch(/access and refresh tokens are stored encrypted/)
    expect(microsoft).toMatch(/Disconnecting deletes the local connection/)
    expect(microsoft).toMatch(/does not automatically revoke the provider-side grant/)
  })

  it('explains the scope and revocation of API keys and optional MCP OAuth', () => {
    const agents = section('ai-assistants')
    expect(agents).toMatch(
      /API key.*when enabled by the instance operator, an MCP OAuth connection/,
    )
    expect(agents).toMatch(/selected organization, subject to your current permissions/)
    expect(agents).toMatch(/hosted bookings with attendee details/)
    expect(agents).toMatch(
      /MCP OAuth does not grant REST API access or account or API-key administration/,
    )
    expect(agents).toMatch(/revoke.*API key.*MCP OAuth grant in Connected apps/)
    expect(agents).toMatch(/does not retrieve information the application has already received/)
    expect(agents).not.toMatch(/OAuth.*planned/)
  })

  it('discloses automatic conference payloads and join-link storage and recipients', () => {
    const sharing = section('sharing')
    expect(sharing).toMatch(/Google Meet.*sends Google the booking title, start and end times/)
    expect(sharing).toMatch(
      /sends Zoom the booking title as the meeting topic, start time, duration and time zone/,
    )
    expect(sharing).toMatch(/stores the validated participant join link with the protected booking/)
    expect(sharing).toMatch(/emails and ICS attachments can reveal the join link/)
    expect(sharing).toMatch(/Public event-type catalogs and webhook payloads do not include it/)
    expect(sharing).toMatch(/Disconnecting Zoom clears local credentials/)
    expect(sharing).toMatch(
      /does not automatically revoke Zoom's provider-side grant or delete existing provider meetings/,
    )
  })

  it('describes signed organization webhooks and the excluded personal data', () => {
    const sharing = section('sharing')
    expect(sharing).toMatch(
      /organization owners and administrators can configure recipients for signed HTTPS notifications/,
    )
    expect(sharing).toMatch(/payload contains.*identifiers, timestamps, booking status and source/)
    expect(sharing).toMatch(/does not include names, email addresses, attendees, booking answers/)
    expect(sharing).toMatch(/organization chooses the receiving services/)
  })

  it('distinguishes email contents and ICS attachments from private management links', () => {
    const sharing = section('sharing')
    expect(sharing).toMatch(/configured email service/)
    expect(sharing).toMatch(/Host emails include the invitee's contact details, guests and answers/)
    expect(sharing).toMatch(/private management links go only to the invitee/)
    expect(sharing).toMatch(
      /ICS calendar attachments.*organizer and attendee names and email addresses/,
    )
    expect(sharing).toMatch(
      /attachments do not contain private management links or booking answers/,
    )
  })

  it('discloses widget submission and excludes booking details from parent messages', () => {
    const website = section('this-website')
    expect(website).toMatch(/Booking details you enter are sent directly to that Hourmere instance/)
    expect(website).toMatch(/does not require an account or third-party cookies/)
    expect(website).toMatch(
      /Messages from the frame.*not booking identifiers, names, email addresses, answers, management tokens or join links/,
    )
  })

  it('leaves undecided retention schedules as owner TODOs', () => {
    const retention = section('retention')
    expect(retention).toMatch(
      /TODO for owner before publication:.*retention periods.*backup copies/,
    )
    expect(retention).toMatch(
      /does not establish those periods or promise a backup-deletion deadline/,
    )
    expect(retention).not.toMatch(/(?:\d+|thirty) days|\d+ years/)
  })
})
