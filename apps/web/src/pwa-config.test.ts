// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'
import { offlineShell } from '../pwa/build.ts'
import { pwaEnabled } from '../pwa/config.ts'
import viteConfig from '../vite.config.ts'

vi.mock('vite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vite')>()),
  loadEnv: vi.fn(),
}))

vi.mock('../pwa/build.ts', () => ({
  offlineShell: vi.fn(() => ({ name: 'test-offline-shell' })),
}))

afterEach(() => vi.resetAllMocks())

it('accepts only the documented build switch values', () => {
  for (const value of [undefined, '', 'true']) expect(pwaEnabled(value)).toBe(true)
  expect(pwaEnabled('false')).toBe(false)
  for (const value of ['FALSE', '0', '1', 'yes', ' true ']) {
    expect(() => pwaEnabled(value)).toThrow('VITE_PWA_ENABLED must be empty, true, or false')
  }
})

it.each(['', 'true', 'false'])(
  'loads the root setting %j and wires its effective value into worker and client builds',
  async (value) => {
    const root = await mkdtemp(join(tmpdir(), 'hourmere-pwa-env-'))
    try {
      await writeFile(join(root, '.env'), `VITE_PWA_ENABLED=${value}\n`)
      const actualVite = await vi.importActual<typeof import('vite')>('vite')
      vi.mocked(loadEnv).mockImplementation((mode) => actualVite.loadEnv(mode, root, ''))
      const workerPlugin = { name: 'test-offline-shell' }
      vi.mocked(offlineShell).mockReturnValue(workerPlugin)
      if (typeof viteConfig !== 'function') throw new Error('Expected a Vite config function')
      const config = await viteConfig({ command: 'build', mode: 'production' })
      const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
      expect(loadEnv).toHaveBeenCalledWith('production', repoRoot, '')
      expect(config.envDir).toBe(repoRoot)
      expect(config.define?.['import.meta.env.VITE_PWA_ENABLED']).toBe(
        JSON.stringify(String(value !== 'false')),
      )
      expect(offlineShell).toHaveBeenCalledExactlyOnceWith(value !== 'false')
      expect(config.plugins).toContain(workerPlugin)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('forwards the Compose root setting to the Docker build without copying private env files', async () => {
  const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
  expect(read('docker-compose.yml')).toMatch(
    /build:\s+context: \.\s+args:\s+VITE_PWA_ENABLED: \$\{VITE_PWA_ENABLED:-\}/,
  )
  // Join continued instructions before splitting stages: ARG visibility ends at FROM.
  const instructions = read('Dockerfile')
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  const stages = new Map<string, string[]>()
  let stage: string[] | undefined
  for (const instruction of instructions) {
    if (/^FROM\s/i.test(instruction)) {
      const name = instruction.match(/\sAS\s+(\S+)$/i)?.[1]?.toLowerCase()
      stage = []
      if (name) stages.set(name, stage)
    } else {
      stage?.push(instruction)
    }
  }
  const build = stages.get('build')
  expect(build, 'Dockerfile must have a named build stage').toBeDefined()
  const argIndex = build?.findIndex((line) => /^ARG\s+VITE_PWA_ENABLED=$/.test(line)) ?? -1
  const runIndex =
    build?.findIndex(
      (line) => /^RUN\s/i.test(line) && /npm run build --workspace @hourmere\/web\b/.test(line),
    ) ?? -1
  expect(argIndex, 'PWA ARG must be declared inside the build stage').toBeGreaterThanOrEqual(0)
  expect(runIndex, 'web build must consume the build-stage ARG environment').toBeGreaterThan(
    argIndex,
  )
  // Docker exposes ARG to RUN, but ENV or shell assignments can shadow/unset it.
  expect(build?.slice(0, runIndex).filter((line) => /^ENV\s/i.test(line))).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/\bVITE_PWA_ENABLED(?:=|\s)/)]),
  )
  const root = await mkdtemp(join(tmpdir(), 'hourmere-pwa-docker-run-'))
  try {
    // Execute the actual RUN with only fake npm and env on PATH. The sentinel exit
    // stops its && chain at the build, before any copy/prune commands can execute.
    await writeFile(
      join(root, 'npm'),
      '#!/bin/sh\ncase "$*" in\n"ci --ignore-scripts") exit 0 ;;\n"run build --workspace @hourmere/web") printf "%s" "$VITE_PWA_ENABLED"; exit 73 ;;\n*) exit 74 ;;\nesac\n',
      { mode: 0o755 },
    )
    await symlink('/usr/bin/env', join(root, 'env'))
    const command = build?.[runIndex]?.replace(/^RUN\s+/i, '')
    expect(command).toBeDefined()
    for (const value of ['true', 'false']) {
      const run = spawnSync('/bin/sh', ['-c', command ?? ''], {
        cwd: root,
        env: { PATH: root, VITE_PWA_ENABLED: value },
        encoding: 'utf8',
        timeout: 5_000,
      })
      expect(run.status, 'RUN must reach the stubbed web build').toBe(73)
      expect(run.stdout, 'npm build must receive the requested PWA ARG unchanged').toBe(value)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  expect(read('.dockerignore')).toContain('\n.env\n')
})
