import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const source = (path: string) => readFileSync(join(root, path), 'utf8')
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
const read = (path: string) => normalize(source(path))
const zoomAcceptance =
  'Real-account acceptance was performed on 2026-10-19 against a Zoom development-mode app. Its scope was creating, rescheduling and cancelling a real meeting. Production Zoom Marketplace publication is a separate step for the hosted service; self-hosters use their own Zoom apps.'
const guides = [
  {
    path: 'docs/automatic-zoom.md',
    environment: 'a Zoom development-mode app',
    productionStep: 'Production Zoom Marketplace publication',
    ownApps: 'Zoom apps',
    acceptanceParagraph: `Automated validation uses synthetic providers/mail and helper-owned PostgreSQL. ${zoomAcceptance} Production deauthorization notification delivery still requires operator acceptance of the configured public app and endpoint.`,
  },
  {
    path: 'apps/site/src/content/docs/docs/zoom-connections.md',
    environment: 'a Zoom development-mode app',
    productionStep: 'Production Zoom Marketplace publication',
    ownApps: 'Zoom apps',
    acceptanceParagraph: zoomAcceptance,
  },
  {
    path: 'docs/automatic-google-meet.md',
    environment: 'a Google Cloud test project',
    productionStep: 'Google OAuth verification',
    ownApps: 'Google Cloud projects',
    acceptanceParagraph:
      'Real-account acceptance was performed on 2026-10-19 against a Google Cloud test project. Its scope was creating, rescheduling and cancelling a real meeting. Google OAuth verification is a separate step for the hosted service; self-hosters use their own Google Cloud projects.',
  },
]

// Only these exact, file-scoped sentences have been reviewed. Scan the whole page so a
// new publication/verification claim cannot hide outside the real-account paragraph.
const providerClaimAllowlist: Record<string, readonly string[]> = {
  'docs/automatic-zoom.md': [
    'A real Marketplace client must be separately configured and verified to honor both choices.',
    'Disconnecting retires credentials and may require explicit reconnection before a known meeting can be updated or removed; it does not revoke the whole Marketplace grant.',
    'Adding a Marketplace grant revocation would require a separate provider contract and policy, since a discarded exchange can concern an identity with an existing grant.',
    'Production Zoom Marketplace publication is a separate step for the hosted service; self-hosters use their own Zoom apps.',
    'Operator reports (not protocol guarantees): [missing deauthorization verification headers, March 2026](https://devforum.zoom.us/t/oauth-app-deauthorization-webhook-requests-missing-verification-headers-authorization-x-zm-signature/142352), [missing signing headers, August 2022](https://devforum.zoom.us/t/x-zm-signature-x-zm-request-timestamp-are-missed-in-deauthorization-webhook/73990).',
  ],
  'docs/automatic-google-meet.md': [
    'A collective Google Meet opt-in must explicitly select a current verified required host with an owned, Meet-capable Google destination.',
    'Google OAuth verification is a separate step for the hosted service; self-hosters use their own Google Cloud projects.',
  ],
  'apps/site/src/content/docs/docs/zoom-connections.md': [
    'A deployment administrator must separately register and approve a suitable user-authorized Zoom Marketplace OAuth client.',
    'Production Zoom Marketplace publication is a separate step for the hosted service; self-hosters use their own Zoom apps.',
    "Zoom's basic authorization query can include the required and optional scopes configured in Marketplace.",
    'Hourmere permits HTTP loopback for synthetic/local testing; whether a particular Marketplace client accepts that redirect and confidential PKCE combination must be verified separately with the real client.',
    'It retains the identity record for future references and does **not** revoke the entire Marketplace app grant.',
    'Protocol references, checked 19 October 2026: [Zoom OAuth](https://developers.zoom.us/docs/integrations/oauth/), [Zoom PKCE](https://developers.zoom.us/blog/public-pkce/), [advanced scope query](https://godevelopers.zoom.us/docs/integrations/oauth-scopes-overview/), [granular scopes](https://developers.zoom.us/docs/integrations/oauth-scopes-granular/), [webhook verification](https://developers.zoom.us/docs/api/webhooks/), [app deauthorization](https://developers.zoom.us/docs/integrations/end-user-auth/).',
  ],
  'docs/google-calendar.md': [
    'As the self-hoster, you own the Google Cloud project and are responsible for its branding, domains, privacy policy and any required [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).',
    'Each Google Cloud project is verified separately; a self-hosted instance uses your own project.',
    "Review Google's documented exceptions for personal or internal use before deciding whether verification is required.",
    'Only the stable Google account ID from the authenticated UserInfo endpoint identifies the external account; the returned email must be verified.',
    'Inspect the exact pinned Google event; verify the current booking is confirmed, its poll budget exhausted, the root UID matches and Google still reports a pending create request without a valid Meet link.',
  ],
  'apps/site/src/content/docs/docs/google-calendar.md': [
    "You, the self-hoster, are responsible for your Google project's branding, domains, privacy policy and any required [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).",
    'Each Google Cloud project is verified separately; a self-hosted instance uses your own project.',
  ],
  'apps/site/src/content/docs/docs/configuration.md': [
    "External unverified apps requesting sensitive or restricted scopes still have an **unverified app warning screen** and **100-user cap**, as explained in Google's [app state overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).",
    'The self-hoster is responsible for any required [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) for their project.',
    'Each Google Cloud project is verified separately; a self-hosted instance uses your own project.',
    'See [Google Calendar publishing requirements](/docs/google-calendar#publishing-status-and-verification) for recovery and exceptions.',
    '| | `CONFERENCE_ENCRYPTION_KEY` | Unset | Independent canonical 32-byte base64 key for conference credentials and OAuth verifiers.',
  ],
  'apps/site/src/content/docs/docs/self-hosting.md': [
    "External unverified apps requesting sensitive or restricted scopes still show an **unverified app warning screen** and have a **100-user cap**; see Google's [app state overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview).",
    'Follow the [Google Calendar publishing guide](/docs/google-calendar#publishing-status-and-verification) for verification requirements, exceptions and reconnecting expired grants.',
  ],
}

