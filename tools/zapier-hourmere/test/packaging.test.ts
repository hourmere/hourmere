import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { verifyTree, verifyBuild, ARTIFACTS } = require('../scripts/verify-build.js')
const manifest = require('../package.json')

describe('deployment protections', () => {
  it('registers the guard with the CLI build lifecycle', () => {
    expect(manifest.scripts['_zapier-build']).toBe('node scripts/guard-build.js')
  })
  it('guards upload, which runs no CLI hook, before the CLI starts', () => {
    expect(manifest.scripts.upload).toBe('node scripts/guard-build.js && zapier-platform upload')
  })
  it('refuses the CLI build hook unless explicitly approved', () => {
    const result = spawnSync(process.execPath, ['scripts/guard-build.js'], {
      env: { ...process.env, HOURMERE_ZAPIER_PUSH_APPROVED: '' },
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'Build, push and upload require explicit HOURMERE_ZAPIER_PUSH_APPROVED=1',
    )
  })
  it('allows the explicitly approved CLI build hook', () => {
    const result = spawnSync(process.execPath, ['scripts/guard-build.js'], {
      env: { ...process.env, HOURMERE_ZAPIER_PUSH_APPROVED: '1' },
    })
    expect(result.status).toBe(0)
  })
  it('rejects an artifact whose production dependency differs from the committed lock', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hourmere-zapier-lock-test-'))
    try {
      mkdirSync(join(directory, 'node_modules/example'), { recursive: true })
      writeFileSync(join(directory, 'node_modules/example/package.json'), '{"version":"2.0.0"}')
      const lock = {
        packages: {
          'node_modules/example': { version: '1.0.0' },
          'node_modules/optional-other-platform': { version: '1.0.0', optional: true },
        },
      }
      expect(() => verifyTree(directory, lock)).toThrow('Built dependency differs from lock')
      lock.packages['node_modules/example'].version = '2.0.0'
      expect(() => verifyTree(directory, lock)).not.toThrow()
      mkdirSync(join(directory, 'node_modules/unlocked'), { recursive: true })
      writeFileSync(join(directory, 'node_modules/unlocked/package.json'), '{"version":"1.0.0"}')
      expect(() => verifyTree(directory, lock)).toThrow(
        'Built production dependency set differs from lock',
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('build verification leaves nothing to upload', () => {
  const lock = { packages: { '': {}, 'node_modules/example': { version: '1.0.0' } } }
  // Stand-ins for the CLI build and unzip: write the archives, then the extracted tree.
  const build =
    (cwd: string, fail = false) =>
    async () => {
      mkdirSync(join(cwd, 'build'), { recursive: true })
      for (const artifact of ARTIFACTS) writeFileSync(join(cwd, artifact), 'synthetic archive')
      if (fail) throw new Error('synthetic build failure')
    }
  const extract = (version: string) => async (_zip: string, target: string) => {
    mkdirSync(join(target, 'node_modules/example'), { recursive: true })
    writeFileSync(join(target, 'node_modules/example/package.json'), JSON.stringify({ version }))
  }
  const withPackage = async (test: (cwd: string) => Promise<void>) => {
    const cwd = mkdtempSync(join(tmpdir(), 'hourmere-zapier-verify-test-'))
    try {
      await test(cwd)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  it('removes the archives and the build directory it created after a passing check', () =>
    withPackage(async (cwd) => {
      await verifyBuild({ cwd, lock, build: build(cwd), extract: extract('1.0.0') })
      expect(existsSync(join(cwd, 'build'))).toBe(false)
    }))
  it('removes the archives when the dependency check fails', () =>
    withPackage(async (cwd) => {
      await expect(
        verifyBuild({ cwd, lock, build: build(cwd), extract: extract('2.0.0') }),
      ).rejects.toThrow('Built dependency differs from lock')
      expect(existsSync(join(cwd, 'build'))).toBe(false)
    }))
  it('removes the archives when the build fails and keeps unrelated build files', () =>
    withPackage(async (cwd) => {
      mkdirSync(join(cwd, 'build'))
      writeFileSync(join(cwd, 'build/notes.txt'), 'operator file')
      await expect(
        verifyBuild({ cwd, lock, build: build(cwd, true), extract: extract('1.0.0') }),
      ).rejects.toThrow('synthetic build failure')
      expect(readdirSync(join(cwd, 'build'))).toEqual(['notes.txt'])
    }))
})
