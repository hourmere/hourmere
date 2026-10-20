import { existsSync, globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

  it.each(pages)('uses canonical docs links in $path', ({ source }) => {
    expect(source).not.toMatch(
      /\((?:https:\/\/hourmere\.com)?\/docs(?:\/[\w-]+)*\/(?:[?#][^)]*)?\)/,
    )
  })

  it('uses the canonical MCP documentation URL in registry metadata', () => {
    expect(JSON.parse(read('server.json')).websiteUrl).toBe('https://hourmere.com/docs/mcp')
  })

  it.each([
    'README.md',
    'Caddyfile',
    ...globSync('**/*.md', { cwd: join(root, 'docs') }).map((path) => `docs/${path}`),
    ...pages.map(({ path }) => `${siteDocs}/${path}`),
  ])('keeps production application hosts out of examples in %s', (path) => {
    const source = read(path)
    expect(source).not.toMatch(/\bapp\.hourmere\.com\b/)
    expect(source).not.toMatch(
      /https?:\/\/(?:[\w-]+\.)*hourmere\.com\/(?:api|mcp|sign-in|app|booking|team)(?:\b|\/)/,
    )
    expect(source).not.toMatch(/\bhourmere\.com\/\{/)
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
    expect(read(`${siteDocs}/index.md`)).toContain(`](${githubDocs}${guide}.md)`)
  })
})

describe('Google self-hosting guidance', () => {
  const paths = [
    'docs/google-calendar.md',
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
