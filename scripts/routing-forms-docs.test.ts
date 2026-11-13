import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BODY_LIMIT } from '../apps/server/src/body-limit.ts'
import {
  ROUTING_RECEIPT_PURGE_BATCH,
  ROUTING_VERSION_CLEANUP_BATCH,
  ROUTING_VERSION_SCAN_BATCH,
} from '../packages/db/src/routing-lifecycle.ts'
import { assertRoutingStorageLimits } from '../packages/db/src/routing-storage-limits.ts'
import {
  ROUTING_RETENTION_CRON,
  ROUTING_RETENTION_RUN,
} from '../packages/jobs/src/routing-retention.ts'

const document = readFileSync(new URL('../docs/routing-forms.md', import.meta.url), 'utf8')
// Prose checks ignore line wrapping.
const prose = document.replaceAll(/\s+/g, ' ')
const limits = {
  forms_per_organization: 100,
  total_forms_per_organization: 1000,
  versions_per_form: 1000,
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

function documentedCap(source: string) {
  return Number(source.match(/^\| submission_bytes \| (\d+) \|/m)?.[1])
}

// The largest legal submission: every question is short text at its maximum length, filled
// with a BMP CJK character (3 UTF-8 bytes per UTF-16 code unit, the most any allowed
// character takes unescaped; select answers are 36-character option UUIDs).
function largestSubmission() {
  const answers = Object.fromEntries(
    Array.from({ length: limits.questions_per_form }, (_, index) => [
      `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      '汉'.repeat(limits.text_answer_length),
    ]),
  )
  return { versionId: '00000000-0000-4000-8000-000000000000', answers }
}

// apps/server/src/body-limit.ts: a limit must fit the largest legal request with every
// character escaped as \uXXXX (6 bytes per UTF-16 code unit), so keys are escaped too.
function escapeEveryCharacter(value: unknown): string {
  if (typeof value === 'string')
    return `"${Array.from({ length: value.length }, (_, i) => `\\u${value.charCodeAt(i).toString(16).padStart(4, '0')}`).join('')}"`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([key, item]) => `${escapeEveryCharacter(key)}:${escapeEveryCharacter(item)}`)
      .join(',')}}`
  throw new Error('unexpected value')
}

describe('routing design numeric contract', () => {
  it('binds storage limits to the data model', () => {
    const dataModel = readFileSync(new URL('../docs/data-model.md', import.meta.url), 'utf8')
    assertRoutingStorageLimits(document, dataModel)
    for (const phrase of [
      '100 non-archived forms',
      '1000 total forms',
      '1000 published versions',
    ]) {
      expect(dataModel).toContain(`**${phrase}**`)
      expect(() =>
        assertRoutingStorageLimits(document, dataModel.replace(`**${phrase}**`, `**9${phrase}**`)),
      ).toThrow()
      assertRoutingStorageLimits(document, dataModel)
    }
    for (const key of [
      'forms_per_organization',
      'total_forms_per_organization',
      'versions_per_form',
    ] as const) {
      const anchor = `| ${key} | ${limits[key]} |`
      expect(() =>
        assertRoutingStorageLimits(
          document.replace(anchor, `| ${key} | ${limits[key] + 1} |`),
          dataModel,
        ),
      ).toThrow()
      assertRoutingStorageLimits(document, dataModel)
    }
  })

  it('pins the complete numeric limit register for later implementation', () => {
    verifyLimits(document)
  })

  it('fits the largest submission as ordinary UTF-8 JSON inside the documented cap', () => {
    const bytes = Buffer.byteLength(JSON.stringify(largestSubmission()), 'utf8')
    expect(bytes).toBe(30_904)
    expect(prose).toContain('30,904 bytes as ordinary UTF-8 JSON')
    expect(bytes).toBeLessThanOrEqual(documentedCap(document))
  })

  it('fits the largest submission with every character escaped inside the documented cap', () => {
    const submission = largestSubmission()
    const escaped = escapeEveryCharacter(submission)
    expect(JSON.parse(escaped)).toEqual(submission)
    // Nothing is left unescaped: only JSON structure remains once escapes are removed.
    expect(escaped.replaceAll(/\\u[0-9a-f]{4}/g, '')).toMatch(/^[{}:,"]+$/)
    const bytes = Buffer.byteLength(escaped, 'utf8')
    expect(bytes).toBe(64_764)
    expect(prose).toContain('64,764 bytes with every character of every string')
    expect(bytes).toBeLessThanOrEqual(documentedCap(document))
  })

  it('keeps the cap equal to the server default body limit the document relies on', () => {
    expect(prose).toContain(
      "It equals the server's default `/api` body limit (`DEFAULT_BODY_LIMIT`",
    )
    expect(documentedCap(document)).toBe(DEFAULT_BODY_LIMIT)
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

// Step a4's cleanup bounds, stated in the design and pinned to the code that applies them.
function verifyRetention(source: string) {
  const text = source.replaceAll(/\s+/g, ' ')
  const minutes = Number(text.match(/Cleanup runs every (\d+) minutes/)?.[1])
  expect(ROUTING_RETENTION_CRON).toBe(`*/${minutes} * * * *`)
  // The purge never lags expiry by more than the documented grace, backlog aside.
  expect(minutes).toBeLessThanOrEqual(limits.purge_grace_hours * 60)
  // A superseded publication's replay lasts until the next run deletes its version.
  expect(Number(text.match(/the next cleanup run, normally within (\d+) minutes/)?.[1])).toBe(
    minutes,
  )
  expect(Number(text.match(/deletes at most (\d+) receipts that expired unconsumed/)?.[1])).toBe(
    ROUTING_RECEIPT_PURGE_BATCH,
  )
  const versions = text.match(/examines at most (\d+) versions and deletes at most (\d+)/)
  expect(Number(versions?.[1])).toBe(ROUTING_VERSION_SCAN_BATCH)
  expect(Number(versions?.[2])).toBe(ROUTING_VERSION_CLEANUP_BATCH)
  const run = text.match(/A run stops after (\d+) transactions or (\d+) seconds/)
  expect(Number(run?.[1])).toBe(ROUTING_RETENTION_RUN.transactions)
  expect(Number(run?.[2]) * 1000).toBe(ROUTING_RETENTION_RUN.budgetMs)
}

describe('routing retention bounds', () => {
  it('states the cleanup cadence and batch sizes the code uses', () => {
    expect(ROUTING_RECEIPT_PURGE_BATCH).toBe(500)
    expect(ROUTING_VERSION_SCAN_BATCH).toBe(1000)
    expect(ROUTING_VERSION_CLEANUP_BATCH).toBe(100)
    expect(ROUTING_RETENTION_RUN).toEqual({ transactions: 100, budgetMs: 45_000 })
    verifyRetention(document)
  })

  it.each([
    ['cadence', 'Cleanup runs every 15 minutes', 'Cleanup runs every 30 minutes'],
    ['receipt batch', 'deletes at most 500', 'deletes at most 5000'],
    ['version scan', 'examines at most 1000', 'examines at most 100'],
    ['version batch', 'deletes at most 100 that', 'deletes at most 1000 that'],
    ['run bound', 'after 100 transactions', 'after 1000 transactions'],
    ['run budget', 'or 45 seconds', 'or 55 seconds'],
    ['replay window', 'normally within 15 minutes', 'normally within 60 minutes'],
  ])('rejects source-copy drift of the %s', (_name, from, to) => {
    expect(prose.split(from)).toHaveLength(2)
    expect(() => verifyRetention(prose.replace(from, to))).toThrow()
    verifyRetention(prose)
  })
})
