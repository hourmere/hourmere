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

interface UrgentRules {
  /** An invitee copy of an urgent update needs room for one cancellation per series the cap allows. */
  roomCheck: boolean
  /** A series sends at most one urgent update per rolling hour. */
  onePerSeries: boolean
  /** Failure reports skip the spacing too (the rejected rule). */
  failureUrgent: boolean
  /** Each series' first urgent copy is rolled back by a transient SMTP failure and retried later. */
  smtpRetry: boolean
  /** The rejected retry rule: the retry keeps the first attempt's room decision unchecked. */
  keepDecision: boolean
  /** A link-update copy waits until the recipient's copy of the series' previous mail is final. */
  ordered: boolean
}

const RULES: UrgentRules = {
  roomCheck: true,
  onePerSeries: true,
  failureUrgent: false,
  smtpRetry: false,
  keepDecision: false,
  ordered: true,
}

type Step = 'regular' | 'failure' | 'attempt' | 'retry' | 'repaired' | 'cancel'

/**
 * One invitee recipient's view of one series: its regular mail (the confirmation), the
 * imminent member's failure report, two repaired-link urgent attempts and the whole-series
 * cancel. With `smtpRetry` the first attempt is rolled back and retried later. Without the
 * ordering rule, a confirmation copy waiting for its SMTP retry can arrive after the first
 * urgent copy.
 */
function seriesSteps(rules: UrgentRules): readonly Step[] {
  const urgent: Step[] = rules.smtpRetry
    ? ['attempt', 'retry', 'repaired']
    : ['repaired', 'repaired']
  const [first, ...rest] = urgent
  return rules.ordered
    ? ['regular', 'failure', ...urgent, 'cancel']
    : ['failure', first as Step, 'regular', ...rest, 'cancel']
}

/**
 * Worst rolling hour for one invitee recipient when `seriesCount` series (at most the
 * admission cap) each send the steps above, over every interleaving. Within one hour a
 * failure report is sent only if failures are urgent; a repaired link goes out only under
 * the urgent rules, checked when its copy is sent, otherwise it waits and is later skipped by
 * the cancellation.
 */
function simulateHour(code: CodeFacts, seriesCount: number, rules: UrgentRules = RULES) {
  const cap = design('Series admissions per rolling hour per actor and event')
  const threshold = rules.roomCheck ? code.recipientHour - 1 - cap : Number.POSITIVE_INFINITY
  const steps = seriesSteps(rules)
  let worst = 0
  let interleavings = 0
  let suppressing = 0
  const walk = (
    positions: readonly number[],
    // The recipient got this series' urgent copy (or, keeping decisions, was promised it).
    urgent: readonly boolean[],
    // A copy rolled back by SMTP and waiting for its retry.
    pending: readonly boolean[],
    count: number,
    suppressed: boolean,
  ): void => {
    const advance = (index: number, step: Step) => {
      const next = positions.map((value, other) => (other === index ? value + 1 : value))
      const mark = (flags: readonly boolean[], value: boolean) =>
        flags.map((flag, other) => (other === index ? value : flag))
      const room = count <= threshold && !(rules.onePerSeries && urgent[index] === true)
      const skip = () => walk(next, urgent, pending, count, suppressed)
      const deliver = (sentUrgent: readonly boolean[], stillPending: readonly boolean[]) =>
        walk(next, sentUrgent, stillPending, count + 1, suppressed || count >= code.recipientHour)
      if (step === 'regular' || step === 'cancel') return deliver(urgent, pending)
      if (step === 'failure' && !rules.failureUrgent) return skip()
      if (step === 'attempt') {
        if (!room) return skip()
        // The check passed, then SMTP rolled the copy back. The rejected rule keeps that decision.
        return walk(
          next,
          rules.keepDecision ? mark(urgent, true) : urgent,
          mark(pending, true),
          count,
          suppressed,
        )
      }
      if (step === 'retry') {
        if (pending[index] !== true) return skip()
        if (rules.keepDecision) return deliver(urgent, mark(pending, false))
        return room ? deliver(mark(urgent, true), mark(pending, false)) : skip()
      }
      return room ? deliver(mark(urgent, true), pending) : skip()
    }
    let finished = true
    for (const [index, position] of positions.entries()) {
      const step = steps[position]
      if (step === undefined) continue
      finished = false
      advance(index, step)
    }
    if (finished) {
      interleavings++
      worst = Math.max(worst, count)
      if (suppressed) suppressing++
    }
  }
  walk(
    Array.from({ length: seriesCount }, () => 0),
    Array.from({ length: seriesCount }, () => false),
    Array.from({ length: seriesCount }, () => false),
    0,
    false,
  )
  return { worst, suppressed: suppressing > 0, interleavings, suppressing }
}