// Separate Markdown blocks before sentences to keep headings out of adjacent prose.
const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' })
const sentences = (text: string) =>
  text
    .split(/\r?\n\s*\r?\n/)
    .flatMap((paragraph) =>
      [...segmenter.segment(normalize(paragraph))].map(({ segment }) => normalize(segment)),
    )
const unapprovedProviderClaims = (text: string, allowed: readonly string[]) =>
  sentences(text).filter(
    (sentence) =>
      (/marketplace/i.test(sentence) ||
        (/\b(?:google|oauth)\b/i.test(sentence) && /verif/i.test(sentence))) &&
      !allowed.includes(sentence),
  )

describe('provider real-account acceptance documentation', () => {
  it.each(guides)('records the real-account acceptance date in $path', ({ path }) => {
    expect(read(path)).toContain('Real-account acceptance was performed on 2026-10-19')
  })

  it.each(guides)('bounds the accepted provider environment in $path', ({ path, environment }) => {
    expect(read(path)).toContain(`against ${environment}.`)
  })

  it.each(guides)(
    'limits acceptance to the real meeting lifecycle in $path',
    ({ path, environment }) => {
      expect(read(path)).toContain(
        `Real-account acceptance was performed on 2026-10-19 against ${environment}. Its scope was creating, rescheduling and cancelling a real meeting.`,
      )
    },
  )

  it.each(guides)(
    'keeps the complete acceptance paragraph bounded in $path',
    ({ path, acceptanceParagraph }) => {
      const acceptanceParagraphs = source(path)
        .split(/\r?\n\s*\r?\n/)
        .map(normalize)
        .filter((paragraph) => paragraph.includes('Real-account acceptance'))
      expect(acceptanceParagraphs).toEqual([acceptanceParagraph])
    },
  )

  it.each(guides)(
    'distinguishes the hosted production step in $path',
    ({ path, productionStep }) => {
      expect(read(path)).toContain(`${productionStep} is a separate step for the hosted service`)
    },
  )

  it.each(guides)('explains self-hosted app ownership in $path', ({ path, ownApps }) => {
    expect(read(path)).toContain(`self-hosters use their own ${ownApps}.`)
  })

  it.each([
    ['docs/automatic-zoom.md', 'No real Zoom client, grant or meeting was used'],
    ['docs/automatic-zoom.md', 'remain required before this branch can be merged'],
    ['docs/automatic-google-meet.md', 'Actual provider acceptance remains separately authorized'],
  ])('removes stale acceptance wording from %s: %s', (path, staleClaim) => {
    expect(read(path)).not.toContain(staleClaim)
  })
})

