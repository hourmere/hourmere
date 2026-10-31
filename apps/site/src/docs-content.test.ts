import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const siteDocs = 'apps/site/src/content/docs/docs'
const pages = globSync('**/*.md', { cwd: join(root, siteDocs) }).map((path) => ({
  path,
  source: read(`${siteDocs}/${path}`),
}))
const githubDocs = 'https://github.com/hourmere/hourmere/blob/main/docs/'
const normalize = (source: string) => source.replace(/\s+/g, ' ')
const prose = (source: string) =>
  normalize(source.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`]/g, ''))
const repositoryDocs = globSync('**/*.md', { cwd: join(root, 'docs') }).map(
  (path) => `docs/${path}`,
)

// These complete lines describe Hourmere's own website, hosted attribution or legal pages.
// Keep exceptions scoped to their file and purpose, so a new self-hosting example still fails.
const ownSiteReferences: Record<string, readonly string[]> = {
  'README.md': [
    '| `apps/site` | Website for hourmere.com (Astro + Starlight): homepage, legal pages, docs. Static; not part of the Docker image. |',
    'The website runs on its own: `npm run dev --workspace @hourmere/site` (http://localhost:4321). `npm run build` writes it to `apps/site/dist`. A small Cloudflare Worker handles the Hourmere Cloud waitlist and serves the static assets on hourmere.com and www.hourmere.com (config in `apps/site/wrangler.jsonc`). The D1 database already exists. See [website operations](docs/website.md) for local D1/form testing and the migration the lead must apply before running `npm run deploy --workspace @hourmere/site` in the Cobaltmere Cloudflare account.',
    'hosted service. `HOSTED_SIGNUP_URL` sets their destination (default `https://hourmere.com`);',
    'instance must explicitly set `https://hourmere.com/privacy` and `https://hourmere.com/terms`.',
    '[security@hourmere.com](mailto:security@hourmere.com), not in a public issue. See [SECURITY.md](SECURITY.md).',
  ],
  'docs/website.md': [
    '`Origin` is mandatory: only `https://hourmere.com` and',
    '`https://www.hourmere.com` are accepted in production. Loopback development is',
    '3. Confirm the existing custom-domain routes **`hourmere.com`** and',
    '**`www.hourmere.com`**, and the **`ASSETS`** binding with API worker-first',
    'For an individual deletion/withdrawal request sent to `hello@hourmere.com`,',
  ],
  '.env.example': [
    'HOSTED_SIGNUP_URL=https://hourmere.com',
    '# For the hosted instance, set https://hourmere.com/privacy and https://hourmere.com/terms.',
  ],
  'docker-compose.yml': [`HOSTED_SIGNUP_URL: \${HOSTED_SIGNUP_URL:-https://hourmere.com}`],
  'tools/cli/README.md': [
    'Command-line scheduling for [Hourmere](https://hourmere.com), an open-source scheduling',
  ],
  [`${siteDocs}/api-conventions.md`]: [
    'with `HOSTED_SIGNUP_URL` and defaulting to `https://hourmere.com`.',
  ],
  'docs/mcp-directories.md': [
    "`com.hourmere/hourmere` requires proof of control of `hourmere.com` via the registry's",
  ],
  'docs/releasing.md': [
    'The website publishes `apps/site/public/.well-known/security.txt` on hourmere.com and',
    "www.hourmere.com. Application instances do not publish Hourmere's policy. Review its",
  ],
  [`${siteDocs}/configuration.md`]: [
    '| `HOSTED_SIGNUP_URL` | `https://hourmere.com` | Hosted service destination for public attribution and confirmation links. Set the hosted sign-up page URL when available; HTTP(S), no credentials, query or fragment. Independent of this instance’s `PUBLIC_URL`; attribution cannot be disabled. |',
    'PRIVACY_POLICY_URL=https://hourmere.com/privacy',
    'TERMS_URL=https://hourmere.com/terms',
  ],
  [`${siteDocs}/index.md`]: [
    'The website at hourmere.com is separate from your Hourmere instance.',
    "to [security@hourmere.com](mailto:security@hourmere.com) or through the repository's",
  ],
  [`${siteDocs}/self-hosting.md`]: [
    "and defaults to `https://hourmere.com`, independently of your instance's `PUBLIC_URL`. Set",
  ],
}

