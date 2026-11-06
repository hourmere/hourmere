import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { verifyTree } = require('../scripts/verify-build.js')
const manifest = require('../package.json')

describe('deployment protections', () => {
  it('registers the guard with the CLI build lifecycle', () => {
    expect(manifest.scripts['_zapier-build']).toBe('node scripts/guard-build.js')
  })
  it('refuses the CLI build hook unless explicitly approved', () => {
    const result = spawnSync(process.execPath, ['scripts/guard-build.js'], {
      env: { ...process.env, HOURMERE_ZAPIER_PUSH_APPROVED: '' },
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('requires explicit HOURMERE_ZAPIER_PUSH_APPROVED=1')
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