/**
 * Minutes after commit at which the series confirmation becomes due while the first
 * member's conference is still pending: the first of the 30-minute wait and rule 3. With
 * `later` false, rule 3 takes the earlier of its two points instead (the rejected reading).
 */
function confirmationDue(firstStart: number, later = true) {
  const wait = design('Series confirmation conference wait in minutes')
  const lead = design('Series confirmation lead before the first start in minutes')
  const imminent = design('Imminent-start confirmation wait in minutes')
  const second = Math.min(firstStart, imminent)
  const rule3 = later ? Math.max(firstStart - lead, second) : Math.min(firstStart - lead, second)
  return Math.max(0, Math.min(wait, rule3))
}

/** Every stated confirmation time follows rule 3, which never confirms a later start earlier. */
function verifyTiming(source: string, due: (firstStart: number) => number = confirmationDue) {
  const lead = design('Series confirmation lead before the first start in minutes')
  const imminent = design('Imminent-start confirmation wait in minutes')
  for (let start = 0; start < 120; start++) {
    expect(due(start + 1), `first start ${start + 1}: never earlier`).toBeGreaterThanOrEqual(
      due(start),
    )
    expect(due(start), `first start ${start}: never past it`).toBeLessThanOrEqual(start)
  }
  // Below lead + imminent minutes a pending first link makes the imminent-start wait govern.
  expect(due(lead - 1), 'start inside the lead').toBe(imminent)
  expect(due(lead + imminent - 1), 'start just inside lead + imminent').toBe(imminent)
  expect(due(lead + imminent + 1), 'the lead point governs from there').toBe(imminent + 1)
  const starts = [10, 14, 16, 25, 60]
  const times = starts.map((start) => due(start))
  expect(new Set(times.slice(0, 3)).size, 'first starts 10, 14 and 16 share one time').toBe(1)
  const prose = source.replace(/\s+/g, ' ')
  for (const phrase of [
    '3. the later of two points',
    "the first of that member's terminal conference state, its start, or the imminent-start wait",
    `less than ${lead} minutes away`,
    `less than ${lead + imminent} minutes away`,
    'Rule 3 sends the confirmation by this point before the first not-started occurrence, or by the imminent-start point when that is later.',
    `or the later of ${lead} minutes before the first not-started start and the first of that member's terminal state, its start or the ${imminent}-minute imminent-start wait`,
    `confirmation goes out ${times[0]} minutes after commit for first starts 10, 14 and 16 minutes after commit (rule 3, the imminent-start wait)`,
    `${times[3]} minutes after commit for a first start 25 minutes after commit (rule 3, ${lead} minutes before it)`,
    `${times[4]} minutes after commit for a first start 60 minutes after commit (rule 2, the conference wait)`,
    `first starts ${starts.slice(0, -1).join(', ')} and ${starts.at(-1)} minutes after commit confirmed ${times.slice(0, -1).join(', ')} and ${times.at(-1)} minutes after commit`,
  ])
    expect(prose, 'confirmation timing in the prose').toContain(phrase)
}