describe('public-language documentation', () => {
  it('discloses public and email support without expanding the account interface languages', () => {
    const languages = prose(read(`${siteDocs}/interface-languages.md`))
    expect(languages).toContain(
      'emails are available in English, Simplified Chinese, German, French, Spanish and Brazilian Portuguese.',
    )
    expect(languages).toContain('interfaces remain available in English and Simplified Chinese.')
    expect(languages).toContain(
      'German, French, Spanish and Brazilian Portuguese translations are AI-assisted (machine-translated)',
    )
    expect(languages).toContain('have not yet been reviewed by a native speaker')
    expect(languages).toContain('Corrections are welcome through a GitHub issue or pull request.')
    expect(languages).toContain('Changing the language updates the existing page')
  })

  it('documents one Spanish formatting convention and the regional mapping without changing zones', () => {
    const languages = prose(read(`${siteDocs}/interface-languages.md`))
    for (const regional of ['es-ES', 'es-MX', 'es-419', 'es-AR', 'es-CO', 'es-US'])
      expect(languages).toContain(regional)
    expect(languages).toContain('resolve to es. Spanish uses one formatting locale, es-ES')
    expect(languages).toContain('Gregorian date and 24-hour time formatting')
    expect(languages).toContain('choice does not change the selected IANA time zone.')
    const notifications = prose(read(`${siteDocs}/notifications.md`))
    expect(notifications).toContain('German, French, Spanish and Brazilian Portuguese')
    expect(notifications).toContain('es-US map to es and use es-ES date and time formatting')
    expect(notifications).toContain('without changing the recipient time zone.')
    expect(prose(read(`${siteDocs}/embedding.md`))).toContain('es for Spanish')
  })

  it('documents Brazilian formatting and excludes European Portuguese from Brazilian text', () => {
    const languages = prose(read(`${siteDocs}/interface-languages.md`))
    expect(languages).toContain('pt-BR and bare pt resolve to pt-BR')
    expect(languages).toContain('Latin-script Portuguese variants such as pt-AO')
    expect(languages).toContain(
      'European Portuguese (pt-PT) is excluded: it is skipped in favor of the next supported preference, or English when there is none',
    )
    expect(languages).toContain(
      'Brazilian Portuguese uses pt-BR Gregorian date and 24-hour time formatting without changing the selected IANA time zone.',
    )
    const notifications = prose(read(`${siteDocs}/notifications.md`))
    expect(notifications).toContain(
      'European Portuguese (pt-PT) is unsupported and falls through to the next supported language choice, then English',
    )
    expect(notifications).toContain('The recipient time zone stays unchanged.')
    const embedding = prose(read(`${siteDocs}/embedding.md`))
    expect(embedding).toContain('pt-BR for Brazilian Portuguese.')
    expect(embedding).toContain('are the accepted explicit values; an invalid value fails')
    const mail = prose(read('packages/mail/README.md'))
    expect(mail).toContain('pt-BR, bare pt and other Latin-script Portuguese variants')
    expect(mail).toContain(
      'European Portuguese (pt-PT) is excluded and falls through to the next supported language choice, then English',
    )
  })
})