describe('provider publication and verification claims throughout documentation', () => {
  const pages = Object.entries(providerClaimAllowlist).map(([path, allowed]) => ({ path, allowed }))

  it.each(pages)(
    'allows only reviewed complete sentences throughout $path',
    ({ path, allowed }) => {
      expect(unapprovedProviderClaims(source(path), allowed)).toEqual([])
    },
  )

  const probes = pages.flatMap((page) =>
    [
      'The Zoom app is published on the Zoom Marketplace.',
      'Google has verified the OAuth app.',
      'The hosted app passed Google OAuth verification.',
      'The app is Marketplace-approved.',
      'The app is marketplace-approved.',
      'The app is MARKETPLACE-approved.',
      'Google has verified the app.',
      'The OAuth app has been verified.',
      'Verification of the hosted Google app is complete.',
      'The hosted Google OAuth app, i.e. its production configuration, passed verification.',
      'The hosted Google OAuth app, e.g. its production configuration, passed verification.',
      'The hosted gOoGlE app has been verified.',
      'The hosted oAuTh app has passed verification.',
    ].map((claim) => ({ ...page, claim })),
  )

  it.each(probes)('rejects a separate paragraph in $path: $claim', ({ path, allowed, claim }) => {
    expect(unapprovedProviderClaims(`${source(path)}\n\n${claim}\n`, allowed)).toEqual([claim])
  })

  it.each(probes)(
    'rejects a mid-paragraph insertion in $path: $claim',
    ({ path, allowed, claim }) => {
      const text = source(path)
      const paragraph = text
        .split(/\r?\n\s*\r?\n/)
        .find(
          (paragraph) =>
            /^[A-Z]/.test(paragraph) &&
            !paragraph.includes('Real-account acceptance') &&
            sentences(paragraph).length > 1,
        )
      expect(paragraph).toBeDefined()
      const [first, ...rest] = sentences(paragraph ?? '')
      const mutated = text.replace(paragraph ?? '', [first, claim, ...rest].join(' '))
      expect(unapprovedProviderClaims(mutated, allowed)).toEqual([claim])
    },
  )

  it.each(pages)('requires a complete sentence match in $path', ({ path, allowed }) => {
    for (const claim of [
      `The hosted app is approved: ${allowed[0]}`,
      `${allowed[0]}—the hosted app is fully approved.`,
    ]) {
      expect(unapprovedProviderClaims(`${source(path)}\n\n${claim}\n`, allowed)).toEqual([claim])
    }
  })

  it('keeps a reviewed sentence scoped to its own file', () => {
    const zoomPath = 'docs/automatic-zoom.md'
    const googlePath = 'docs/automatic-google-meet.md'
    const zoomAllowed = providerClaimAllowlist[zoomPath] ?? []
    const googleAllowed = providerClaimAllowlist[googlePath] ?? []
    const claim = zoomAllowed[0] ?? ''
    expect(claim).not.toBe('')
    expect(unapprovedProviderClaims(claim, zoomAllowed)).toEqual([])
    expect(unapprovedProviderClaims(`${source(googlePath)}\n\n${claim}\n`, googleAllowed)).toEqual([
      claim,
    ])
  })
})