/** The mail proof, derived from the code limits and the proposed series rules. */
function mailProof(
  code: CodeFacts,
  spacing = design('Minimum minutes between series link-update mails'),
) {
  const occurrences = design('Maximum occurrences')
  const cap = design('Series admissions per rolling hour per actor and event')
  const digests = design('Maximum series link-update mails per rolling day')
  const invitees = 1 + code.guests
  const perMail = invitees + code.hosts
  // An urgent link update goes to the invitee recipients only.
  const urgentMail = invitees
  const window = code.ledgerHourMinutes
  // Regular series mail (confirmation and regular link updates) shares one slot per rolling
  // hour only when spaced by at least the ledger window.
  const regularPerHour = Math.ceil(window / Math.min(spacing, window))
  // The rules allow at most one urgent update per series in any rolling hour.
  const urgentPerHour = 1
  const oneSeries = regularPerHour + urgentPerHour + 1
  // The simulation models one regular mail per series and hour, so it holds for that case.
  const simulated = simulateHour(code, cap)
  const single = simulateHour(code, 1)
  const retried = simulateHour(code, cap, { ...RULES, smtpRetry: true })
  const capHour = regularPerHour === 1 ? simulated.worst : Number.NaN
  const singleHour = regularPerHour === 1 ? single.worst : Number.NaN
  // A series' regular mail and cancellation reach every recipient; its urgent update only invitees.
  const fullMails = regularPerHour + 1
  const instanceFor = (mails: number, urgent: number) => mails * perMail + urgent * urgentMail
  const oneSeriesInstance = instanceFor(fullMails, urgentPerHour)
  // Two series sharing their invitees: urgent copies are the worst hour's mails beyond those.
  const sharedInstance = instanceFor(cap * fullMails, capHour - cap * fullMails)
  // Two series with different invitees: each invitee recipient sees one series.
  const separateInstance = cap * instanceFor(fullMails, singleHour - fullMails)
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
      oneSeriesInstance,
      oneSeriesInstance,
    ],
    [
      'First start inside the lead, its link failing and then repaired before the start, then whole-series cancel',
      singleHour,
      3,
      instanceFor(fullMails, singleHour - fullMails),
      instanceFor(fullMails, singleHour - fullMails),
    ],
    [
      'Two such imminent series in one hour (the admission cap)',
      capHour,
      capHour,
      sharedInstance,
      sharedInstance,
    ],
    [
      'Two such imminent series with different invitees in one hour (the admission cap)',
      singleHour,
      singleHour,
      separateInstance,
      separateInstance,
    ],
    [
      `Series-mail maximum for one series in a day: confirmation, ${digests} link updates, whole-series cancel`,
      oneSeries,
      ruleMaxDay,
      oneSeriesInstance,
      ruleMaxDay * perMail,
    ],
    [
      'Two series at the series-mail maximum',
      capHour,
      cap * ruleMaxDay,
      sharedInstance,
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
    invitees,
    perMail,
    urgentMail,
    regularPerHour,
    capHour,
    sharedInstance,
    separateInstance,
    simulated,
    single,
    retried,
    accepted,
    rejected,
    suppressed: occurrences - code.recipientHour,
  }
}

