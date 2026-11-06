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
  submission_bytes: 65536,
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

  it('fits a fully filled Chinese form inside the documented body cap', () => {
    const answers = Object.fromEntries(
      Array.from({ length: limits.questions_per_form }, (_, index) => [
        `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        '汉'.repeat(limits.text_answer_length),
      ]),
    )
    const body = JSON.stringify({ versionId: '00000000-0000-4000-8000-000000000000', answers })
    const documentedCap = Number(document.match(/^\| submission_bytes \| (\d+) \|/m)?.[1])
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(documentedCap)
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
