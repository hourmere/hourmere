import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Source-copy mutation probes never change the worktree implementation.
const script =
  process.env.HOURMERE_SYNC_VERSION_SCRIPT ??
  fileURLToPath(new URL('./sync-version.ts', import.meta.url))
const rootManifest =
  process.env.HOURMERE_SYNC_VERSION_MANIFEST ??
  fileURLToPath(new URL('../package.json', import.meta.url))
const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(version = '1.1.0') {
  const dir = mkdtempSync(join(tmpdir(), 'hourmere-sync-version-test-'))
  scratch.push(dir)
  mkdirSync(join(dir, 'tools/cli'), { recursive: true })
  const files = {
    'package.json': { name: 'hourmere', version, private: true },
    'tools/cli/package.json': {
      name: '@hourmere/cli',
      version: '1.0.0',
      engines: { node: '>=22' },
      files: ['dist/index.js', 'README.md'],
    },
    'package-lock.json': {
      name: 'hourmere',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'hourmere', version: '1.0.0', workspaces: ['tools/*'] },
        'tools/cli': { name: '@hourmere/cli', version: '1.0.0', license: 'AGPL-3.0-only' },
        'node_modules/example': { version: '4.5.6', integrity: 'fixture-integrity' },
      },
    },
    'server.json': {
      name: 'io.github.hourmere/hourmere',
      version: '1.0.0',
      remotes: [{ type: 'streamable-http', url: 'https://{hourmere_host}/mcp' }],
      _meta: { oauth: { version: '2.1' }, publicationStatus: 'draft' },
    },
  }
  for (const [path, value] of Object.entries(files)) {
    writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`)
  }
  const read = (path: keyof typeof files) => readFileSync(join(dir, path), 'utf8')
  const snapshot = () =>
    Object.fromEntries(Object.keys(files).map((path) => [path, read(path as keyof typeof files)]))
  const run = (...args: string[]) =>
    spawnSync(process.execPath, args.length ? args : [script], {
      cwd: dir,
      encoding: 'utf8',
    })
  return { dir, files, read, run, snapshot }
}

describe('release version synchronization', () => {
  it.each(['1.1.0', '2.0.0-rc.3'])(
    'propagates root version %s to every mirror while preserving unrelated fields',
    (version) => {
      const repo = fixture(version)
      const rootBefore = repo.read('package.json')
      expect(repo.run().status).toBe(0)
      expect(repo.read('package.json')).toBe(rootBefore)
      expect(JSON.parse(repo.read('tools/cli/package.json'))).toEqual({
        ...repo.files['tools/cli/package.json'],
        version,
      })
      const lock = repo.files['package-lock.json']
      expect(JSON.parse(repo.read('package-lock.json'))).toEqual({
        ...lock,
        version,
        packages: {
          ...lock.packages,
          '': { ...lock.packages[''], version },
          'tools/cli': { ...lock.packages['tools/cli'], version },
        },
      })
      expect(JSON.parse(repo.read('server.json'))).toEqual({
        ...repo.files['server.json'],
        version,
      })
    },
  )

  it('produces identical files when rerun with the same root version', () => {
    const repo = fixture()
    expect(repo.run().status).toBe(0)
    const first = repo.snapshot()
    expect(repo.run().status).toBe(0)
    expect(repo.snapshot()).toEqual(first)
  })

  it('runs the committed npm version lifecycle and leaves every mirror updated', () => {
    const repo = fixture('1.0.0')
    const manifest = JSON.parse(readFileSync(rootManifest, 'utf8')) as {
      scripts: { version?: string }
    }
    writeFileSync(
      join(repo.dir, 'package.json'),
      JSON.stringify({
        ...repo.files['package.json'],
        type: 'module',
        scripts: { version: manifest.scripts.version },
      }),
    )
    mkdirSync(join(repo.dir, 'scripts'))
    copyFileSync(script, join(repo.dir, 'scripts/sync-version.ts'))
    writeFileSync(join(repo.dir, '.npmrc'), '')
    writeFileSync(join(repo.dir, 'global.npmrc'), '')
    const version = '3.0.0-rc.1'
    const result = spawnSync('npm', ['version', version, '--no-git-tag-version', '--offline'], {
      cwd: repo.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NPM_CONFIG_USERCONFIG: join(repo.dir, '.npmrc'),
        NPM_CONFIG_GLOBALCONFIG: join(repo.dir, 'global.npmrc'),
        NPM_CONFIG_CACHE: join(repo.dir, '.npm-cache'),
        NPM_CONFIG_IGNORE_SCRIPTS: 'false',
      },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(repo.read('package.json')).version).toBe(version)
    expect(JSON.parse(repo.read('tools/cli/package.json')).version).toBe(version)
    const lock = JSON.parse(repo.read('package-lock.json'))
    expect(lock.version).toBe(version)
    expect(lock.packages[''].version).toBe(version)
    expect(lock.packages['tools/cli'].version).toBe(version)
    expect(JSON.parse(repo.read('server.json')).version).toBe(version)
  })

  it('does not synchronize files merely by importing the module', () => {
    const repo = fixture()
    const before = repo.snapshot()
    const url = pathToFileURL(script).href
    expect(
      repo.run('--input-type=module', '--eval', `await import(${JSON.stringify(url)})`).status,
    ).toBe(0)
    expect(repo.snapshot()).toEqual(before)
  })
})
