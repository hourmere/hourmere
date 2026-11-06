import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const document = readFileSync(new URL('../docs/meeting-polls.md', import.meta.url), 'utf8')

const limits = [
  ['Candidates per poll', '2–20'],
  ['Voters per poll', '1–11'],
  ['Deadline after creation', '1 hour–30 days'],
  ['Reminder lead time', '24 hours'],
] as const

function verifyLimit(source: string, label: string, value: string) {
  const rows = source
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => cells[0] === label)
  expect(rows, `${label}: exactly one limit row`).toHaveLength(1)
  expect(rows[0]?.[1], label).toBe(value)
}

function verifyLimits(source: string) {
  for (const [label, value] of limits) verifyLimit(source, label, value)
}

describe('meeting poll design numeric limits', () => {
  it.each(limits)('pins %s to %s', (label, value) => {
    verifyLimit(document, label, value)
  })

  it.each([
    ['candidate minimum', 'Candidates per poll', '2–20', '1–20'],
    ['candidate maximum', 'Candidates per poll', '2–20', '2–21'],
    ['voter minimum', 'Voters per poll', '1–11', '0–11'],
    ['voter maximum', 'Voters per poll', '1–11', '1–12'],
    ['deadline minimum', 'Deadline after creation', '1 hour–30 days', '2 hours–30 days'],
    ['deadline maximum', 'Deadline after creation', '1 hour–30 days', '1 hour–31 days'],
    ['reminder lead time', 'Reminder lead time', '24 hours', '48 hours'],
  ])('rejects a source-copy change to the %s', (_name, label, before, after) => {
    verifyLimits(document)
    const mutated = document
      .split('\n')
      .map((line) => {
        const cells = line.split('|')
        if (cells[1]?.trim() !== label) return line
        cells[2] = cells[2]?.replace(before, after) ?? ''
        return cells.join('|')
      })
      .join('\n')
    expect(mutated, 'source-copy mutation must change the limit').not.toBe(document)
    expect(() => verifyLimits(mutated)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    verifyLimits(document)
  })
})
