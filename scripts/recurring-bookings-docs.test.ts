import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../apps/server/src/config.ts'
import { PUBLIC_RATE_LIMITS } from '../apps/server/src/rate-limit.ts'
import type { Db } from '../packages/db/src/index.ts'
import {
  notificationEmailBudget,
  notificationSuppressionReason,
} from '../packages/notifications/src/mail-limits.ts'
import { MAX_SLOT_RANGE_DAYS } from '../packages/scheduling/src/availability.ts'
import { MAX_GUESTS } from '../packages/scheduling/src/bookings.ts'
import { hasValidHostShape } from '../packages/scheduling/src/hosts.ts'

const document = readFileSync(new URL('../docs/recurring-bookings.md', import.meta.url), 'utf8')
const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8')

// Proposed design values only. The step that first enforces one adds a shared constant and
// compares that constant here instead of the literal.
const proposed = [
  ['Minimum occurrences', 2],
  ['Maximum occurrences', 12],
  ['Maximum horizon in local calendar days', 366],
  ['Maximum occurrence-host evaluations', 96],
  ['Maximum batch database read statements', 32],
  ['Maximum batch fact rows', 10000],
  ['Batch deadline in milliseconds', 5000],
  ['Series admissions per rolling hour per actor and event', 2],
  ['Series confirmation conference wait in minutes', 30],
  ['Series confirmation lead before the first start in minutes', 15],
  ['Imminent-start confirmation wait in minutes', 5],
  ['Urgent link-update window before a start in minutes', 60],
  ['Minimum minutes between series link-update mails', 60],
  ['Maximum series link-update mails per rolling day', 3],
] as const

type ProposedLabel = (typeof proposed)[number][0]
const design = (label: ProposedLabel) => proposed.find(([name]) => name === label)?.[1] as number

// Weekly is the densest supported pattern, so members are at least this far apart.
const MINIMUM_MEMBER_GAP_MINUTES = 7 * 24 * 60

function largestHostCount(mode: string) {
  let largest = 0
  for (let count = 1; count <= 64; count++)
    if (
      hasValidHostShape(
        mode,
        Array.from({ length: count }, (_, i) => `host-${i}`),
      )
    )
      largest = count
  return largest
}

/**
 * Runs the real `notificationEmailBudget` against a recording query builder, so the ledger
 * windows come from the code: every `sent_at` cutoff it applies, with its comparison.
 */
async function readLedgerWindows() {
  const now = new Date('2027-01-04T12:00:00Z')
  const cutoffs: { op: string; minutes: number }[] = []
  const record = (column: unknown, op: unknown, value: unknown) => {
    if (column === 'sent_at' && value instanceof Date)
      cutoffs.push({ op: String(op), minutes: (now.getTime() - value.getTime()) / 60_000 })
  }
  const expression = {
    as: () => expression,
    filterWhere: (column: unknown, op: unknown, value: unknown) => {
      record(column, op, value)
      return expression
    },
  }
  const builder = { fn: { countAll: () => expression } }
  const query = {
    selectFrom: () => query,
    select: (fields: unknown) => {
      if (typeof fields === 'function') fields(builder)
      return query
    },
    where: (column: unknown, op: unknown, value: unknown) => {
      record(column, op, value)
      return query
    },
    executeTakeFirstOrThrow: async () => ({ count: '0', hour: '0', day: '0' }),
  }
  await notificationEmailBudget(query as unknown as Db, {}, Buffer.alloc(32), true, now)
  return cutoffs
}

const ledger = await readLedgerWindows()

