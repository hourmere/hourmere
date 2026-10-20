import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const site = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const astro = join(dirname(require.resolve('astro/package.json')), 'bin/astro.mjs')
const policyPath = '.well-known/security.txt'

describe('published security.txt', () => {
  it('lists the private reporting channels, hosted canonical URLs and a bounded expiry', async () => {
    const policy = await readFile(join(site, 'public', policyPath), 'utf8')
    expect(policy.endsWith('\n')).toBe(true)
    const fields = policy.trimEnd().split('\n')
    expect(fields.filter((line) => !line.startsWith('Expires: '))).toEqual([
      'Contact: mailto:security@hourmere.com',
      'Contact: https://github.com/hourmere/hourmere/security/advisories/new',
      'Preferred-Languages: en, zh',
      'Canonical: https://hourmere.com/.well-known/security.txt',
      'Canonical: https://www.hourmere.com/.well-known/security.txt',
      'Canonical: https://app.hourmere.com/.well-known/security.txt',
      'Policy: https://github.com/hourmere/hourmere/blob/main/SECURITY.md',
    ])
    const expiry = fields.filter((line) => line.startsWith('Expires: '))
    expect(expiry).toHaveLength(1)
    const value = expiry[0]?.slice('Expires: '.length) ?? ''
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    const now = new Date()
    const nextYear = new Date(now)
    nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1)
    expect(Date.parse(value)).toBeGreaterThan(now.getTime())
    expect(Date.parse(value)).toBeLessThanOrEqual(nextYear.getTime())
  })

  it('copies the dot-directory unchanged into the configured Workers assets build', async () => {
    // Astro renames generated assets, so its output must stay on the site's volume.
    const fixture = await mkdtemp(join(site, '.security-build-'))
    try {
      // Build the actual site/config so dot-directory copying cannot silently regress.
      // Keep output isolated from the regular workspace build and deployment command.
      const result = spawnSync(
        process.execPath,
        [astro, 'build', '--root', site, '--outDir', join(fixture, 'dist')],
        {
          env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
          encoding: 'utf8',
          timeout: 30_000,
        },
      )
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(0)

      // This config uses whole-line JSONC comments only. Resolve the real assets path
      // instead of assuming that Wrangler still points at Astro's output directory.
      const config = JSON.parse(
        (await readFile(join(site, 'wrangler.jsonc'), 'utf8'))
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('//'))
          .join('\n'),
      ) as { assets: { directory: string; not_found_handling: string } }
      expect(config.assets.not_found_handling).toBe('404-page')
      const assets = resolve(fixture, config.assets.directory)
      expect(existsSync(join(assets, policyPath))).toBe(true)
      expect(await readFile(join(assets, policyPath), 'utf8')).toBe(
        await readFile(join(site, 'public', policyPath), 'utf8'),
      )
      expect(await readFile(join(assets, '_headers'), 'utf8')).toContain(
        '/.well-known/security.txt\n  Content-Type: text/plain; charset=utf-8\n',
      )
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }, 40_000)
})
