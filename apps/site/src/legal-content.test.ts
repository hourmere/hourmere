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
        /(?:repository|project|link).{0,35}(?:remains?|is|currently) private|private[- ]repository/i,
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
      for (const [url] of source.matchAll(/https?:\/\/github\.com\/[^\s)]+/g)) {
        expect(url).toMatch(/^https:\/\/github\.com\/(?:hourmere\/hourmere|calcom\/)/)
      }
      const links = [...source.matchAll(/\]\((\/docs\/[^)#]+)(?:#[^)]*)?\)/g)]
      expect(links.length).toBeGreaterThan(0)
      for (const [, path] of links) {
        expect(existsSync(new URL(`./content/docs${path}.md`, import.meta.url)), path).toBe(true)
      }
    })

    it(`${page} states development, image and Cloud launch limits in its sourced introduction`, () => {
      const source = read(`./content/docs/docs/${page}`)
      const intro = source.split(/^## /m)[0] ?? ''
      expect(intro).toMatch(/\[in development and not yet ready to use\]\(\/#faq\)/)
      expect(intro).not.toMatch(/README/)
      expect(intro).toMatch(/no prebuilt public image is published/)
      expect(intro).toContain('](/docs/self-hosting)')
      expect(intro).toMatch(/Hourmere Cloud has not launched\]\(\/privacy\)/)
    })
  }

  it('states the hosted preview, closed sign-ups and self-hosted release on the home page', () => {
    const home = read('./pages/index.astro')
    expect(home).toMatch(/<section[^>]*\sid="faq"/)
    const text = plainText(home)
    expect(text).toMatch(
      /Can I use Hourmere today\? Hourmere Cloud is in an invitation-only preview/,
    )
    expect(text).toContain('Sign-ups are currently closed.')
    expect(text).toContain(
      'The open-source release for self-hosting is planned for November 30, 2026.',
    )
    expect(home).toContain('href="https://app.hourmere.com"')
    expect(home).toContain('operated by {company.shortName}')
    expect(home).toContain('href="/privacy"')
    expect(home).toContain('href="/terms"')
    expect(text).not.toMatch(/Not yet\.|not available yet|no sign-up today|[Ii]n development/)
    expect(read('./site.ts')).not.toContain('adrian@cobaltmere.com')
  })

  it('describes MCP OAuth 2.1 as operator-enabled, not planned, on the home and terms pages', () => {
    const home = plainText(read('./pages/index.astro'))
    expect(home).toMatch(
      /through the API or the remote MCP server\. MCP clients can also connect with OAuth 2\.1 when the instance operator enables it\./,
    )
    expect(home).toMatch(
      /Agents can access your account only with an API key that you create or, for MCP clients when the instance operator enables it, an OAuth 2\.1 connection that you approve\./,
    )
    expect(home).toMatch(
      /AI assistants get access to your account only when you give them an API key or approve an OAuth connection\./,
    )
    const terms = plainText(read('./pages/terms.astro'))
    expect(terms).toMatch(
      /with an API key that you create or, for MCP clients when we enable it, an OAuth 2\.1 connection that you approve\./,
    )
    expect(terms).toMatch(
      /Actions that applications take with your API key or an OAuth connection you approve, such as booking/,
    )
    expect(terms).toMatch(
      /revoke a connected application's OAuth access at any time in Connected apps/,
    )
    expect(terms).toMatch(
      /do not give API keys to, or approve OAuth connections for, applications you do not trust/,
    )
    for (const page of [home, terms]) {
      expect(page).not.toMatch(
        /OAuth (?:authorization )?for AI connectors is planned|only with an API key that you create\.|only when you give them an API key\./,
      )
    }
  })

  it('displays the date from page metadata through the registered Starlight component', () => {
    expect(read('../astro.config.ts')).toMatch(/PageTitle:\s*['"].*DocsPageTitle\.astro/)
    expect(read('./content.config.ts')).toMatch(/lastVerified:\s*z\.iso\.date\(\)/)
    const title = read('./components/DocsPageTitle.astro')
    expect(title).toContain('Astro.locals.starlightRoute.entry.data')
    expect(title).toMatch(/<time datetime=\{lastVerified\}>\{lastVerified\}<\/time>/)
  })
})

describe('MCP quickstart authentication', () => {
  it('states API keys and operator-enabled OAuth 2.1 without an API-key-only claim', () => {
    const source = read('./content/docs/docs/mcp.md')
    const parts = source.split(/^## Connect with OAuth$/m)
    expect(parts).toHaveLength(2)
    expect(plainText(parts[0] ?? '')).toMatch(
      /accepts API keys and, when the instance operator enables it, organization-bound \[OAuth 2\.1 connections\]\(#connect-with-oauth\)/,
    )
    expect(source).not.toMatch(/no OAuth 2\.1 connector flow|OAuth-only client cannot connect/)
    expect(source).toContain(
      '| `list_calendar_connections` | No arguments; your connected account emails, calendar names and IDs, safe connection status, conflict settings and write destination. |',
    )
    expect(source).toContain(
      '| `list_conference_connections` | No arguments; your Zoom connection IDs, account email and display name, identity/meetings mode and safe status. |',
    )
  })
})

describe('privacy data-flow disclosures', () => {
  it('uses the publication date for privacy and leaves the terms date unchanged', () => {
    const terms = read('./pages/terms.astro')
    expect(privacy).toContain(
      'resolvePrivacyPublicationDate(import.meta.env.PRIVACY_PUBLICATION_DATE)',
    )
    expect(privacy).toContain('effective={publicationDate}')
    expect(privacy).toMatch(/\s lastUpdated\s/)
    expect(privacy).not.toMatch(/effective="\d{4}-\d{2}-\d{2}"/)
    expect(terms).toMatch(/effective="2026-11-30"/)
    for (const page of [privacy, terms, read('./content/docs/docs/comparison.md')]) {
      expect(plainText(page)).not.toMatch(/Draft for owner review|TODO|owner review|owner decision/)
    }
  })

  it('maps each processing purpose to a legal basis', () => {
    const uses = section('how-we-use-information')
    expect(uses).toMatch(/performance of our contract with you, which covers providing the Service/)
    expect(uses).toMatch(
      /legitimate interests in operating a secure and reliable service, which cover security, fraud and abuse prevention, and service improvement/,
    )
    expect(uses).toMatch(
      /compliance with legal obligations, which covers tax and accounting records/,
    )
    expect(uses).toMatch(/your consent, which covers marketing emails/)
  })

  it('distinguishes the hosted operator from the self-hosted operator', () => {
    expect(read('./site.ts')).toContain('Cobaltmere, LLC')
    expect(section('scope')).toMatch(/Hourmere Cloud.*(?:company\.(?:name|shortName)|Cobaltmere)/)
    expect(section('self-hosted')).toMatch(/operator.*(?:responsible|policy)/)
    expect(section('scope')).toContain('For Hourmere Cloud, the instance operator is Cobaltmere.')
    expect(plainText(privacy)).toContain(
      'the Hourmere cloud service that we host at app.hourmere.com ("Hourmere Cloud")',
    )
    expect(plainText(privacy)).toMatch(
      /This policy applies to that preview, including any Google user data it receives, and to this website\./,
    )
    expect(plainText(privacy)).not.toContain('the only personal data we receive')
  })

  it('locks the Google Limited Use commitment and Workspace AI statement', () => {
    const google = section('google-user-data')
    expect(google.replace(/\s+,/g, ',')).toContain(
      "Hourmere's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
    )
    expect(privacy).toContain('href={googlePolicies.userData}')
    expect(read('./site.ts')).toContain(
      'https://developers.google.com/terms/api-services-user-data-policy',
    )
    expect(google).toContain(
      'Hourmere does not use data obtained through Google Workspace APIs to develop, improve, or train generalized or non-personalized AI and/or ML models.',
    )
  })

  it('maps Google identity, calendar-list and synchronization scopes to their limited uses', () => {
    const google = section('google-user-data')
    expect(google).toMatch(/Sign in with Google requests openid , email and profile/)
    expect(google).toMatch(/separate step that requests: openid and email , to identify/)
    expect(google).toMatch(
      /calendar\.calendarlist\.readonly , to list your calendars.*primary-calendar status.*whether Google Meet is available/,
    )
    expect(google).toMatch(
      /when you enable synchronization, https:\/\/www.googleapis.com\/auth\/calendar.events.readonly , used only to read event identifiers, start and end times/,
    )
    expect(google).toMatch(
      /when you enable synchronization, https:\/\/www.googleapis.com\/auth\/calendar.events.owned , used only to create, update and cancel.*calendar you own and select.*Google Meet.*read those booking events back/,
    )
  })

  it('explains incremental busy synchronization and retention when synchronization stops', () => {
    const google = section('google-user-data')
    expect(google).toMatch(
      /three days before the current UTC day to 403 days \(about 13 months\) ahead/,
    )
    expect(google).toMatch(
      /about every minute using incremental updates and rebuilds the window daily/,
    )
    expect(google).toMatch(/Events overlapping the window can start before it or end after it/)
    expect(google).toMatch(
      /when you turn off conflict checks, stored busy intervals and sync data remain until.*disconnected in Hourmere, or you ask us to delete them/,
    )
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
    expect(google).toMatch(
      /showing you, and applications you authorize, the status of your calendar connection/,
    )
    expect(google).toMatch(
      /such as your availability or your connected Google account's email address and calendar names \(see section 6 ?\)/,
    )
  })

  it('explains Google local disconnect separately from provider revocation and retained bookings', () => {
    const google = section('google-user-data')
    expect(google).toMatch(
      /disconnect Google Calendar.*deletes the local connection.*active database/,
    )
    expect(google).toMatch(/does not automatically revoke Google's account-wide grant/)
    expect(google).toMatch(/Disconnecting does not delete them or an existing join link/)
    expect(google).toMatch(
      /When Hourmere detects the authorization failure, it marks the connection as needing reconnection; its stored connection data remains until you disconnect it in Hourmere or ask us to delete it/,
    )
    expect(privacy).toContain('href={googlePolicies.connections}')
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
    expect(agents).toMatch(
      /API keys can use permitted REST and MCP operations, including changing your calendar conflict and destination settings and refreshing or syncing your calendars/,
    )
    expect(agents).toMatch(
      /hosted bookings with attendee details and your calendar and Zoom connection details \(connected account email addresses, calendar names and settings, Zoom display name and connection status, without credentials\)/,
    )
    expect(agents).toMatch(/Availability, booking and connection data that Hourmere returns/)
    expect(agents).not.toMatch(/Availability and booking data/)
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

  it('discloses encrypted sign-in access and refresh tokens and that the ID token is not stored', () => {
    const collected = section('information-we-collect')
    expect(collected).toMatch(
      /Google or Microsoft:.*sign-in access and refresh tokens are stored encrypted; the ID token returned at sign-in is not stored\./,
    )
    expect(collected).not.toMatch(/sign-in OAuth tokens|stored as received/)
    const security = section('security')
    expect(security).toMatch(
      /encrypted storage of Google and Microsoft sign-in access and refresh tokens, calendar and Zoom connection tokens/,
    )
    expect(security).not.toMatch(/sign-in OAuth tokens/)
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
    expect(agents).toMatch(
      /When MCP OAuth is enabled, a background cleanup runs every 15 minutes and deletes OAuth access and refresh tokens one day after they expire, expired authorization attempts and client assertions, authorization grants left unfinished for more than one day, and dynamically registered clients that did not complete consent within 24 hours or have been unused for more than 90 days\./,
    )
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
    [
      'information-we-collect',
      /Hourmere Cloud is in an invitation-only preview and takes no payments yet; the billing description above applies once paid plans are available\./,
    ],
    [
      'sharing',
      /Hourmere Cloud is in an invitation-only preview and takes no payments yet; the payment-provider description above applies once paid plans are available\./,
    ],
  ] as const)('states preview payment limits in %s', (id, disclosure) => {
    expect(section(id)).toMatch(disclosure)
  })

  it('discloses actual hosted storage and on-host backups without unsupported safeguards', () => {
    expect(plainText(privacy)).not.toMatch(
      /Standard Contractual Clauses|intended to be hosted|European Union/,
    )
    for (const id of ['google-user-data', 'international-transfers']) {
      expect(section(id)).toMatch(/VPS in Los Angeles, United States, operated by BandwagonHost/)
      expect(section(id)).toContain('on-host backups')
    }
    const google = section('google-user-data')
    expect(google).toMatch(
      /Google Calendar connection access and refresh tokens are stored encrypted with AES-256-GCM/,
    )
    expect(google).toMatch(/Google sign-in access and refresh tokens are also stored encrypted/)
    expect(google).not.toMatch(/all data.*encrypted at rest/i)
    expect(section('retention')).toMatch(
      /daily on-host backups, kept for 7 days, and keeps 4 weekly copies/,
    )
    expect(section('retention')).toContain('Off-site backups are not yet in place.')
    expect(section('retention')).toMatch(
      /deleted data may remain in a retained backup until that copy is rotated out/,
    )
  })

  it('describes Stripe and Link payment processing conditionally in privacy and terms', () => {
    const conditional =
      /[Ww]hen you buy a paid plan, payments are processed by Stripe[.;] [Ff]or purchases made through Stripe's merchant-of-record service, your order is sold through Link, LLC, an affiliate of Stripe, which handles payment processing and applicable sales tax, VAT or GST\./
    const billing = block('li', 'Billing information')
    expect(billing).toMatch(/your plan, number of seats, billing country and transaction records/)
    expect(billing).toMatch(conditional)
    expect(billing).toMatch(/we do not store full card numbers/)
    const providers = block('li', 'Payment providers:')
    expect(providers).toMatch(conditional)
    expect(providers).toMatch(/independent controllers for their own purposes/)
    const terms = plainText(read('./pages/terms.astro'))
    expect(terms).toMatch(/Hourmere Cloud has not launched and paid plans are not yet available\./)
    expect(terms).toMatch(conditional)
    for (const page of [plainText(privacy), terms]) {
      expect(page).not.toMatch(
        /Payments are processed by Stripe|Stripe and Link, LLC, an affiliate of Stripe, process payments/,
      )
    }
  })

  it('discloses widget submission and excludes booking details from parent messages', () => {
    const website = section('this-website')
    expect(website).toMatch(/Booking details you enter are sent directly to that Hourmere instance/)
    expect(website).toMatch(/does not require an account or third-party cookies/)
    expect(website).toMatch(
      /Messages from the frame.*not booking identifiers, names, email addresses, answers, management tokens or join links/,
    )
  })

  it('describes current cleanup and one-month deletion responses without other retention promises', () => {
    const retention = section('retention')
    expect(retention).toMatch(/does not currently run other automatic deletion schedules/)
    expect(retention).toMatch(
      /ask about or request deletion of the data \{company\.shortName\} holds about you by emailing .*we respond within one month/,
    )
    expect(retention).not.toMatch(/\d+ years|owner/)
    expect(section('google-user-data')).toMatch(
      /Deletion requests: you can ask about or request deletion of the Google sign-in data and other account data we hold by emailing .*we respond within one month/,
    )
  })
})
