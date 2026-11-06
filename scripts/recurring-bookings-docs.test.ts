import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const document = readFileSync(new URL('../docs/recurring-bookings.md', import.meta.url), 'utf8')

// Proposed design facts only; runtime constants must be compared here when implemented.
const bounds = [
  ['Minimum occurrences', 2],
  ['Maximum occurrences', 12],
  ['Maximum horizon in local calendar days', 366],
  ['Maximum candidate hosts', 8],
  ['Maximum occurrence-host evaluations', 96],
  ['Maximum batch database read statements', 32],
  ['Maximum batch fact rows', 10000],
  ['Batch deadline in milliseconds', 5000],
] as const

function verifyBounds(source: string) {
  const section = source.split('### Normative bounds\n')[1]?.split(/^#{1,3} /m)[0]
  expect(section, 'normative bounds section exists').toBeDefined()
  const rows = [...(section ?? '').matchAll(/^\| ([^|]+) \| (\d+) \|[^\n]*$/gm)].map(
    ([, label, value]) => [label, Number(value)],
  )
  expect(rows, 'all proposed numeric bounds match the reviewed design').toEqual(bounds)
}

describe('recurring booking design bounds', () => {
  it('pins all eight numeric facts in the normative table', () => {
    verifyBounds(document)
  })

  it.each(bounds)('detects a changed %s in an isolated document copy', (label, value) => {
    const anchor = `| ${label} | ${value} |`
    expect(document.split(anchor), 'exactly one mutation anchor').toHaveLength(2)
    const mutated = document.replace(anchor, `| ${label} | ${value + 1} |`)
    expect(() => verifyBounds(mutated)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    verifyBounds(document)
  })
})