describe('self-hosting documentation links', () => {
  it.each(pages)('uses clickable repository documentation links in $path', ({ source }) => {
    const remaining = source.replace(/\[[^\]]+\]\(([^)\s]+)\)/g, (link, target: string) => {
      if (!target.startsWith(githubDocs)) return link
      const file = target.slice(githubDocs.length).split('#')[0]
      expect(existsSync(join(root, 'docs', file ?? '')), target).toBe(true)
      return ''
    })
    expect(remaining).not.toMatch(/\bdocs\/[\w./-]+\.md\b/)
  })

  // Rendered site links and anchors are checked against actual build output in build-output.test.ts.
  it.each(['README.md', ...repositoryDocs])('uses canonical docs links in %s', (path) => {
    const source = read(path)
    expect(source).not.toMatch(
      /(?:(?<![\w.-])hourmere\.com|[(\s"'`])\/docs(?:\/[\w-]+)*\/(?=[?#\s"'`)<>{}]|$)/i,
    )
  })

  it.each(['google-calendar', 'mcp', 'embedding'])(
    'uses the canonical instance hostname in the %s guide',
    (guide) => {
      const source = read(`${siteDocs}/${guide}.md`)
      expect(source).toContain('https://hourmere.example.com')
      expect(source).not.toMatch(/\b(?:meet|calendar)\.example\.com\b/)
    },
  )

  it('uses the canonical MCP documentation URL in registry metadata', () => {
    expect(JSON.parse(read('server.json')).websiteUrl).toBe('https://hourmere.com/docs/mcp')
  })

  it.each([
    'README.md',
    'Caddyfile',
    '.env.example',
    'scripts/setup.sh',
    'tools/cli/README.md',
    ...globSync('docker-compose*.yml', { cwd: root }),
    ...repositoryDocs,
    ...pages.map(({ path }) => `${siteDocs}/${path}`),
  ])('keeps production application hosts out of examples in %s', (path) => {
    const allowed = ownSiteReferences[path] ?? []
    const source = read(path)
      .split('\n')
      .filter((line) => !allowed.includes(line.trim()))
      .join('\n')
    // Public documentation URLs are site destinations, rather than application-host examples.
    const examples = source.replace(
      /https:\/\/hourmere\.com\/docs(?:\/[\w-]+)?(?:#[\w-]+)?/g,
      (target) => {
        const page = target.replace('https://hourmere.com/docs', '').split('#')[0] || '/index'
        expect(existsSync(join(root, siteDocs, `${page.slice(1)}.md`)), target).toBe(true)
        return ''
      },
    )
    expect(examples).not.toMatch(/(?<![\w.-])(?:[\w-]+\.)*hourmere\.com(?![\w-]|\.[\w-])/i)
  })

  it.each([
    'cli',
    'webhooks',
    'automatic-google-meet',
    'automatic-zoom',
    'collective-scheduling',
    'round-robin-scheduling',
    'notifications',
  ])('makes the %s guide discoverable from the docs overview', (guide) => {
    expect(read(`${siteDocs}/index.md`)).toContain(`](/docs/${guide})`)
  })
})

describe('launch documentation disclosures', () => {
  it('keeps the docs overview consistent with the planned release and Cloud preview', () => {
    const intro = prose(read(`${siteDocs}/index.md`).split(/^## /m)[0] ?? '')
    expect(intro).toMatch(/no stable release yet/i)
    expect(intro).toContain('2026-11-30')
    expect(intro).toMatch(/release.*planned|planned.*release/i)
    expect(intro).toMatch(/Hourmere Cloud is (?:in )?an invitation-only preview/)
    expect(intro).not.toMatch(/no.*hosted booking service|stable release is available/i)
  })

  it('records the comparison claims re-verification date', () => {
    expect(read(`${siteDocs}/comparison.md`)).toMatch(/^lastVerified: '2026-10-20'$/m)
  })

  const limitations = [
    {
      topic: 'Microsoft calendar scope and acceptance',
      claims: [
        /Microsoft [Cc]alendars? lists? (?:calendars )?only/,
        /(?:no|without) busy-time sync(?:hronization)? or event writes/,
        /Microsoft sign-in and calendar connections have not had real-account acceptance/,
      ],
    },
    {
      topic: 'automatic Zoom host scope',
      claims: [
        /Automatic Zoom supports personal event types and individual team event types with one actual host/,
        /collective and round-robin event types are unsupported/,
      ],
    },
    {
      topic: 'calendar RSVP and cancellation',
      claims: [
        /Calendar RSVP replies are not processed/,
        /declining in a calendar does not cancel (?:a|an Hourmere) booking/,
      ],
    },
    {
      topic: 'database requirements',
      claims: [/PostgreSQL 18\+ is required/, /PgBouncer is unsupported/],
    },
    {
      topic: 'deployment origin and bundled proxy scope',
      claims: [
        /Hourmere must be served at the root of its own host name \(no path prefix\) in every deployment/,
        /Bundled Caddy additionally requires ports 80\/443, an HTTPS host name without a port, and an IPv4-only ingress network/,
      ],
    },
    {
      topic: 'single web process for in-memory rate limits',
      claims: [
        /Rate limiting uses in-process memory/,
        /multiple web replicas multiply the limits/,
        /Run a single web process; a separate worker is supported/,
      ],
    },
    {
      topic: 'interface languages',
      claims: [
        /Public booking pages and emails support English, Simplified Chinese, German, French, Spanish and Brazilian Portuguese/,
        /Account and sign-in interfaces support English and Simplified Chinese/,
      ],
    },
    {
      topic: 'downgrade and migration compatibility',
      claims: [
        /Schema downgrade is not automatic|No automatic schema downgrade/,
        /[Ss]ome migrations (?:are not rolling-upgrade safe: stop|require stopping) all old app and worker processes/,
      ],
    },
  ]

  for (const path of ['README.md', 'CHANGELOG.md', `${siteDocs}/index.md`]) {
    const section = read(path)
      .split(/^#{2,3} Known limitations\n/m)[1]
      ?.split(/^#{2,3} /m)[0]

    it(`consolidates limitations with documentation links in ${path}`, () => {
      expect(read(path).match(/^#{2,3} Known limitations$/gm)).toHaveLength(1)
      expect(section).toMatch(/\[[^\]]+\]\([^)]+\)/)
      if (path === 'CHANGELOG.md') {
        expect(read(path).split('## [Unreleased → 1.0.0]')[1]).toContain('### Known limitations')
      }
    })

    it.each(limitations)(`discloses $topic in ${path}`, ({ claims }) => {
      for (const claim of claims) expect(prose(section ?? '')).toMatch(claim)
    })

    it(`limits the missing real-account acceptance disclosure to Microsoft in ${path}`, () => {
      const statements = prose(section ?? '').match(/[^.]*have not had real-account acceptance\./g)
      expect(statements).toHaveLength(1)
      expect(statements?.[0]).toMatch(/Microsoft sign-in and calendar connections/)
      expect(statements?.[0]).not.toMatch(/Zoom|Meet|Google/)
    })
  }

  it('links the changelog database requirements to a section that requires PostgreSQL 18', () => {
    const target = read('CHANGELOG.md').match(/\[database requirements\]\(([^)]+)\)/)?.[1]
    expect(target).toBe(
      'https://github.com/hourmere/hourmere/blob/main/apps/site/src/content/docs/docs/configuration.md#server-and-database',
    )
    const section = read(`${siteDocs}/configuration.md`)
      .split('## Server and database\n')[1]
      ?.split('\n## ')[0]
    expect(prose(section ?? '')).toMatch(
      /PostgreSQL 18\+ is required because migrations use uuidv7\(\)/,
    )
  })
})

describe('Google self-hosting guidance', () => {
  const paths = [
    `${siteDocs}/google-calendar.md`,
    `${siteDocs}/configuration.md`,
    `${siteDocs}/self-hosting.md`,
  ]

  it.each(paths)('explains Testing token expiry with an official source in %s', (path) => {
    const source = normalize(read(path))
    expect(source).toContain('**Testing**')
    expect(source).toContain('**7 days**')
    expect(source).toContain('https://developers.google.com/identity/protocols/oauth2#expiration')
    expect(source).toContain('**In production**')
  })

  it.each(paths)('explains unverified-app limits and operator responsibility in %s', (path) => {
    const source = normalize(read(path))
    expect(source).toContain('**unverified app warning screen**')
    expect(source).toContain('**100-user cap**')
    expect(source).toContain(
      'https://developers.google.com/identity/protocols/oauth2/production-readiness/overview',
    )
    expect(source).toMatch(/(?:self-hoster.*?responsib|responsib.*?self-hoster)/i)
    expect(source).toContain('sensitive-scope verification')
  })

  it('walks through the separate Google sign-in client configuration', () => {
    const source = read(`${siteDocs}/configuration.md`)
      .split('### Sign in with Google\n')[1]
      ?.split('\n### ')[0]
    expect(source).toBeDefined()
    expect(source).toMatch(
      /1\. .*project[\s\S]*2\. .*Data Access[\s\S]*3\. .*Clients[\s\S]*4\. .*client ID[\s\S]*5\. .*\/sign-in/,
    )
    for (const value of [
      'Web application',
      '`<PUBLIC_URL>/api/auth/callback/google`',
      '`openid`',
      '`email`',
      '`profile`',
      '`GOOGLE_CLIENT_ID`',
      '`GOOGLE_CLIENT_SECRET`',
      '`PUBLIC_URL`',
      'docker compose up -d --wait',
    ]) {
      expect(source).toContain(value)
    }
    expect(source).toContain('no offline access')
  })
})

describe('self-hosting troubleshooting', () => {
  const source = read(`${siteDocs}/troubleshooting.md`)
  const section = (heading: string) =>
    normalize(source.split(`## ${heading}\n`)[1]?.split('\n## ')[0] ?? '')

  it('is linked from the sidebar, overview and operator guides', () => {
    expect(read('apps/site/astro.config.ts')).toContain(
      "{ label: 'Troubleshooting', link: '/docs/troubleshooting' }",
    )
    for (const page of ['index', 'self-hosting', 'configuration']) {
      expect(read(`${siteDocs}/${page}.md`)).toMatch(/\]\(\/docs\/troubleshooting(?:#[\w-]+)?\)/)
    }
  })

  it.each([
    {
      topic: 'sender authentication',
      heading: 'Sign-in emails do not arrive or go to spam',
      required: ['**SPF**', '**DKIM**', '**DMARC**', 'verified sending domain'],
    },
    {
      topic: 'transactional delivery and consumer sender domains',
      heading: 'Sign-in emails do not arrive or go to spam',
      required: [
        'transactional email provider',
        '`MAIL_FROM`',
        '`@gmail.com`',
        '`@outlook.com`',
        '`@yahoo.com`',
      ],
    },
    {
      topic: 'email registration and expiry',
      heading: 'Sign-in emails do not arrive or go to spam',
      required: [
        'registration policy',
        '`SIGNUP`',
        '`SMTP_URL`',
        'request a new link',
        'expired links are discarded',
      ],
    },
    {
      topic: 'separate worker email delivery',
      heading: 'Worker is not running, so no email is sent',
      required: [
        '`HOURMERE_ROLE=web`',
        '**sign-in emails as well as booking notifications**',
        'docker compose logs --tail=100 worker',
        '/docs/self-hosting#run-workers-separately',
      ],
    },
    {
      topic: 'certificate ports and diagnostics',
      heading: 'Caddy cannot obtain or renew a certificate',
      required: [
        'docker compose logs --tail=100 proxy',
        '**TCP ports 80 and 443**',
        'firewall',
        'https://caddyserver.com/docs/automatic-https',
      ],
    },
    {
      topic: 'IPv4-only ingress and AAAA records',
      heading: 'AAAA records and the bundled IPv4-only Caddy network',
      required: [
        '**only an A record**',
        'Remove an AAAA record',
        'IPv4-only',
        '`enable_ipv6`',
        '`TRUSTED_PROXIES`',
        'client-IP rate-limit testing',
      ],
    },
    {
      topic: 'unsupported database poolers',
      heading: 'Database startup fails behind PgBouncer',
      required: [
        '**PgBouncer and other connection poolers are unsupported.**',
        'directly to PostgreSQL',
        '`search_path`',
        '`hourmere.*`',
        '`AUTO_MIGRATE=false`',
      ],
    },
    {
      topic: 'logs and health limitations',
      heading: 'Read logs and check health',
      required: [
        'docker compose logs --tail=100 app',
        'curl --fail https://hourmere.example.com/api/health',
        'does not test SMTP delivery, a separate worker or external calendar access',
        'Never share `.env`',
        '/docs/self-hosting#logs-health-and-host-hardening',
      ],
    },
  ])('explains $topic with actionable checks', ({ heading, required }) => {
    for (const value of required) expect(section(heading)).toContain(value)
  })
})

const publishedGuides = [
  'webhooks',
  'cli',
  'automatic-google-meet',
  'automatic-zoom',
  'round-robin-scheduling',
  'collective-scheduling',
  'notifications',
  'analytics',
  'interface-languages',
  'api-conventions',
  'embedding',
  'google-calendar',
  'mcp',
  'zoom-connections',
]

function sidebarLinks() {
  const file = ts.createSourceFile(
    'astro.config.ts',
    read('apps/site/astro.config.ts'),
    ts.ScriptTarget.Latest,
    true,
  )
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'sidebar') {
      expression = node.initializer.getText(file)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(expression, 'Starlight sidebar is configured').not.toBe('')
  const sidebar = runInNewContext(`(${expression})`, {
    siteCopy: { en: { home: 'Home', pricing: 'Pricing' } },
  }) as {
    link?: string
    items?: unknown[]
  }[]
  const links: string[] = []
  function collect(items: typeof sidebar) {
    for (const item of items) {
      if (item.link) links.push(item.link)
      if (item.items) collect(item.items as typeof sidebar)
    }
  }
  collect(sidebar)
  return links
}

describe('complete public documentation', () => {
  it.each(publishedGuides)('publishes %s with Starlight metadata and one source', (guide) => {
    const source = read(`${siteDocs}/${guide}.md`)
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? ''
    expect(frontmatter).toMatch(/^title: .+$/m)
    expect(frontmatter).toMatch(/^description: .+$/m)
    const original = `docs/${guide}.md`
    if (guide === 'notifications') {
      expect(read(original).trim()).toBe(
        '[Notifications and background jobs](https://hourmere.com/docs/notifications).',
      )
    } else if (guide === 'api-conventions') {
      // Retain only the requested compatibility excerpt; the full guide stays canonical.
      const webhookRows = source.split('\n').filter((line) => line.startsWith('| Session webhook'))
      expect(webhookRows.length).toBeGreaterThan(0)
      expect(read(original)).toBe(
        [
          '[API conventions](https://hourmere.com/docs/api-conventions).',
          '',
          'These session webhook compatibility rows mirror the canonical documentation for repository readers.',
          '',
          '| Request and supplied expectation | Previous response | Current response |',
          '|---|---|---|',
          ...webhookRows,
          '',
        ].join('\n'),
      )
    } else if (guide === 'mcp') {
      // Retain the requested client setup excerpt; the complete guide stays canonical.
      const excerpt = read(original)
      expect(excerpt).toContain('[MCP quickstart](https://hourmere.com/docs/mcp)')
      const codeBlocks = (markdown: string) => markdown.match(/^```[^\n]*\n[\s\S]*?^```/gm) ?? []
      const quickstart = source.split('\n## Discover your configuration\n')[0] ?? ''
      expect(codeBlocks(excerpt)).toHaveLength(2)
      expect(codeBlocks(excerpt)).toEqual(codeBlocks(quickstart))
    } else {
      expect(existsSync(join(root, original)), original).toBe(false)
    }
  })

  it('makes every published documentation page reachable from the sidebar', () => {
    const links = sidebarLinks()
    for (const { path } of pages) {
      const route = path === 'index.md' ? '/docs' : `/docs/${path.replace(/\.md$/, '')}`
      expect(
        links.filter((link) => link === route),
        route,
      ).toHaveLength(1)
    }
  })

  it.each(pages)('links Markdown file references in $path', ({ source }) => {
    const prose = source
      .replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')
      .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    expect(prose).not.toMatch(/`[\w./-]+\.md(?:#[\w-]+)?`/)
    for (const [, target] of source.matchAll(
      /\]\(https:\/\/github\.com\/hourmere\/hourmere\/blob\/main\/([^)]+)\)/g,
    )) {
      const path = target?.split('#')[0] ?? ''
      expect(path, 'GitHub links name a repository file').not.toBe('')
      expect(existsSync(join(root, path)) && statSync(join(root, path)).isFile(), target).toBe(true)
    }
  })

  it('keeps the README license section limited to its license', () => {
    const license = read('README.md')
      .split(/^## License\r?$/m)[1]
      ?.trim()
    expect(license).toBe('[AGPL-3.0](LICENSE)')
  })

  it('documents the committed legal publication date and fixture build policy', () => {
    const readme = normalize(read('README.md'))
    const legal = read('apps/site/src/data/legal.ts')
    const date = legal.match(/LEGAL_PUBLICATION_DATE[^=]*=\s*'([^']+)'/)?.[1]
    expect(date).toBe('2026-10-22')
    expect(readme).toContain('2026-10-22')
    expect(readme).toContain('change it only when publishing revised legal text')
    expect(readme).toContain('CI retains a fixture-date substitution')
    expect(readme).toContain('with the current committed date, that substitution makes no change')
    expect(readme).toContain('A placeholder or invalid date stops the site build')
    expect(readme).not.toContain('SET_ON_PUBLICATION_DAY')
    expect(legal).toContain(
      'The legal publication date is set for the currently published legal text.',
    )
    expect(legal).toContain('change it only when publishing revised legal text')
    expect(legal).not.toContain('replaces this placeholder')
  })
})

describe('consolidated guide facts', () => {
  it.each([
    ['embedding', 'Popup', 'the rest of the page is inert'],
    ['embedding', 'Popup', '`HTMLDialogElement.showModal()`'],
    ['embedding', 'Inline', 'Its width follows the container'],
    [
      'embedding',
      'Interface language',
      'See [interface languages](/docs/interface-languages) for preference and formatting behavior',
    ],
    ['embedding', 'Booking completion', 'including successful idempotent retry confirmations'],
    ['embedding', 'Booking completion', "iframe's `hourmere:booked` postMessage"],
    ['embedding', 'Booking completion', 'not a trusted booking, billing or analytics record'],
    ['google-calendar', 'Configure the provider', 'Never put these values in version control.'],
    [
      'google-calendar',
      'Configure the provider',
      'Docker Compose passes all three variables to the app/worker.',
    ],
    ['google-calendar', 'Configure the provider', 'Vite proxies `/api` to the server'],
    [
      'google-calendar',
      'Configure the provider',
      'Keep the key stable, private and backed up with the deployment secrets',
    ],
    ['google-calendar', 'Select calendars', '**Refresh calendar list** updates metadata.'],
    ['google-calendar', 'Select calendars', 'Returning to the app shows the calendar list.'],
    [
      'google-calendar',
      'Select calendars',
      'new calendars have `check_conflicts=false` and the profile has no destination',
    ],
    [
      'google-calendar',
      'Select calendars',
      'List-only connections remain supported and must be reauthorized before using synchronization.',
    ],
    [
      'google-calendar',
      'Booking projection and disconnect',
      'A revoked/expired grant changes the connection to `needs_reauth`; reconnect through the same separate consent flow.',
    ],
    [
      'google-calendar',
      'Booking projection and disconnect',
      '[operator repair described below](#automatic-meet-projection)',
    ],
  ])('retains %s / %s: %s', (guide, heading, fact) => {
    const section = read(`${siteDocs}/${guide}.md`).split(`## ${heading}\n`)[1]?.split('\n## ')[0]
    expect(normalize(section ?? '')).toContain(fact)
  })

  it.each([
    'wildcards',
    '`script-src`',
    '`frame-src`',
    '`CSSStyleSheet`',
    '`adoptedStyleSheets`',
    'https://hourmere.example.com/team/Alpha/intro',
    'Repeated loading failures',
    'No booking ID',
    'The browser checks every ancestor',
  ])('explains the embedding constraint %s once', (fact) => {
    expect(read(`${siteDocs}/embedding.md`).split(fact)).toHaveLength(2)
  })
})
