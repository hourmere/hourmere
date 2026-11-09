import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { checkStorageInterfaces, STORAGE_MIGRATION } from './check-storage-interfaces.ts'

const runner = readFileSync(new URL('./check-storage-interfaces.ts', import.meta.url), 'utf8')
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

function verifyWorkflow(source: string) {
  const parsed = parse(source)
  const step = parsed.jobs.check.steps.find(
    (candidate: { run?: string }) =>
      candidate.run === 'node scripts/check-storage-interfaces.ts "$HOURMERE_PARITY_BASE"',
  )
  expect(step).toBeDefined()
  expect(step.if).toBeUndefined()
  expect(step['continue-on-error']).toBeUndefined()
}

describe('storage interface CI applicability', () => {
  it('compares changed migration refs and skips unchanged refs', async () => {
    // Real HEAD archive and snapshots; only git's event diff is controlled so this
    // remains useful after the storage migration has merged into main.
    const git = (...args: string[]) => {
      if (args[0] === 'merge-base') return 'HEAD'
      expect(args).toEqual(['diff', '--name-only', 'HEAD', 'HEAD', '--', STORAGE_MIGRATION])
      return STORAGE_MIGRATION
    }
    await expect(checkStorageInterfaces('event-base', git)).resolves.toBe(true)
    await expect(
      checkStorageInterfaces('event-base', (...args) => (args[0] === 'merge-base' ? 'HEAD' : '')),
    ).resolves.toBe(false)
    await expect(checkStorageInterfaces('HEAD')).resolves.toBe(false)
  })

  it('kills a source-copy bypass of the migration applicability check', () => {
    const start = runner.indexOf('  const ancestor = git(')
    const end = runner.indexOf('\n  const directory =', start)
    const scope = runner.slice(start, end)
    expect(scope).toContain('if (!changed) return false')
    const evaluate = (source: string, changed: string) =>
      new Function('git', 'base', 'STORAGE_MIGRATION', `${source}; return true`)(
        (...args: string[]) => (args[0] === 'merge-base' ? 'HEAD' : changed),
        'event-base',
        STORAGE_MIGRATION,
      )
    const verify = (source: string) => {
      expect(evaluate(source, STORAGE_MIGRATION)).toBe(true)
      expect(evaluate(source, '')).toBe(false)
    }
    verify(scope)
    expect(() => verify(scope.replace('if (!changed) return false', 'return false'))).toThrow()
    expect(() => verify(scope.replace('if (!changed) return false', ''))).toThrow()
  })

  it('requires an unconditional, failing CI comparison step', () => {
    verifyWorkflow(workflow)
    const anchor = '      - name: Storage-only interfaces match the event base\n'
    expect(workflow).toContain(anchor)
    expect(() => verifyWorkflow(workflow.replace(anchor, `${anchor}        if: false\n`))).toThrow()
    expect(() =>
      verifyWorkflow(workflow.replace(anchor, `${anchor}        continue-on-error: true\n`)),
    ).toThrow()
  })
})
