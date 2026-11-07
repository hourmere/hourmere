import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  assertCliOutput,
  assertPackage,
  assertPackedScripts,
  assertPackFiles,
  PACK_FILES,
} from '../scripts/pack-check.ts'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('CLI npm packaging protections', () => {
  it('prepares a public dependency-free ESM executable with a release version', () => {
    expect(() => assertPackage(manifest)).not.toThrow()
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(manifest.license).toBe('AGPL-3.0-only')
    expect(manifest.scripts).toEqual({
      start: 'node dist/index.js',
      prepublishOnly: 'node dist/index.js --version',
    })
    expect(manifest.files).toEqual([
      'dist/index.js',
      'dist/cli.js',
      'dist/client.js',
      'README.md',
      'LICENSE',
    ])
  })

  it('publishes scripts whose file paths are all included in the tarball', () => {
    expect(() => assertPackedScripts(manifest, PACK_FILES)).not.toThrow()
  })

  it('refuses the prepublish guard without a compiled CLI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-cli-publish-'))
    directories.push(directory)
    // The npm lifecycle integration lives in pack-smoke; exercise the exact
    // manifest command here without starting npm and its configuration discovery.
    expect(manifest.scripts.prepublishOnly).toBe('node dist/index.js --version')
    const [, ...args] = manifest.scripts.prepublishOnly.split(' ')
    const result = spawnSync(process.execPath, args, {
      cwd: directory,
      encoding: 'utf8',
      env: {},
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MODULE_NOT_FOUND')
  })

  it.each([
    'node src/index.ts',
    'node missing',
    'tsc -p tsconfig.build.json',
    'tsc -p missing',
    'node "dist/missing.js"',
    'node --import=./src/missing.js dist/index.js',
    'node dist/index.js --help',
    'node dist/index.js --version --import=./src/missing.js',
    'node dist/index.js --version && node missing',
    String.raw`node 'dist\index.js'`,
  ])('refuses a packed script that references an absent path: %s', (command) => {
    expect(() => assertPackedScripts({ scripts: { check: command } }, PACK_FILES)).toThrow(
      /missing tarball path|must use node <packed-file>/,
    )
  })

  it('accepts quoted and explicitly relative paths that ship', () => {
    expect(() =>
      assertPackedScripts({ scripts: { start: 'node "./dist/index.js"' } }, PACK_FILES),
    ).not.toThrow()
    expect(() =>
      assertPackedScripts(
        { scripts: { prepublishOnly: 'node "./dist/index.js" --version' } },
        PACK_FILES,
      ),
    ).not.toThrow()
  })

  it('rejects shell commands that could conceal more file references', () => {
    expect(() =>
      assertPackedScripts({ scripts: { start: 'node dist/index.js && node missing' } }, PACK_FILES),
    ).toThrow(/must use node <packed-file>/)
  })

  it('keeps CLI development build and typecheck scripts outside the packed manifest', async () => {
    const root = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    )
    expect(root.scripts['cli:build']).toBe('tsc -p tools/cli/tsconfig.build.json')
    expect(root.scripts.build).toContain('npm run cli:build')
    expect(root.scripts.typecheck).toContain('tsc -p tools/cli')
    const smoke = await readFile(new URL('../scripts/pack-smoke.ts', import.meta.url), 'utf8')
    expect(smoke).toContain("npm(['run', 'cli:build'],")
    expect(smoke).toMatch(/assertPackedScripts\(installedManifest,/)
    expect(smoke).toContain("'--engine-strict'")
  })

  it('supports Node 22 in CLI metadata and docs while the server remains on Node 26', async () => {
    const root = JSON.parse(
      await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
    )
    const lock = JSON.parse(
      await readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8'),
    )
    expect(manifest.engines.node).toBe('>=22')
    expect(lock.packages['tools/cli'].engines.node).toBe('>=22')
    expect(root.engines.node).toBe('>=26')
    expect(lock.packages[''].engines.node).toBe('>=26')
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
    const guide = await readFile(
      new URL('../../../apps/site/src/content/docs/docs/cli.md', import.meta.url),
      'utf8',
    )
    expect(readme).toContain('Node.js 22 or later')
    expect(guide).toContain('Node.js 22 or later')
    expect(guide).toContain('repository development still uses Node.js 26')
  })

  it.each(['tsconfig.json', 'tsconfig.build.json'])(
    'overrides the server Temporal library for the CLI %s',
    async (name) => {
      const config = JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), 'utf8'))
      const base = JSON.parse(
        await readFile(new URL('../../../tsconfig.base.json', import.meta.url), 'utf8'),
      )
      expect(config.extends).toBe('../../tsconfig.base.json')
      expect(config.compilerOptions.lib).toEqual(['es2024'])
      expect(base.compilerOptions.types).toEqual(['node'])
      // pack-smoke compiles fetch/Temporal probes against both real configs on
      // Node 22 and 24. Compiler startup is an integration gate, not a unit timeout.
      const smoke = await readFile(new URL('../scripts/pack-smoke.ts', import.meta.url), 'utf8')
      expect(smoke).toContain("['tsconfig.json', 'tsconfig.build.json']")
      expect(smoke).toContain('// @ts-expect-error Node 22 has no native Temporal API.')
    },
  )

  it('checks Node 22 and 24 on Ubuntu with the pinned CI actions and no database service', async () => {
    const workflow = parse(
      await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    )
    const job = workflow.jobs['cli-compatibility']
    expect(workflow.on).toHaveProperty('workflow_call')
    expect(job['runs-on']).toBe('ubuntu-latest')
    expect(job.strategy.matrix.node).toEqual([22, 24])
    expect(job.services).toBeUndefined()
    expect(job.env?.DATABASE_URL).toBeUndefined()
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.if).toBeUndefined()
    const actions = job.steps.filter((step: { uses?: string }) => step.uses)
    expect(actions.map((step: { uses: string }) => step.uses)).toEqual(
      workflow.jobs.check.steps
        .filter((step: { uses?: string }) => step.uses)
        .map((step: { uses: string }) => step.uses),
    )
    for (const action of actions) expect(action.uses).toMatch(/@[a-f0-9]{40}$/)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression
    expect(actions[1].with['node-version']).toBe('${{ matrix.node }}')
    expect(job.steps.map((step: { run?: string }) => step.run).filter(Boolean)).toEqual([
      'npm ci --ignore-scripts --audit=false --fund=false',
      'npm run cli:pack-smoke',
      'npm test -- tools/cli/src/cli.test.ts tools/cli/src/package.test.ts --maxWorkers=2',
    ])
  })

  it('refuses extra tarball files even when they look like harmless source files', () => {
    expect(() => assertPackFiles([...PACK_FILES, 'src/cli.test.ts'])).toThrow(/exact allow-list/)
  })

  it('refuses tarballs missing a runtime file', () => {
    expect(() => assertPackFiles(PACK_FILES.filter((file) => file !== 'dist/client.js'))).toThrow(
      /exact allow-list/,
    )
  })

  it('accepts exactly the six expected files in any order', () => {
    expect(() => assertPackFiles([...PACK_FILES].reverse())).not.toThrow()
  })

  it.each([
    { field: 'name', value: '@somebody/cli' },
    { field: 'version', value: 'next' },
    { field: 'private', value: true },
    { field: 'type', value: 'commonjs' },
  ])('refuses incorrect $field metadata', ({ field, value }) => {
    expect(() => assertPackage({ ...manifest, [field]: value })).toThrow()
  })

  it('refuses a source TypeScript bin that Node cannot execute from node_modules', () => {
    expect(() => assertPackage({ ...manifest, bin: { hourmere: 'src/index.ts' } })).toThrow(
      /compiled JS/,
    )
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'refuses runtime %s that could resolve only inside the workspace',
    (field) => {
      expect(() => assertPackage({ ...manifest, [field]: { '@hourmere/core': '*' } })).toThrow(
        /runtime/,
      )
    },
  )

  it('checks the executable help instead of accepting an empty successful invocation', () => {
    expect(() => assertCliOutput('', `${manifest.version}\n`, manifest.version)).toThrow(
      /installed command/,
    )
  })

  it('requires the help to include commands', () => {
    expect(() =>
      assertCliOutput('Usage: hourmere COMMAND\n', `${manifest.version}\n`, manifest.version),
    ).toThrow()
  })

  it('refuses a hard-coded version that disagrees with release metadata', () => {
    expect(() =>
      assertCliOutput('Usage: hourmere COMMAND\nCommands: whoami\n', '0.0.0\n', '1.0.0'),
    ).toThrow(/match package metadata/)
  })
})