/** Existing limits this design depends on, read from today's code and defaults. */
function readCodeFacts() {
  const config = loadConfig({
    DATABASE_URL: 'postgres://hourmere@localhost:5432/hourmere',
    BETTER_AUTH_SECRET: 'a'.repeat(32),
  })
  return {
    hosts: largestHostCount('collective'),
    guests: MAX_GUESTS,
    recipientHour: config.MAIL_RECIPIENT_MAX_PER_HOUR,
    recipientDay: config.MAIL_RECIPIENT_MAX_PER_DAY,
    instanceHour: config.MAIL_MAX_PER_HOUR,
    book: PUBLIC_RATE_LIMITS.book.limit,
    slots: PUBLIC_RATE_LIMITS.slots.limit,
    manage: PUBLIC_RATE_LIMITS.manage.limit,
    slotRangeDays: MAX_SLOT_RANGE_DAYS,
    // The instance-wide and per-recipient rolling-hour cutoffs, then the rolling day.
    ledgerHourMinutes: ledger[0]?.minutes ?? Number.NaN,
  }
}

type CodeFacts = ReturnType<typeof readCodeFacts>
const facts = readCodeFacts()

const existing = [
  ['Maximum candidate hosts', 'hosts'],
  ['Maximum guests besides the booker', 'guests'],
  ['Invitee mail per recipient per rolling hour', 'recipientHour'],
  ['Invitee mail per recipient per rolling day', 'recipientDay'],
  ['Instance mail per rolling hour', 'instanceHour'],
  ['Public booking requests per IP per 60 seconds', 'book'],
  ['Public slot requests per IP per 60 seconds', 'slots'],
  ['Public manage requests per IP per 60 seconds', 'manage'],
  ['Maximum slot search range in days', 'slotRangeDays'],
] as const satisfies readonly (readonly [string, keyof CodeFacts])[]

