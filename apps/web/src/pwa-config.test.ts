// @vitest-environment node
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnv } from 'vite'
import { expect, it } from 'vitest'
import { pwaEnabled } from '../pwa/config.ts'

it('accepts only the documented build switch values', () => {
  for (const value of [undefined, '', 'true']) expect(pwaEnabled(value)).toBe(true)
  expect(pwaEnabled('false')).toBe(false)
  for (const value of ['FALSE', '0', '1', 'yes', ' true ']) {
    expect(() => pwaEnabled(value)).toThrow('VITE_PWA_ENABLED must be empty, true, or false')
  }
})

it('loads the root setting and wires the same value into worker and client builds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hourmere-pwa-env-'))
  try {
    await writeFile(join(root, '.env'), 'VITE_PWA_ENABLED=false\n')
    expect(pwaEnabled(loadEnv('production', root, '').VITE_PWA_ENABLED)).toBe(false)
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
    expect(config).toContain("loadEnv(mode, repoRoot, '')")
    expect(config).toContain('pwaEnabled(env.VITE_PWA_ENABLED)')
    expect(config).toContain('envDir: repoRoot')
    expect(config).toContain("'import.meta.env.VITE_PWA_ENABLED': JSON.stringify(String(enabled))")
    expect(config).toContain('offlineShell(enabled)')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('forwards the Compose root setting to the Docker build without copying private env files', () => {
  const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
  expect(read('docker-compose.yml')).toMatch(
    /build:\s+context: \.\s+args:\s+VITE_PWA_ENABLED: \$\{VITE_PWA_ENABLED:-\}/,
  )
  expect(read('Dockerfile')).toContain('ARG VITE_PWA_ENABLED=\n')
  expect(read('.dockerignore')).toContain('\n.env\n')
})
