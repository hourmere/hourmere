import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const plainText = (source: string) =>
  source
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const privacy = read('./pages/privacy.astro')
const blocks = (tag: 'p' | 'li') =>
  [...privacy.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map(
    (match) => plainText(match[1] ?? ''),
  )
const block = (tag: 'p' | 'li', text: string) => {
  const found = blocks(tag).find((value) => value.includes(text))
  expect(found, `Missing privacy disclosure: ${text}`).toBeDefined()
  return found ?? ''
}
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

    it(`${page} uses public site documentation for Hourmere claims`, () => {
      const source = read(`./content/docs/docs/${page}`)
      expect(source).not.toMatch(/https?:\/\/github\.com\/cobaltmere\/hourmere(?:\/|\b)/)
      const links = [...source.matchAll(/\]\((\/docs\/[^)#]+)(?:#[^)]*)?\)/g)]
      expect(links.length).toBeGreaterThan(0)
      for (const [, path] of links) {
        expect(existsSync(new URL(`./content/docs${path}.md`, import.meta.url)), path).toBe(true)
      }
    })

    it(`${page} states development, image and Cloud launch limits in its sourced introduction`, () => {
      const source = read(`./content/docs/docs/${page}`)
      const intro = source.split(/^## /m)[0] ?? ''
      expect(intro).toMatch(/README.*early development and not yet ready to use/)
      expect(intro).toMatch(/no prebuilt public image is published/)
      expect(intro).toContain('](/docs/self-hosting)')
      expect(intro).toMatch(/Hourmere Cloud has not launched\]\(\/privacy\)/)
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
    expect(section('scope')).toContain('For Hourmere Cloud, the instance operator is Cobaltmere.')
  })

  it('discloses Google busy data, limited booking writes and encrypted credentials', () => {
    const google = section('google-user-data')
    expect(google).toMatch(/event identifiers, start and end times/)
    expect(google).toMatch(/Busy-time synchronization does not request or store event titles/)
    const copy = block('li', 'ordinary booking copy contains')
    expect(copy).toMatch(/booking title, which includes the invitee's name/)
    expect(copy).toMatch(/start and end times/)
    expect(copy).toMatch(
      /does not send email addresses, guest names, attendee lists, booking answers or private management links/,
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
    const meet = block('p', 'For Google Meet,')
    expect(meet).toMatch(/sends Google the booking title, which includes the invitee's name/)
    expect(meet).toMatch(/start and end times/)
    const zoom = block('p', 'Zoom authorization is separate')
    expect(zoom).toMatch(/sends Zoom the booking title, which includes the invitee's name/)
    expect(zoom).toMatch(/meeting topic, start time, duration and.*UTC/)
    for (const request of [meet, zoom]) {
      expect(request).toMatch(
        /do(?:es)? not send email addresses, guest names, attendee lists, booking answers or (?:private )?management links/,
      )
      expect(request).not.toMatch(/not send attendee names/)
    }
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

  it('discloses encrypted sign-in OAuth tokens in collection and security sections', () => {
    expect(section('information-we-collect')).toMatch(
      /Google or Microsoft:.*sign-in OAuth tokens.*stored encrypted/,
    )
    expect(section('security')).toMatch(
      /encrypted storage of Google and Microsoft sign-in OAuth tokens/,
    )
  })

  it('discloses the organizer identity retained with conference records', () => {
    expect(block('li', 'Conference information:')).toMatch(
      /organizer(?:'s)? name and email(?: address)? used for invitations/,
    )
  })

  it('describes encrypted sign-in email storage and five-minute expiry cleanup', () => {
    const signIn = block('li', 'Email sign-in:')
    expect(signIn).toMatch(/expires after 5 minutes/)
    expect(signIn).toMatch(/Queued sign-in emails store the recipient and link encrypted/)
    expect(signIn).toMatch(/deleted after delivery, or when expiry is detected/)
    expect(signIn).toMatch(/delivery worker or periodic cleanup/)
  })

  it('distinguishes MCP OAuth token lifetimes from record retention', () => {
    const agents = block('li', 'API and agent access:')
    expect(agents).toMatch(/MCP OAuth access tokens.*5 minutes/)
    expect(agents).toMatch(/refresh tokens.*30 days/)
    expect(agents).not.toMatch(/records.*deleted.*30 days/)
  })

  it('discloses webhook payload deletion by creation age and earlier endpoint deletion', () => {
    const sharing = section('sharing')
    expect(sharing).toMatch(
      /cleanup deletes webhook delivery records, including their payloads, after 30 days from creation/,
    )
    expect(sharing).toMatch(/(?:Deleting|deleting) the endpoint deletes.*sooner/)
  })

  it('discloses minimal job payloads and default seven-day completion cleanup', () => {
    const jobs = block('li', 'Background jobs:')
    expect(jobs).toMatch(/(?:identifiers|IDs).*job-control fields/)
    expect(jobs).toMatch(/Completed job records are deleted after 7 days by default/)
    expect(jobs).toMatch(/sign-in.*(?:sooner|earlier)/i)
  })

  it.each([
    ['information-we-collect', /TODO for owner before publication:.*Stripe.*Link/],
    ['sharing', /TODO for owner before publication:.*Stripe.*Link/],
    ['how-we-use-information', /TODO for owner before publication:.*legal bases/],
    [
      'international-transfers',
      /TODO for owner before publication:.*hosting.*Standard Contractual Clauses/,
    ],
  ] as const)('marks unconfirmed policy choices visibly in %s', (id, disclosure) => {
    const start = privacy.indexOf(`<h2 id="${id}">`)
    const end = privacy.indexOf('<h2 id=', start + 1)
    const source = privacy.slice(start, end === -1 ? undefined : end)
    const callouts = [...source.matchAll(/<p class="callout">([\s\S]*?)<\/p>/g)]
    expect(callouts.some((match) => disclosure.test(plainText(match[1] ?? '')))).toBe(true)
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
      /does not establish those undecided periods or promise a backup-deletion deadline/,
    )
    expect(retention).not.toMatch(/(?:\d+|thirty) days|\d+ years/)
  })
})
