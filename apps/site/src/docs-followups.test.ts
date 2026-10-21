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
