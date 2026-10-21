import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const normalize = (source: string) => source.replace(/\s+/g, ' ')
const siteDocs = 'apps/site/src/content/docs/docs'
const googleGuides = [`${siteDocs}/configuration.md`, `${siteDocs}/google-calendar.md`]

describe('self-hosting documentation follow-ups', () => {
  it.each(['configuration', 'google-calendar', 'self-hosting'])(
    'matches the Google sign-in button in %s',
    (page) => {
      const source = read(`${siteDocs}/${page}.md`)
      expect(read('apps/web/src/components/SocialSignInButton.tsx')).toContain(
        "t('Continue with Google')",
      )
      expect(source).toContain('**Continue with Google**')
      expect(source).not.toContain('**Sign in with Google**')
    },
  )

  it('matches the Microsoft sign-in button in configuration', () => {
    expect(read('apps/web/src/components/SocialSignInButton.tsx')).toContain(
      "t('Sign in with Microsoft')",
    )
    expect(read(`${siteDocs}/configuration.md`)).toContain('**Sign in with Microsoft**')
  })

  it.each(googleGuides)('explains the basic-scope Testing access exception in %s', (path) => {
    const source = normalize(read(path))
    expect(source).toMatch(/External.*?Testing.*?any Google account/)
    expect(source).toMatch(/without being on (?:the test-user|that) list/)
    for (const scope of ['openid', 'email', 'profile']) expect(source).toContain(`\`${scope}\``)
    expect(source).toContain('subject to Google Workspace administrator controls')
    expect(source).toContain(
      'https://developers.google.com/identity/protocols/oauth2/production-readiness/overview',
    )
  })

  it.each(googleGuides)('explains the shared Google project settings in %s', (path) => {
    const source = normalize(read(path))
    expect(source).toMatch(
      /[Ss]ign-in and calendar OAuth clients.*?share one publishing status and test-user list/,
    )
    expect(source).toContain('same Google Cloud project')
    expect(source).toMatch(
      /[Cc]alendar access still requires test users (?:while the project is in|in) Testing/,
    )
  })

  it.each([`${siteDocs}/google-calendar.md`])(
    'offers a separate-project fallback when shared-project sign-in access fails in %s',
    (path) => {
      expect(normalize(read(path))).toMatch(
        /If users who are not on the test-user list cannot sign in[^.]*, put the sign-in OAuth client in a separate Google Cloud project\./,
      )
    },
  )

  it.each(googleGuides)('describes verification without claiming hosted approval in %s', (path) => {
    const source = normalize(read(path))
    expect(source).toContain('Each Google Cloud project is verified separately')
    expect(source).toContain('a self-hosted instance uses your own project')
    expect(source).not.toMatch(/Hourmere's hosted.*?verification.*?(?:does not|do not)/)
  })

  it('links the configuration source on GitHub main', () => {
    expect(read(`${siteDocs}/configuration.md`)).toContain(
      '[`apps/server/src/config.ts`](https://github.com/hourmere/hourmere/blob/main/apps/server/src/config.ts)',
    )
  })

  it('uses the root version lifecycle in the MCP directory checklist', () => {
    const source = normalize(read('docs/mcp-directories.md'))
    expect(source).toContain('root `package.json` is the single source')
    expect(source).toContain('`npm version <next-version> --no-git-tag-version`')
    expect(source).toContain('`scripts/sync-version.ts`')
    for (const target of ['server.json', 'tools/cli/package.json', 'npm lockfile']) {
      expect(source).toContain(target)
    }
    expect(source).not.toContain('`0.0.0`')
    expect(source).not.toContain('at release, align that advertised server version')
  })
})

describe('published image configuration reference', () => {
  const source = read(`${siteDocs}/configuration.md`)
  const tableRow = (variable: string) =>
    source.split('\n').find((line) => line.startsWith(`| \`${variable}\` |`)) ?? ''

  it('removes the unpublished-image claim and scopes APP_IMAGE to source builds', () => {
    expect(source).not.toMatch(/no prebuilt public image is published/i)
    const row = tableRow('APP_IMAGE')
    expect(row).toContain('Source builds only')
    expect(row).toContain('The image overlay ignores this setting')
    expect(row).toContain('ghcr.io/hourmere/hourmere:<HOURMERE_VERSION>')
  })

  it('pins the image version without a v prefix or floating tags', () => {
    const row = tableRow('HOURMERE_VERSION')
    expect(row).toContain('Not forwarded by the default Compose file: consumed by the Compose CLI')
    expect(row).toContain('Exact published release version')
    expect(row).toContain('without a leading `v`')
    expect(row).toContain('never `latest` or a floating minor tag')
    expect(row).toContain('pins the same image for app and worker')
    expect(row).toContain('Omit it for source builds')
  })

  it('preserves the image overlay in both setup selections and manual worker examples', () => {
    const row = tableRow('COMPOSE_FILE')
    for (const selection of [
      'docker-compose.yml:docker-compose.image.yml:docker-compose.proxy.yml',
      'docker-compose.yml:docker-compose.image.yml',
    ]) {
      expect(row).toContain(`\`${selection}\``)
    }
    expect(row).toContain('Source setup omits `docker-compose.image.yml`')
    const manual = source.split('If editing manually, replace the whole quoted line')[1]
    expect(manual).toBeDefined()
    const selections = [...(manual ?? '').matchAll(/^COMPOSE_FILE='([^']+)'$/gm)].map(
      (match) => match[1],
    )
    expect(selections).toEqual([
      'docker-compose.yml:docker-compose.image.yml:docker-compose.proxy.yml:docker-compose.worker.yml',
      'docker-compose.yml:docker-compose.image.yml:docker-compose.worker.yml',
    ])
    expect(normalize(manual ?? '')).toContain(
      'Source installations omit `docker-compose.image.yml` from either example',
    )
  })
})

describe('release-day documentation flip list', () => {
  const checklist =
    read('docs/releasing.md')
      .split('| File / preparation lines |')[1]
      ?.split('\n- Replace the no-stable-release/public-image sentences')[0] ?? ''

  it.each([
    {
      area: 'configuration reference',
      targets: [
        'apps/site/src/content/docs/docs/configuration.md:259',
        ':265',
        ':267',
        ':296',
        'HOURMERE_VERSION',
      ],
    },
    { area: 'example environment comments', targets: ['.env.example:116–121'] },
    {
      area: 'Compose header comments',
      targets: ['`docker-compose.yml` and `docker-compose.worker.yml` (header comments)'],
    },
    {
      area: 'worker helper startup hint',
      targets: ['`scripts/enable-worker.sh` (`--build` hint)'],
    },
    { area: 'Caddy migration', targets: [':174–220', '(Caddy migration)'] },
  ])('includes $area', ({ targets }) => {
    for (const target of targets) expect(checklist).toContain(target)
  })
})
