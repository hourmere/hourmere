import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  archiveBaseline,
  assertStorageMigrationExists,
  checkStorageInterfaces,
  STORAGE_MIGRATION,
} from './check-storage-interfaces.ts'
import {
  INTERFACE_SURFACES,
  type StorageInterfaceSnapshot,
  storageInterfaceSnapshot,
} from './storage-interface-snapshot.ts'

const runner = readFileSync(new URL('./check-storage-interfaces.ts', import.meta.url), 'utf8')
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const root = new URL('..', import.meta.url)
const realGit = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const head = realGit('rev-parse', 'HEAD')
// Any real commit other than HEAD; CI's check job fetches the full history.
const parent = realGit('rev-parse', 'HEAD~1')
const SAME_AS_HEAD = 'Storage interface baseline must differ from HEAD'

// Controls the event's merge base and migration diff; every other git call is real.
const eventGit =
  (ancestor: string, changed = STORAGE_MIGRATION, reportedHead = head) =>
  (...args: string[]) => {
    if (args[0] === 'merge-base') return ancestor
    if (args[0] === 'diff') {
      expect(args).toEqual(['diff', '--name-only', ancestor, 'HEAD', '--', STORAGE_MIGRATION])
      return changed
    }
    if (args.join(' ') === 'rev-parse HEAD') return reportedHead
    return realGit(...args)
  }
// Stands in for the archive build: records the requested commits and writes `snapshot`.
const baselineOf =
  (snapshot: StorageInterfaceSnapshot) =>
  (ancestor: string, baselineHead: string, _directory: string, output: string) => {
    expect([ancestor, baselineHead]).toEqual([parent, head])
    writeFileSync(output, JSON.stringify(snapshot))
  }
const unreachable = () => {
  throw new Error('Baseline must not be built')
}

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
  it('passes a merge-base baseline whose interfaces equal HEAD', async () => {
    const writeBaseline = baselineOf(await storageInterfaceSnapshot())
    await expect(
      checkStorageInterfaces('event-base', eventGit(parent), { writeBaseline }),
    ).resolves.toBe(true)
  })

  it.each(INTERFACE_SURFACES)(
    'rejects a merge-base baseline that differs in %s',
    async (surface) => {
      const current = await storageInterfaceSnapshot()
      const writeBaseline = baselineOf({ ...current, [surface]: `${current[surface]} ` })
      await expect(
        checkStorageInterfaces('event-base', eventGit(parent), { writeBaseline }),
      ).rejects.toThrow(`Storage-only change altered ${surface}`)
    },
  )

  it('skips refs that do not change the storage migration', async () => {
    await expect(
      checkStorageInterfaces('event-base', eventGit(parent, ''), { writeBaseline: unreachable }),
    ).resolves.toBe(false)
    await expect(checkStorageInterfaces('HEAD')).resolves.toBe(false)
  })

  it('requires the watched storage migration to exist', async () => {
    expect(existsSync(new URL(STORAGE_MIGRATION, root))).toBe(true)
    expect(() => assertStorageMigrationExists()).not.toThrow()
    const misspelled = STORAGE_MIGRATION.replace('routing_forms', 'routing_form')
    expect(() => assertStorageMigrationExists(misspelled)).toThrow(
      `Storage migration ${misspelled} does not exist`,
    )
    await expect(
      checkStorageInterfaces('event-base', eventGit(parent), {
        migration: misspelled,
        writeBaseline: unreachable,
      }),
    ).rejects.toThrow(`Storage migration ${misspelled} does not exist`)
  })

  it('refuses a baseline equal to HEAD', async () => {
    await expect(
      checkStorageInterfaces('event-base', eventGit(head), { writeBaseline: unreachable }),
    ).rejects.toThrow(SAME_AS_HEAD)
    expect(() => archiveBaseline(head, head)).toThrow(SAME_AS_HEAD)
  })

  it('archives the merge-base commit itself, never HEAD or a bare tree', () => {
    const archive = archiveBaseline(parent, head)
    expect(
      execFileSync('git', ['get-tar-commit-id'], {
        cwd: root,
        input: archive.subarray(0, 1024),
        encoding: 'utf8',
      }).trim(),
    ).toBe(parent)
    expect(() => archiveBaseline(`${parent}^{tree}`, head)).toThrow(
      `Storage interface baseline archive is not a commit, expected ${parent}^{tree}`,
    )
  })

  it('builds the real baseline from an isolated archive', async () => {
    // HEAD's own commit is the only baseline whose interfaces equal the checkout whatever
    // later history does, so this run reports a different HEAD to the self-check.
    await expect(
      checkStorageInterfaces('event-base', eventGit(head, STORAGE_MIGRATION, '0'.repeat(40))),
    ).resolves.toBe(true)
  })

  it('kills a source-copy bypass of the migration applicability check', () => {
    const start = runner.indexOf('  const ancestor = git(')
    const end = runner.indexOf('\n  const directory =', start)
    const scope = runner.slice(start, end)
    expect(scope).toContain('if (!changed) return false')
    const evaluate = (source: string, changed: string) =>
      new Function('git', 'base', 'migration', 'SAME_AS_HEAD', `${source}; return true`)(
        (...args: string[]) =>
          args[0] === 'merge-base' ? 'base-sha' : args[0] === 'rev-parse' ? 'head-sha' : changed,
        'event-base',
        STORAGE_MIGRATION,
        SAME_AS_HEAD,
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
