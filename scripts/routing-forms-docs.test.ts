import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const document = readFileSync(new URL('../docs/routing-forms.md', import.meta.url), 'utf8')
const limits = {
  questions_per_form: 20,
  options_per_question: 50,
  rules_per_form: 50,
  conditions_per_rule: 10,
  label_length: 200,
  text_answer_length: 500,
  message_length: 2000,
  submission_bytes: 16384,
  route_lifetime_minutes: 30,
  purge_grace_hours: 24,
}

function verifyLimits(source: string) {
  const rows = [...source.matchAll(/^\| ([a-z_]+) \| (\d+) \|/gm)]
  expect(rows.length).toBe(Object.keys(limits).length)
  expect(Object.fromEntries(rows.map(([, key, value]) => [key, Number(value)]))).toEqual(limits)
}

describe('routing design numeric contract', () => {
  it('pins the complete numeric limit register for later implementation', () => {
    verifyLimits(document)
  })

  it.each(Object.entries(limits))('rejects source-copy drift of %s', (key, value) => {
    const anchor = `| ${key} | ${value} |`
    expect(document.includes(anchor)).toBe(true)
    const changed = document.replace(anchor, `| ${key} | ${value + 1} |`)
    expect(() => verifyLimits(changed)).toThrow()
    const removed = document.replace(anchor, `| removed_${key} | ${value} |`)
    expect(() => verifyLimits(removed)).toThrow()
    verifyLimits(document)
  })
})
