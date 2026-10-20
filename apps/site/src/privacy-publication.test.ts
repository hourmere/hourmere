import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const require = createRequire(import.meta.url)
const astro = join(dirname(require.resolve('astro/package.json')), 'bin/astro.mjs')
const site = fileURLToPath(new URL('../', import.meta.url))
const dependencies = fileURLToPath(new URL('../../../node_modules', import.meta.url))

async function withFixture(run: (fixture: string) => Promise<void>) {
  const fixture = await mkdtemp(join(await realpath(tmpdir()), 'hourmere-legal-publication-'))
  try {
    await run(fixture)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}

async function setSourceDate(fixture: string, date: string) {
  const path = join(fixture, 'src/data/legal.ts')
  const source = await readFile(path, 'utf8')
  await writeFile(
    path,
    source.replace(/(export const LEGAL_PUBLICATION_DATE: string = )'[^']*'/, `$1'${date}'`),
  )
}

async function copyDateFixture(fixture: string, date: string) {
  for (const path of ['src/data', 'src/privacy-publication.ts']) {
    await cp(join(site, path), join(fixture, path), { recursive: true })
  }
  await writeFile(join(fixture, 'package.json'), '{"type":"module"}\n')
  await setSourceDate(fixture, date)
}

async function copyGuardFixture(fixture: string, date: string) {
  for (const path of ['astro.config.ts', 'package.json', 'src', 'public']) {
    await cp(join(site, path), join(fixture, path), { recursive: true })
  }
  // No legal page calls the resolver: only the real configuration's build hook
  // can reject the source date. Keep Starlight and the remaining config intact.
  await rm(join(fixture, 'src/pages'), { recursive: true })
  await mkdir(join(fixture, 'src/pages'))
  await writeFile(join(fixture, 'src/pages/index.astro'), '<p>Legal build guard probe</p>')
  await symlink(dependencies, join(fixture, 'node_modules'), 'dir')
  await setSourceDate(fixture, date)
}

async function copyLegalRenderFixture(fixture: string, date: string) {
  // Render both actual legal pages and their components without Starlight's
  // external pages, which cannot compile under a temporary root on Linux.
  for (const path of [
    'package.json',
    'src/pages/privacy.astro',
    'src/pages/terms.astro',
    'src/privacy-publication.ts',
    'src/data',
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
  await setSourceDate(fixture, date)
}

function fixtureEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: '1',
    // Stale deployment variables must neither bypass the guard nor change the
    // committed day. UTC rendering must also survive a build west of UTC.
    PRIVACY_PUBLICATION_DATE: '2099-12-31',
    LEGAL_PUBLICATION_DATE: '2099-12-31',
    TZ: 'America/Los_Angeles',
  }
}

function resolveFixtureDate(fixture: string) {
  const url = pathToFileURL(join(fixture, 'src/privacy-publication.ts')).href
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { resolveLegalPublicationDate } from ${JSON.stringify(url)}; console.log(resolveLegalPublicationDate())`,
    ],
    { env: fixtureEnvironment(), encoding: 'utf8', timeout: 10_000 },
  )
}

function buildSiteFixture(fixture: string) {
  return spawnSync(process.execPath, [astro, 'build', '--root', fixture], {
    env: fixtureEnvironment(),
    encoding: 'utf8',
    timeout: 30_000,
  })
}

describe('legal publication date', () => {
  it.each(['', 'SET_ON_PUBLICATION_DAY'])(
    'rejects an empty or placeholder source date despite environment overrides: %s',
    async (date) => {
      await withFixture(async (fixture) => {
        await copyDateFixture(fixture, date)
        const result = resolveFixtureDate(fixture)
        expect(result.error).toBeUndefined()
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('Set LEGAL_PUBLICATION_DATE')
      })
    },
  )

  it.each(['2026-2-01', '2026-02-29', '2026-13-01', '2026-04-31', '2026-10-19T00:00:00Z'])(
    'rejects an invalid source calendar date: %s',
    async (date) => {
      await withFixture(async (fixture) => {
        await copyDateFixture(fixture, date)
        const result = resolveFixtureDate(fixture)
        expect(result.error).toBeUndefined()
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('Set LEGAL_PUBLICATION_DATE')
      })
    },
  )

  it.each(['2026-10-19', '2028-02-29'])(
    'keeps the committed publication day despite later deployment environment values: %s',
    async (date) => {
      await withFixture(async (fixture) => {
        await copyDateFixture(fixture, date)
        const result = resolveFixtureDate(fixture)
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout.trim()).toBe(date)
      })
    },
  )

  it.each(['SET_ON_PUBLICATION_DAY', '2026-02-30'])(
    'stops the real Astro build hook with source date %s even without legal pages',
    async (date) => {
      await withFixture(async (fixture) => {
        await copyGuardFixture(fixture, date)
        const result = buildSiteFixture(fixture)
        expect(result.error).toBeUndefined()
        expect(result.status).not.toBe(0)
        expect(result.stdout + result.stderr).toContain('Set LEGAL_PUBLICATION_DATE')
      })
    },
    40_000,
  )

  it('renders both legal pages with the fixed source day in UTC, ignoring deployment dates', async () => {
    await withFixture(async (fixture) => {
      // Deliberately unrelated to the release and runtime environment dates.
      await copyLegalRenderFixture(fixture, '2000-01-01')
      const result = buildSiteFixture(fixture)
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(0)
      for (const page of ['privacy', 'terms']) {
        const html = await readFile(join(fixture, `dist/${page}.html`), 'utf8')
        const labels = page === 'privacy' ? ['Effective date', 'Last updated'] : ['Effective date']
        for (const label of labels) {
          expect(html, `${page}: ${label}`).toMatch(
            new RegExp(
              `${label}:\\s*<time\\b[^>]*datetime="2000-01-01"[^>]*>January 1, 2000</time>`,
            ),
          )
        }
      }
    })
  }, 40_000)

  it.each([0, 17])(
    'restores CI source and discards fixture output when the build exits %s',
    async (exitCode) => {
      const workflow = parse(
        await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
      ) as { jobs: { check: { steps: { name?: string; run?: string }[] } } }
      const build = workflow.jobs.check.steps.find(
        (step) => step.name === 'Build with a disposable legal publication fixture',
      )
      expect(build?.run).toBeTypeOf('string')
      await withFixture(async (fixture) => {
        const path = join(fixture, 'apps/site/src/data/legal.ts')
        await mkdir(dirname(path), { recursive: true })
        const source = await readFile(new URL('./data/legal.ts', import.meta.url), 'utf8')
        // Keep exercising the prepublication fixture after the real date is committed.
        const original = source.replace(
          /(export const LEGAL_PUBLICATION_DATE: string = )'[^']*'/,
          "$1'SET_ON_PUBLICATION_DAY'",
        )
        await writeFile(path, original)
        const bin = join(fixture, 'bin')
        await mkdir(bin)
        await writeFile(
          join(bin, 'npm'),
          '#!/bin/sh\nmkdir -p apps/site/dist\ncp apps/site/src/data/legal.ts build-source.txt\nprintf fixture > apps/site/dist/index.html\nexit "$HOURMERE_BUILD_PROBE_EXIT"\n',
          { mode: 0o755 },
        )
        const result = spawnSync('/bin/bash', ['-e', '-c', build?.run ?? ''], {
          cwd: fixture,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            HOURMERE_BUILD_PROBE_EXIT: String(exitCode),
          },
          encoding: 'utf8',
          timeout: 10_000,
        })
        expect(result.error).toBeUndefined()
        expect(result.status, result.stdout + result.stderr).toBe(exitCode)
        expect(await readFile(join(fixture, 'build-source.txt'), 'utf8')).toContain("'2000-01-01'")
        expect(await readFile(path, 'utf8')).toBe(original)
        expect(existsSync(join(fixture, 'apps/site/dist'))).toBe(false)
      })
    },
  )
})