function section(source: string, heading: string) {
  const body = source.split(`\n### ${heading}\n`)[1]?.split(/^#{1,3} /m)[0]
  expect(body, `${heading} section exists`).toBeDefined()
  return body ?? ''
}

function numericRows(body: string, columns: number) {
  const cells = ' (\\d+) \\|'.repeat(columns)
  const pattern = new RegExp(`^\\| ([^|]+) \\|${cells}[^\\n]*$`, 'gm')
  return [...body.matchAll(pattern)].map(([, label, ...values]) => [label, ...values.map(Number)])
}

function verifyProposed(source: string) {
  expect(
    numericRows(section(source, 'Proposed limits'), 1),
    'all proposed numeric bounds match the reviewed design',
  ).toEqual(proposed)
}

function verifyExisting(source: string, code: CodeFacts) {
  expect(
    numericRows(section(source, 'Existing limits'), 1),
    'every existing limit in the design matches its source',
  ).toEqual(existing.map(([label, key]) => [label, code[key]]))
}

/**
 * Worst rolling hour for one invitee recipient when `seriesCount` series (at most the
 * admission cap) each send a confirmation, one urgent link update and a whole-series cancel,
 * over every interleaving. An urgent update goes out only while the count leaves room for
 * one cancellation per series the cap allows (`roomCheck`); otherwise it waits and is later
 * skipped by the cancellation.
 */
function simulateHour(code: CodeFacts, seriesCount: number, roomCheck = true) {
  const cap = design('Series admissions per rolling hour per actor and event')
  const threshold = roomCheck ? code.recipientHour - 1 - cap : Number.POSITIVE_INFINITY
  const steps = ['confirmation', 'urgent', 'cancel'] as const
  let worst = 0
  let suppressed = false
  const walk = (positions: readonly number[], count: number) => {
    let finished = true
    positions.forEach((position, index) => {
      const step = steps[position]
      if (step === undefined) return
      finished = false
      const next = positions.map((value, other) => (other === index ? value + 1 : value))
      if (step === 'urgent') walk(next, count <= threshold ? count + 1 : count)
      else {
        if (count >= code.recipientHour) suppressed = true
        walk(next, count + 1)
      }
    })
    if (finished) worst = Math.max(worst, count)
  }
  walk(
    Array.from({ length: seriesCount }, () => 0),
    0,
  )
  return { worst, suppressed }
}

/** The mail proof, derived from the code limits and the proposed series rules. */
function mailProof(
  code: CodeFacts,
  spacing = design('Minimum minutes between series link-update mails'),
) {
  const occurrences = design('Maximum occurrences')
  const cap = design('Series admissions per rolling hour per actor and event')
  const digests = design('Maximum series link-update mails per rolling day')
  const perMail = 1 + code.guests + code.hosts
  const window = code.ledgerHourMinutes
  // Regular series mail (confirmation and regular link updates) shares one slot per rolling
  // hour only when spaced by at least the ledger window.
  const regularPerHour = Math.ceil(window / Math.min(spacing, window))
  // Members are at least a week apart, so one series has at most one urgent member per hour.
  const urgentPerHour = Math.ceil(
    (design('Urgent link-update window before a start in minutes') + window) /
      MINIMUM_MEMBER_GAP_MINUTES,
  )
  const oneSeries = regularPerHour + urgentPerHour + 1
  // The simulation models one regular mail and one urgent update per series.
  const simulated = simulateHour(code, cap)
  const capHour = regularPerHour === 1 && urgentPerHour === 1 ? simulated.worst : Number.NaN
  const ruleMaxDay = 1 + digests + 1
  const accepted = [
    ['Create', 1, 1, perMail, perMail],
    ['Create, then whole-series cancel in the same hour', 2, 2, 2 * perMail, 2 * perMail],
    [
      'Two series created and cancelled in one hour (the admission cap)',
      2 * cap,
      2 * cap,
      2 * cap * perMail,
      2 * cap * perMail,
    ],
    [
      `All ${occurrences} automatic conferences fail, the host repairs all, then whole-series cancel`,
      regularPerHour + 1,
      3,
      (regularPerHour + 1) * perMail,
      3 * perMail,
    ],
    [
      'First start inside the lead, its link ready after the confirmation, then whole-series cancel',
      oneSeries,
      3,
      oneSeries * perMail,
      3 * perMail,
    ],
    [
      'Two such imminent series in one hour (the admission cap)',
      capHour,
      capHour,
      capHour * perMail,
      capHour * perMail,
    ],
    [
      `Series-mail maximum for one series in a day: confirmation, ${digests} link updates, whole-series cancel`,
      oneSeries,
      ruleMaxDay,
      oneSeries * perMail,
      ruleMaxDay * perMail,
    ],
    [
      'Two series at the series-mail maximum',
      capHour,
      cap * ruleMaxDay,
      capHour * perMail,
      cap * ruleMaxDay * perMail,
    ],
  ] as const
  const failureNotices = occurrences * (1 + code.hosts)
  const rejected = [
    'Rejected alternative: one failure notice per occurrence (attempted)',
    occurrences,
    occurrences,
    failureNotices,
    failureNotices,
  ] as const
  return {
    occurrences,
    perMail,
    regularPerHour,
    capHour,
    simulated,
    accepted,
    rejected,
    suppressed: occurrences - code.recipientHour,
  }
}

function verifyMailProof(source: string, code: CodeFacts, spacing?: number) {
  const proof = mailProof(code, spacing)
  expect(proof.simulated.suppressed, 'the urgent room check prevents suppression').toBe(false)
  expect(
    numericRows(section(source, 'Mail budget proof'), 4),
    'mail budget rows match the code limits',
  ).toEqual([...proof.accepted, proof.rejected])
  // A mail is suppressed only once the count before it reaches the limit.
  for (const [label, hour, day, instanceHour] of proof.accepted) {
    expect(hour, `${label}: recipient hourly limit`).toBeLessThanOrEqual(code.recipientHour)
    expect(day, `${label}: recipient daily limit`).toBeLessThanOrEqual(code.recipientDay)
    expect(instanceHour, `${label}: instance hourly limit`).toBeLessThanOrEqual(code.instanceHour)
  }
  expect(proof.rejected[1], 'the rejected alternative exceeds the limit').toBeGreaterThan(
    code.recipientHour,
  )
  const { perMail, occurrences } = proof
  const cap = design('Series admissions per rolling hour per actor and event')
  const prose = source.replace(/\s+/g, ' ')
  for (const phrase of [
    `(${1 + code.guests} invitee recipients) and ${code.hosts} collective hosts`,
    `the confirmation and regular link updates) costs at most ${proof.regularPerHour} per recipient in any rolling hour`,
    `two series at the admission cap at most ${proof.capHour}, the hourly limit itself`,
    `at most the recipient hourly limit minus 1 minus the admission cap (${code.recipientHour - 1 - cap} with defaults)`,
    `${occurrences}-occurrence/${code.guests}-guest/${code.hosts}-host`,
    `Keep ${occurrences} occurrences and ${code.guests} guests`,
    `defaults the maximum to ${occurrences}`,
    `adds ${cap} committed new series per rolling hour per actor and event`,
    `at most ${cap} new series per event per hour`,
    `gets ${cap} new series per event per hour`,
    `${perMail} instance mails`,
    `of which ${proof.suppressed} are suppressed, and attempt ${proof.rejected[3]}`,
    `produces exactly ${perMail} confirmations and then ${perMail} bulk-cancel mails`,
    `all ready gives ${perMail} confirmations with ${occurrences} entries`,
    `gives ${perMail} confirmations that carry that first member's link`,
    `deliver at most ${proof.capHour} per invitee recipient`,
    `exactly ${perMail} link-update mails`,
    `deliver exactly ${perMail} complete mails each`,
    `${3 * perMail} in total and at most ${(proof.regularPerHour + 1) * perMail} in any rolling hour`,
    `at most ${proof.capHour} per invitee recipient and ${proof.capHour * perMail} instance mails in the hour`,
  ])
    expect(prose, 'derived mail figures in the prose').toContain(phrase)
  expect(design('Maximum occurrence-host evaluations'), 'occurrences times hosts').toBe(
    occurrences * code.hosts,
  )
}

function verifyRuleProse(source: string) {
  const prose = source.replace(/\s+/g, ' ')
  for (const phrase of [
    `conference wait (${design('Series confirmation conference wait in minutes')} minutes)`,
    `lead (${design('Series confirmation lead before the first start in minutes')} minutes)`,
    `less than ${design('Series confirmation lead before the first start in minutes')} minutes away`,
    `imminent-start wait (${design('Imminent-start confirmation wait in minutes')} minutes)`,
    `starting within the next ${design('Urgent link-update window before a start in minutes')} minutes is urgent`,
    `no earlier than ${design('Minimum minutes between series link-update mails')} minutes after the previous series mail`,
    `at most ${design('Maximum series link-update mails per rolling day')} per series in any`,
    `${design('Maximum occurrence-host evaluations')} evaluations, at most ${design('Maximum batch database read statements')} reads/${design('Maximum batch fact rows')} rows, abort at ${design('Batch deadline in milliseconds')} ms`,
  ])
    expect(prose, 'proposed values in the prose').toContain(phrase)
}

function verify(source: string, code: CodeFacts) {
  verifyProposed(source)
  verifyExisting(source, code)
  verifyMailProof(source, code)
  verifyRuleProse(source)
}

const assertionFailure = expect.objectContaining({ name: 'AssertionError' })

describe('recurring booking design bounds', () => {
  it('pins the proposed limits, existing limits and derived mail figures', () => {
    verify(document, facts)
  })

  it('reads every existing limit from sources that agree with each other', () => {
    expect(largestHostCount('round_robin'), 'round robin shares the host ceiling').toBe(facts.hosts)
    for (const [name, value] of [
      ['MAIL_RECIPIENT_MAX_PER_HOUR', facts.recipientHour],
      ['MAIL_RECIPIENT_MAX_PER_DAY', facts.recipientDay],
      ['MAIL_MAX_PER_HOUR', facts.instanceHour],
    ] as const)
      expect(envExample, `${name} in .env.example`).toMatch(new RegExp(`^${name}=${value}$`, 'm'))
    // The worker's own fallbacks apply when a limit is not configured.
    const reason = (
      counts: Partial<Record<'instanceHour' | 'recipientHour' | 'recipientDay', number>>,
    ) =>
      notificationSuppressionReason(
        {},
        { instanceHour: 0, recipientHour: 0, recipientDay: 0, ...counts },
        true,
      )
    expect(reason({ recipientHour: facts.recipientHour - 1 })).toBeUndefined()
    expect(reason({ recipientHour: facts.recipientHour })).toBe('recipient_hourly_limit')
    expect(reason({ recipientDay: facts.recipientDay - 1 })).toBeUndefined()
    expect(reason({ recipientDay: facts.recipientDay })).toBe('recipient_daily_limit')
    expect(reason({ instanceHour: facts.instanceHour - 1 })).toBeUndefined()
    expect(reason({ instanceHour: facts.instanceHour })).toBe('instance_hourly_limit')
    for (const group of ['book', 'slots', 'manage'] as const)
      expect(PUBLIC_RATE_LIMITS[group].windowSeconds, `${group} window`).toBe(60)
  })

  it('reads the mail ledger windows from notificationEmailBudget', () => {
    // Instance hour, recipient hour (the same cutoff), then recipient day; all strict.
    expect(ledger, 'ledger cutoffs applied by the budget').toEqual([
      { op: '>', minutes: 60 },
      { op: '>', minutes: 60 },
      { op: '>', minutes: 24 * 60 },
    ])
    expect(facts.ledgerHourMinutes).toBe(60)
  })

  it.each(proposed)('detects a changed %s in an isolated document copy', (label, value) => {
    const anchor = `| ${label} | ${value} |`
    expect(document.split(anchor), 'exactly one mutation anchor').toHaveLength(2)
    const mutated = document.replace(anchor, `| ${label} | ${value + 1} |`)
    expect(() => verifyProposed(mutated)).toThrow(assertionFailure)
    verifyProposed(document)
  })

  it.each(existing)('detects a changed source value for %s', (label, key) => {
    expect(() => verify(document, { ...facts, [key]: facts[key] + 1 })).toThrow(assertionFailure)
    const anchor = `| ${label} | ${facts[key]} |`
    expect(document.split(anchor), 'exactly one mutation anchor').toHaveLength(2)
    const mutated = document.replace(anchor, `| ${label} | ${facts[key] + 1} |`)
    expect(() => verifyExisting(mutated, facts)).toThrow(assertionFailure)
    verify(document, facts)
  })

  it('detects a longer ledger window, which would let series mail share an hour', () => {
    expect(() => verifyMailProof(document, { ...facts, ledgerHourMinutes: 120 })).toThrow(
      assertionFailure,
    )
    verifyMailProof(document, facts)
  })

  it('derives the hourly series-mail figure from the link-update spacing', () => {
    const spacing = design('Minimum minutes between series link-update mails')
    expect(spacing, 'spacing covers the ledger window').toBeGreaterThanOrEqual(
      facts.ledgerHourMinutes,
    )
    // Half the spacing lets two series mails share a rolling hour; the table would be wrong.
    expect(() => verifyMailProof(document, facts, spacing / 2)).toThrow(assertionFailure)
    verifyMailProof(document, facts)
  })

  it('needs the urgent room check to avoid suppression with two imminent series', () => {
    const cap = design('Series admissions per rolling hour per actor and event')
    expect(simulateHour(facts, cap).suppressed).toBe(false)
    expect(simulateHour(facts, cap, false).suppressed).toBe(true)
  })

  it('detects a changed derived mail figure in an isolated document copy', () => {
    const { perMail } = mailProof(facts)
    const anchor = `| 2 | 3 | ${2 * perMail} | ${3 * perMail} |`
    expect(document.split(anchor), 'exactly one mutation anchor').toHaveLength(2)
    const mutated = document.replace(anchor, `| 2 | 3 | ${2 * perMail} | ${3 * perMail + 1} |`)
    expect(() => verifyMailProof(mutated, facts)).toThrow(assertionFailure)
    verifyMailProof(document, facts)
  })
})
