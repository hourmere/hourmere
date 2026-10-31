import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const source = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const zero = '0'.repeat(40)
const before = 'a'.repeat(40)
const prBase = 'b'.repeat(40)
const mergeBase = 'c'.repeat(40)

function verify(copy: string) {
  const { jobs } = parse(copy) as {
    jobs: {
      check: {
        env: { HOURMERE_PARITY_BASE: string }
        steps: { uses?: string; with?: { 'fetch-depth'?: number } }[]
      }
    }
  }
  expect(
    jobs.check.steps.find(({ uses }) => uses?.startsWith('actions/checkout@'))?.with,
  ).toMatchObject({
    'fetch-depth': 0,
  })
  const expression = jobs.check.env.HOURMERE_PARITY_BASE.match(/^\$\{\{(.*)\}\}$/)?.[1]
  expect(expression).toBeDefined()
  // This workflow expression uses only property access, string equality, &&/|| and
  // startsWith, whose string-input semantics match JavaScript for these event fixtures.
  const evaluate = new Function('github', 'startsWith', `return (${expression})`) as (
    github: unknown,
    startsWith: (value: string, prefix: string) => boolean,
  ) => string
  for (const [name, ref, prior, pullRequest, mergeGroup, expected] of [
    ['pull request', 'refs/pull/187/merge', '', prBase, '', prBase],
    ['merge group', 'refs/heads/gh-readonly-queue/main/example', before, '', mergeBase, mergeBase],
    ['branch push', 'refs/heads/main', before, '', '', before],
    ['new branch', 'refs/heads/main', zero, '', '', 'origin/main'],
    ['release tag', 'refs/tags/v1.0.0', zero, '', '', 'origin/main'],
    ['existing tag', 'refs/tags/v1.0.0', before, '', '', 'origin/main'],
    ['reusable fallback', 'refs/heads/main', '', '', '', 'origin/main'],
  ] as const) {
    expect(
      evaluate(
        {
          ref,
          event: {
            before: prior,
            pull_request: { base: { sha: pullRequest } },
            merge_group: { base_sha: mergeGroup },
          },
        },
        (value, prefix) => value.startsWith(prefix),
      ),
      name,
    ).toBe(expected)
  }
}

describe('parity gap baseline in CI', () => {
  it('fetches history and selects resolvable bases for PRs, queues, pushes and release tags', () => {
    verify(source)
  })

  for (const [name, from, to] of [
    ['history', 'fetch-depth: 0', 'fetch-depth: 1'],
    ['PR base', 'github.event.pull_request.base.sha || ', ''],
    ['merge-group base', 'github.event.merge_group.base_sha || ', ''],
    ['tag fallback', "startsWith(github.ref, 'refs/heads/') && ", ''],
    ['zero-SHA fallback', `github.event.before != '${zero}' && `, ''],
    ['branch push base', ' && github.event.before)', ')'],
  ] as const) {
    it(`detects removal of ${name}`, () => {
      const mutant = source.replace(from, to)
      expect(mutant).not.toBe(source)
      expect(() => verify(mutant)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    })
  }
})
