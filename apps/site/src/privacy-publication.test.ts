import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PRIVACY_PUBLICATION_DATE_PLACEHOLDER,
  resolvePrivacyPublicationDate,
} from './privacy-publication.ts'

const require = createRequire(import.meta.url)
const astro = join(dirname(require.resolve('astro/package.json')), 'bin/astro.mjs')
const site = fileURLToPath(new URL('../', import.meta.url))
const dependencies = fileURLToPath(new URL('../../../node_modules', import.meta.url))

async function copySiteFixture(fixture: string) {
  for (const path of ['astro.config.ts', 'package.json', 'src', 'public']) {
    await cp(join(site, path), join(fixture, path), { recursive: true })
  }
  await symlink(dependencies, join(fixture, 'node_modules'), 'dir')
}

async function copyPrivacyRenderFixture(fixture: string) {
  // Render the actual privacy page and its components without Starlight's external
  // Astro pages: symlinked dependency pages fail to compile under a temporary root on Linux.
  for (const path of [
    'package.json',
    'src/pages/privacy.astro',
    'src/privacy-publication.ts',
    'src/site.ts',
    'src/layouts',
    'src/components',
    'src/styles',
    'src/assets',
  ]) {
    await cp(join(site, path), join(fixture, path), { recursive: true })
  }
  await writeFile(
    join(fixture, 'astro.config.ts'),
    "import { defineConfig } from 'astro/config'\nexport default defineConfig({ build: { format: 'preserve' }, compressHTML: false })\n",
  )
  await symlink(dependencies, join(fixture, 'node_modules'), 'dir')
}

function buildSiteFixture(fixture: string, date: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }
  delete env.PRIVACY_PUBLICATION_DATE
  if (date !== undefined) env.PRIVACY_PUBLICATION_DATE = date
  return spawnSync(process.execPath, [astro, 'build', '--root', fixture], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
}

describe('privacy publication date', () => {
  it.each([undefined, '', PRIVACY_PUBLICATION_DATE_PLACEHOLDER])(
    'rejects an unset or placeholder date: %s',
    (date) => {
      expect(() => resolvePrivacyPublicationDate(date)).toThrow(/PRIVACY_PUBLICATION_DATE/)
    },
  )

  it.each(['2026-2-01', '2026-02-29', '2026-13-01', '2026-04-31', '2026-10-19T00:00:00Z'])(
    'rejects an invalid calendar date: %s',
    (date) => {
      expect(() => resolvePrivacyPublicationDate(date)).toThrow(/PRIVACY_PUBLICATION_DATE/)
    },
  )

  it.each(['2026-10-19', '2028-02-29'])('keeps the supplied publication day: %s', (date) => {
    expect(resolvePrivacyPublicationDate(date)).toBe(date)
  })

  it.each([undefined, PRIVACY_PUBLICATION_DATE_PLACEHOLDER])(
    'stops the real Astro build when its date is %s',
    async (date) => {
      const fixture = await mkdtemp(join(await realpath(tmpdir()), 'hourmere-privacy-build-'))
      try {
        // Copy the real configuration and site inputs. The page does not call the resolver:
        // this checks that the build hook itself protects all build/deploy entry points.
        await copySiteFixture(fixture)
        await writeFile(
          join(fixture, 'src/pages/privacy.astro'),
          '<p>Privacy build guard probe</p>',
        )
        const result = buildSiteFixture(fixture, date)
        expect(result.error).toBeUndefined()
        expect(result.status).not.toBe(0)
        expect(result.stdout + result.stderr).toContain('Set PRIVACY_PUBLICATION_DATE')
      } finally {
        await rm(fixture, { recursive: true, force: true })
      }
    },
    40_000,
  )

  it('renders the supplied day as both the effective and last-updated dates', async () => {
    const fixture = await mkdtemp(join(await realpath(tmpdir()), 'hourmere-privacy-build-'))
    try {
      await copyPrivacyRenderFixture(fixture)
      // A nonpublishing fixture date, deliberately unrelated to the planned release day.
      const result = buildSiteFixture(fixture, '2000-01-01')
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(0)
      const privacy = await readFile(join(fixture, 'dist/privacy.html'), 'utf8')
      for (const label of ['Effective date', 'Last updated']) {
        expect(privacy).toMatch(
          new RegExp(`${label}:\\s*<time\\b[^>]*datetime="2000-01-01"[^>]*>January 1, 2000</time>`),
        )
      }
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }, 40_000)
})