function verifyMailProof(source: string, code: CodeFacts, spacing?: number) {
  const proof = mailProof(code, spacing)
  expect(proof.simulated.suppressed, 'the urgent rules prevent suppression').toBe(false)
  expect(proof.single.suppressed, 'one series is never suppressed').toBe(false)
  expect(proof.retried.suppressed, 'a retried urgent copy is checked again').toBe(false)
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
  const { invitees, perMail, urgentMail, occurrences, sharedInstance, separateInstance } = proof
  const cap = design('Series admissions per rolling hour per actor and event')
  const prose = source.replace(/\s+/g, ' ')
  for (const phrase of [
    `(${1 + code.guests} invitee recipients) and ${code.hosts} collective hosts`,
    `the confirmation and regular link updates) costs at most ${proof.regularPerHour} per recipient in any rolling hour`,
    `two series at the admission cap at most ${proof.capHour}, the hourly limit itself`,
    `One series therefore costs at most ${proof.single.worst} per invitee recipient in an hour`,
    'two repaired-link attempts and a cancellation, and finds none that suppresses mail',
    "one transient SMTP failure of each series' first urgent copy: checking the retry again finds none, while keeping the first attempt's decision suppresses a cancellation",
    `except an urgent link update, which goes to the ${invitees} invitee recipients only`,
    `An urgent update has only invitee copies (${urgentMail} instance mails here), so two series at the cap send at most ${separateInstance} instance mails in any hour, whoever their invitees are`,
    `${perMail} + ${urgentMail} + ${perMail}`,
    `brings its link to the ${invitees} invitee recipients before it starts`,
    `with different invitees, at most ${separateInstance} instance mails in the hour`,
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
    `at most ${proof.capHour} per invitee recipient and ${sharedInstance} instance mails in the hour`,
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
    `newly ready link for a member starting within the next ${design('Urgent link-update window before a start in minutes')} minutes`,
    `no earlier than ${design('Minimum minutes between series link-update mails')} minutes after the series' previous confirmation or link-update mail`,
    'A series sends at most one urgent update in any rolling hour',
    'Failure reports are never urgent for any recipient',
    'a failure of a member starting before that time is never mailed',
    'may skip the spacing below, once per series per hour and within the daily cap. It goes to invitee recipients only, and each copy needs room when it is sent.',
    'It goes to invitee recipients only: hosts see every member',
    'including a retry after an SMTP rollback, is checked when it is sent',
    "No attempt's decision carries over to a retry",
    "goes out only once that recipient's copy of the series' previous mail has a final outcome",
    'and only to invitee recipients, at most one urgent update per series per rolling hour, each invitee copy (a retry included) sent only when that recipient has room at its send time, failure reports never urgent',
    "a link-update copy only after that recipient's previous series mail is final",
    'both series-mode member routes, reschedule and cancel, accept the existing optional `rescheduleRequestId`',
    'In series mode this check runs before the `expectedRevision` check',
    'because the request check runs first',
    'a replay with that id and the now-stale revision returns the cancelled member rather than `series_changed`',
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
  verifyTiming(source)
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

  it('needs each urgent rule to avoid suppression with two imminent series', () => {
    const cap = design('Series admissions per rolling hour per actor and event')
    expect(simulateHour(facts, cap)).toEqual({
      worst: facts.recipientHour,
      suppressed: false,
      interleavings: 252,
      suppressing: 0,
    })
    expect(simulateHour(facts, 1)).toMatchObject({ worst: 3, suppressed: false })
    expect(simulateHour(facts, cap, { ...RULES, roomCheck: false }).suppressed).toBe(true)
    expect(simulateHour(facts, cap, { ...RULES, onePerSeries: false }).suppressed).toBe(true)
    // The rejected rule's counterexample: a failure report and a repaired link both sent at once.
    expect(
      simulateHour(facts, cap, { ...RULES, onePerSeries: false, failureUrgent: true }).suppressed,
    ).toBe(true)
    // One series alone would reach 4 in an hour without the per-series limit.
    expect(
      simulateHour(facts, 1, { ...RULES, onePerSeries: false, failureUrgent: true }).worst,
    ).toBe(4)
    // A confirmation copy that waits for its SMTP retry must not arrive after a link update.
    expect(simulateHour(facts, cap, { ...RULES, ordered: false }).suppressed).toBe(true)
  })

  it('checks a retried urgent copy again when it is sent', () => {
    const cap = design('Series admissions per rolling hour per actor and event')
    // One transient SMTP failure and retry of each series' first urgent copy.
    expect(simulateHour(facts, cap, { ...RULES, smtpRetry: true })).toEqual({
      worst: facts.recipientHour,
      suppressed: false,
      interleavings: 924,
      suppressing: 0,
    })
    // The rejected rule: the retry keeps the first attempt's room decision.
    const kept = simulateHour(facts, cap, { ...RULES, smtpRetry: true, keepDecision: true })
    expect(kept).toMatchObject({ interleavings: 924, suppressed: true })
    expect(kept.worst).toBeGreaterThan(facts.recipientHour)
    // The prose states the send-time check; restoring the kept decision fails the pins.
    const flat = document.replace(/\s+/g, ' ')
    const anchor = 'including a retry after an SMTP rollback, is checked when it is sent'
    expect(flat.split(anchor), 'exactly one mutation anchor').toHaveLength(2)
    expect(() =>
      verifyRuleProse(flat.replace(anchor, 'keeps the decision of its first attempt')),
    ).toThrow(assertionFailure)
  })

  it('pins confirmation times to rule 3 and rejects its earlier reading', () => {
    verifyTiming(document)
    expect(() => verifyTiming(document, (start) => confirmationDue(start, false))).toThrow(
      assertionFailure,
    )
  })

  it('reproduces the documented third-series case with the ledger and cap windows', () => {
    const hour = facts.ledgerHourMinutes
    const cap = design('Series admissions per rolling hour per actor and event')
    const wait = design('Series confirmation conference wait in minutes')
    const spacing = design('Minimum minutes between series link-update mails')
    // Admissions and sends in minutes after 09:00; both windows are strict, as in the ledger.
    const run = (capWindow: number, admissions: number[], sends: number[]) => {
      admissions.forEach((at, index) => {
        const inWindow = admissions.slice(0, index).filter((other) => other > at - capWindow)
        expect(inWindow.length, `admission at ${at}`).toBeLessThan(cap)
      })
      const sent: number[] = []
      return [...sends]
        .sort((a, b) => a - b)
        .map((at) => {
          const before = sent.filter((other) => other > at - hour).length
          if (before < facts.recipientHour) sent.push(at)
          return before >= facts.recipientHour
        })
    }
    // A waits for its conferences; B and C confirm at once; all three cancelled by 10:04.
    const a = 0
    const [b, c] = [60.5, 61]
    expect(run(hour, [a, b, c], [a + wait, b + 0.1, c + 0.1, 62, 63, 64])).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ])
    // Counting admissions for 90 minutes: A's regular link update takes its confirmation's place.
    const [b90, c90] = [90.5, 91]
    expect(
      run(hour + wait, [a, b90, c90], [a + wait + spacing + 0.2, b90 + 0.1, c90 + 0.1, 92, 93, 94]),
    ).toEqual([false, false, false, false, false, true])
    const prose = document.replace(/\s+/g, ' ')
    for (const phrase of [
      "commit at 10:00:30 and 10:01, after A's admission has left the cap window",
      "C's cancellation, the sixth series mail, is suppressed",
      'Counting each admission for 90 minutes would not close this',
      "the sixth series mail of that hour, C's cancellation, is suppressed",
    ])
      expect(prose, 'third-series case in the prose').toContain(phrase)
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
