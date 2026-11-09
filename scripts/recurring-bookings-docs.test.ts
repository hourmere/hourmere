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

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const document = read('../docs/recurring-bookings.md')
const envExample = read('../.env.example')
const notificationsSource = read('../packages/notifications/src/index.ts')
const sitePages = {
  meet: read('../apps/site/src/content/docs/docs/automatic-google-meet.md'),
  zoom: read('../apps/site/src/content/docs/docs/automatic-zoom.md'),
  notifications: read('../apps/site/src/content/docs/docs/notifications.md'),
}

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
  ['Minimum minutes between regular series copies to one recipient', 60],
  ['Maximum link-update copies per series and recipient per rolling day', 3],
] as const

type ProposedLabel = (typeof proposed)[number][0]
const design = (label: ProposedLabel) => proposed.find(([name]) => name === label)?.[1] as number
const SPACING = 'Minimum minutes between regular series copies to one recipient'
const DAILY_UPDATES = 'Maximum link-update copies per series and recipient per rolling day'
const CAP = 'Series admissions per rolling hour per actor and event'

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

/** The conference outbox retry schedule, which the series outbox mirrors, from its source. */
function readOutboxSchedule(source: string) {
  const attempts = /^const CONFERENCE_NOTIFICATION_ATTEMPTS = (\d+)$/m.exec(source)?.[1]
  const delay =
    /^const conferenceRetryDelay = \(attempt: number\) => Math\.min\(([\d_]+) \* 2 \*\* \(attempt - 1\), ([\d_]+)\)$/m.exec(
      source,
    )
  const minutes = (value: string | undefined) => Number(value?.replaceAll('_', '')) / 60_000
  return {
    outboxAttempts: Number(attempts),
    outboxFirstRetryMinutes: minutes(delay?.[1]),
    outboxLongestRetryMinutes: minutes(delay?.[2]),
  }
}

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
    ...readOutboxSchedule(notificationsSource),
    // The instance-wide and per-recipient rolling-hour cutoffs, then the rolling day.
    ledgerHourMinutes: ledger[0]?.minutes ?? Number.NaN,
    ledgerDayMinutes: ledger[2]?.minutes ?? Number.NaN,
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
  ['Conference outbox attempts per notification', 'outboxAttempts'],
  ['Conference outbox first retry delay in minutes', 'outboxFirstRetryMinutes'],
  ['Conference outbox longest retry delay in minutes', 'outboxLongestRetryMinutes'],
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

const flat = (source: string) => source.replace(/\s+/g, ' ')

function expectPhrases(source: string, what: string, phrases: readonly string[]) {
  const prose = flat(source)
  for (const phrase of phrases) expect(prose, what).toContain(phrase)
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

// ---------------------------------------------------------------------------------------
// One model of the series-mail rules for one recipient. Times are minutes. Every attempt of
// a copy is checked against the real ledger semantics: the recipient's delivered `sent_at`
// strictly inside the rolling hour and day, suppressed once the count before it reaches the
// limit. Adapted from the independent review's enumeration and timed scripts.
// ---------------------------------------------------------------------------------------

type Copy = 'confirmation' | 'update' | 'cancellation'

interface Change {
  at: number
  /** A newly failed link: reported to the booker and hosts, never to a guest. */
  failed?: boolean
  /** Only for the replaced rule set: a newly ready link of a member starting within an hour. */
  imminent?: boolean
}

interface SeriesPlan {
  /** The confirmation's first attempt; its other recipients got it then. */
  confirm: number
  /** An older series: this recipient's and everyone's last regular copy, delivered here. */
  delivered?: number
  changes?: readonly Change[]
  /** Whole-series cancellation. */
  cancel?: number
  /** This recipient's SMTP: the next attempt's time when the attempt at `at` is refused. */
  refuse?: (copy: Copy, attempt: number, at: number) => number | undefined
}

interface MailRules {
  /** Spacing from this recipient's own delivered copies, or from the series' other copies. */
  perRecipient: boolean
  /** Each copy is rendered when it is sent, or keeps the content of its first queueing. */
  renderAtSend: boolean
  /** The replaced rule set: immediate updates for imminent members behind a room check. */
  immediate: boolean
}

/** The design: the link-update rule, every copy rendered when it is sent. */
const DESIGN_RULES: MailRules = { perRecipient: true, renderAtSend: true, immediate: false }
/** Rejected: the spacing measured from the series' previous mail as its other recipients got it. */
const SERIES_SPACING: MailRules = { perRecipient: false, renderAtSend: true, immediate: false }
/** The replaced rule set, as the independent review modelled it. */
const REPLACED_RULES: MailRules = { perRecipient: false, renderAtSend: false, immediate: true }

interface ModelLimits {
  hour: number
  day: number
  window: number
  dayWindow: number
  spacing: number
  dailyUpdates: number
  cap: number
  retryDelay: (attempt: number) => number
  attempts: number
}

interface Sent {
  series: number
  copy: Copy
  at: number
  outcome: 'delivered' | 'suppressed' | 'skipped' | 'held' | 'exhausted'
  /** For a delivered confirmation or link update: the changes it newly reported. */
  reports?: number[]
}

function simulate(
  plans: readonly SeriesPlan[],
  rules: MailRules,
  limits: ModelLimits,
  role: 'booker' | 'host' | 'guest' = 'booker',
) {
  const delivered: number[] = []
  const log: Sent[] = []
  const count = (at: number, span: number) => delivered.filter((sent) => sent > at - span).length
  const overBudget = (at: number) =>
    count(at, limits.window) >= limits.hour || count(at, limits.dayWindow) >= limits.day
  const series = plans.map((plan) => {
    if (plan.delivered !== undefined) delivered.push(plan.delivered)
    return {
      plan,
      changes: (plan.changes ?? []).filter((change) => role !== 'guest' || !change.failed),
      confirmation: { next: plan.confirm, attempt: 1, final: plan.delivered !== undefined },
      cancellation: { next: plan.cancel ?? 0, attempt: 1, final: plan.cancel === undefined },
      update: undefined as
        | undefined
        | { next: number; attempt: number; queued: number; immediate: boolean },
      lastRegular: plan.delivered,
      seriesLast: plan.delivered ?? plan.confirm,
      reported: plan.delivered ?? Number.NEGATIVE_INFINITY,
      quietUntil: Number.NEGATIVE_INFINITY,
      updates: [] as number[],
      immediateSent: [] as number[],
      held: new Set<Change>(),
    }
  })
  type State = (typeof series)[number]
  const cancelledBy = (state: State, at: number) =>
    state.plan.cancel !== undefined && state.plan.cancel <= at
  let now = Number.NEGATIVE_INFINITY

  // Gates 1 (ordering), 2 (spacing) and 3 (daily cap) of the link-update rule. The model has
  // whole-series cancellations only, after which a waiting link update is skipped.
  const updateDue = (state: State) => {
    if (!state.confirmation.final) return undefined
    const pending = state.changes.filter(
      (change) => change.at > state.reported && change.at > state.quietUntil,
    )
    if (pending.length === 0) return undefined
    const first = Math.min(...pending.map((change) => change.at))
    const oldest = state.updates.at(-limits.dailyUpdates)
    const dayCap =
      state.updates.length >= limits.dailyUpdates && oldest !== undefined
        ? oldest + limits.dayWindow
        : Number.NEGATIVE_INFINITY
    const anchor = rules.perRecipient ? state.lastRegular : state.seriesLast
    let at = Math.max(first, anchor === undefined ? first : anchor + limits.spacing, dayCap, now)
    let immediate = false
    const soon = pending.filter((change) => change.imminent && !state.held.has(change))
    if (rules.immediate && soon.length > 0) {
      const earliest = Math.max(Math.min(...soon.map((change) => change.at)), now)
      if (earliest < at) {
        at = earliest
        immediate = true
      }
    }
    return cancelledBy(state, at) ? undefined : { at, immediate }
  }

  const attempt = (index: number, copy: Copy, at: number) => {
    const state = series[index] as State
    const record = (outcome: Sent['outcome'], reports?: number[]) => {
      log.push({ series: index, copy, at, outcome, ...(reports && { reports }) })
    }
    // A delivered report covers the changes up to the time its content was rendered.
    const report = (rendered: number) => {
      const reports = state.changes
        .filter((change) => change.at > state.reported && change.at <= rendered)
        .map((change) => change.at)
      state.reported = Math.max(state.reported, rendered)
      return reports
    }
    if (copy === 'cancellation') {
      if (overBudget(at)) {
        state.cancellation.final = true
        return record('suppressed')
      }
      const next = state.plan.refuse?.(copy, state.cancellation.attempt, at)
      if (next !== undefined && state.cancellation.attempt >= limits.attempts) {
        state.cancellation.final = true
        return record('exhausted')
      }
      if (next !== undefined) {
        state.cancellation = { next, attempt: state.cancellation.attempt + 1, final: false }
        return
      }
      delivered.push(at)
      state.cancellation.final = true
      return record('delivered')
    }
    if (copy === 'confirmation') {
      if (cancelledBy(state, at) || overBudget(at)) {
        state.confirmation.final = true
        return record(cancelledBy(state, at) ? 'skipped' : 'suppressed')
      }
      const next = state.plan.refuse?.(copy, state.confirmation.attempt, at)
      if (next !== undefined && state.confirmation.attempt >= limits.attempts) {
        state.confirmation.final = true
        return record('exhausted')
      }
      if (next !== undefined) {
        state.confirmation = { next, attempt: state.confirmation.attempt + 1, final: false }
        return
      }
      delivered.push(at)
      state.confirmation.final = true
      state.lastRegular = at
      return record('delivered', report(rules.renderAtSend ? at : state.plan.confirm))
    }
    const update = state.update
    if (!update) return
    if (cancelledBy(state, at)) {
      state.update = undefined
      return record('skipped')
    }
    if (update.immediate) {
      const room = count(at, limits.window) <= limits.hour - 1 - limits.cap
      const recent = state.immediateSent.some((sent) => sent > at - limits.window)
      if (!room || recent) {
        for (const change of state.changes) if (change.at <= at) state.held.add(change)
        state.update = undefined
        return record('held')
      }
    }
    if (overBudget(at)) {
      state.update = undefined
      state.quietUntil = at
      return record('suppressed')
    }
    const next = state.plan.refuse?.(copy, update.attempt, at)
    if (next !== undefined && update.attempt >= limits.attempts) {
      state.update = undefined
      state.quietUntil = at
      return record('exhausted')
    }
    if (next !== undefined) {
      state.update = { ...update, next, attempt: update.attempt + 1 }
      return
    }
    delivered.push(at)
    state.lastRegular = at
    state.updates.push(at)
    if (update.immediate) state.immediateSent.push(at)
    state.update = undefined
    return record('delivered', report(rules.renderAtSend ? at : update.queued))
  }

  for (let step = 0; step < 10_000; step++) {
    let best: { at: number; rank: number; run: () => void } | undefined
    const consider = (at: number, rank: number, run: () => void) => {
      if (!best || at < best.at || (at === best.at && rank < best.rank)) best = { at, rank, run }
    }
    series.forEach((state, index) => {
      if (!state.confirmation.final)
        consider(state.confirmation.next, index, () =>
          attempt(index, 'confirmation', state.confirmation.next),
        )
      if (!state.cancellation.final)
        consider(state.cancellation.next, 200 + index, () =>
          attempt(index, 'cancellation', state.cancellation.next),
        )
      const update = state.update
      if (update) consider(update.next, 100 + index, () => attempt(index, 'update', update.next))
      else {
        const due = updateDue(state)
        if (due)
          consider(due.at, 100 + index, () => {
            state.update = { next: due.at, attempt: 1, queued: due.at, immediate: due.immediate }
            if (!rules.perRecipient) state.seriesLast = due.at
            attempt(index, 'update', due.at)
          })
      }
    })
    const chosen = best as { at: number; run: () => void } | undefined
    if (!chosen) break
    now = chosen.at
    chosen.run()
  }
  // Rolling-hour counts include an older series' copy from before the enumerated hour.
  const inHour = (times: readonly number[]) =>
    Math.max(
      0,
      ...times.map(
        (at) => times.filter((other) => other > at - limits.window && other <= at).length,
      ),
    )
  const suppressed = log.filter(({ outcome }) => outcome === 'suppressed')
  return {
    log,
    worst: inHour(delivered),
    attempted: inHour([...delivered, ...suppressed.map(({ at }) => at)]),
    suppressed,
  }
}

type Step = 'confirm' | 'retry' | 'change' | 'cancel'

interface Form {
  steps: readonly Step[]
  /** An older series, or one whose confirmation reached this recipient only after SMTP retries. */
  history?: 'older' | 'deferred'
  /** Copies whose first attempt SMTP refuses; the retry happens at the next retry step. */
  refused?: readonly Copy[]
}

/** The five forms of one series in the enumerated hour, described in the mail budget proof. */
const FORMS = {
  confirmed: { steps: ['confirm', 'change', 'change', 'cancel'] },
  confirmedRefused: {
    steps: ['confirm', 'retry', 'change', 'change', 'retry', 'cancel', 'retry'],
    refused: ['confirmation', 'update', 'cancellation'],
  },
  older: { steps: ['change', 'change', 'cancel'], history: 'older' },
  olderRefused: {
    steps: ['change', 'retry', 'change', 'cancel', 'retry'],
    history: 'older',
    refused: ['update', 'cancellation'],
  },
  deferred: {
    steps: ['retry', 'change', 'change', 'cancel'],
    history: 'deferred',
    refused: ['confirmation'],
  },
} as const satisfies Record<string, Form>
type FormName = keyof typeof FORMS
const FORM_NAMES = Object.keys(FORMS) as FormName[]

function* interleavings(lengths: readonly number[]): Generator<number[]> {
  const used = lengths.map(() => 0)
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const order: number[] = []
  function* walk(): Generator<number[]> {
    if (order.length === total) {
      yield [...order]
      return
    }
    for (const [series, length] of lengths.entries()) {
      const taken = used[series] ?? 0
      if (taken >= length) continue
      used[series] = taken + 1
      order.push(series)
      yield* walk()
      order.pop()
      used[series] = taken
    }
  }
  yield* walk()
}

/**
 * The steps of an order are spread evenly over just under one ledger window, so every step
 * shares one rolling hour while a rule that spaces copies by less than the window still lets
 * a second regular copy into it.
 */
function plansFor(forms: readonly Form[], order: readonly number[], limits: ModelLimits) {
  const times = forms.map(() => [] as number[])
  const gap = order.length > 1 ? Math.floor((limits.window - 4) / (order.length - 1)) : 1
  order.forEach((series, index) => {
    times[series]?.push(1 + index * gap)
  })
  return forms.map((form, series): SeriesPlan => {
    const at = (step: Step) =>
      form.steps.flatMap((name, index) => (name === step ? [times[series]?.[index] ?? 0] : []))
    const retries = at('retry')
    const refusedOnce = new Set<Copy>()
    const refuse = (copy: Copy, attempt: number, when: number) => {
      if (!(form.refused as readonly Copy[] | undefined)?.includes(copy)) return undefined
      const retry = retries.find((time) => time > when)
      if (form.history === 'deferred' && copy === 'confirmation') return retry
      if (attempt > 1 || refusedOnce.has(copy)) return undefined
      refusedOnce.add(copy)
      return retry ?? when + limits.retryDelay(1)
    }
    const changes = at('change').map((time) => ({ at: time, imminent: true }))
    const cancel = at('cancel')[0]
    if (form.history === 'older')
      return { confirm: -limits.window, delivered: -limits.window, changes, cancel, refuse }
    if (form.history === 'deferred')
      // Its other recipients got it before the hour; a failure was reported since.
      return {
        confirm: -limits.window - 3,
        changes: [{ at: -45, failed: true }, ...changes],
        cancel,
        refuse,
      }
    return { confirm: at('confirm')[0] ?? 0, changes, cancel, refuse }
  })
}

function enumerate(forms: readonly Form[], rules: MailRules, limits: ModelLimits) {
  let orders = 0
  let suppressing = 0
  let cancellations = 0
  let worst = 0
  let attempted = 0
  for (const order of interleavings(forms.map((form) => form.steps.length))) {
    orders++
    const result = simulate(plansFor(forms, order, limits), rules, limits)
    worst = Math.max(worst, result.worst)
    attempted = Math.max(attempted, result.attempted)
    if (result.suppressed.length > 0) suppressing++
    if (result.suppressed.some((entry) => entry.copy === 'cancellation')) cancellations++
  }
  return { orders, suppressing, cancellations, worst, attempted }
}

function modelLimits(code: CodeFacts, spacing = design(SPACING)): ModelLimits {
  return {
    hour: code.recipientHour,
    day: code.recipientDay,
    window: code.ledgerHourMinutes,
    dayWindow: code.ledgerDayMinutes,
    spacing,
    dailyUpdates: design(DAILY_UPDATES),
    cap: design(CAP),
    attempts: code.outboxAttempts,
    retryDelay: (attempt) =>
      Math.min(code.outboxFirstRetryMinutes * 2 ** (attempt - 1), code.outboxLongestRetryMinutes),
  }
}

const models = new Map<string, ReturnType<typeof buildModel>>()

/** The exhaustive enumeration behind the mail budget proof, cached per set of limits. */
function mailModel(code: CodeFacts, spacing = design(SPACING)) {
  const limits = modelLimits(code, spacing)
  const key = JSON.stringify({ ...limits, delay: limits.retryDelay(1) })
  const cached = models.get(key)
  if (cached) return cached
  const model = buildModel(limits)
  models.set(key, model)
  return model
}

function buildModel(limits: ModelLimits) {
  const single = Object.fromEntries(
    FORM_NAMES.map((name) => [name, enumerate([FORMS[name]], DESIGN_RULES, limits)]),
  ) as Record<FormName, ReturnType<typeof enumerate>>
  const pairs: { forms: [FormName, FormName]; result: ReturnType<typeof enumerate> }[] = []
  for (const [index, first] of FORM_NAMES.entries())
    for (const second of FORM_NAMES.slice(index))
      pairs.push({
        forms: [first, second],
        result: enumerate([FORMS[first], FORMS[second]], DESIGN_RULES, limits),
      })
  const worstOf = (names: readonly FormName[]) =>
    Math.max(...names.map((name) => single[name].worst))
  const worstPairs = (accept: (forms: [FormName, FormName]) => boolean) =>
    Math.max(...pairs.filter(({ forms }) => accept(forms)).map(({ result }) => result.worst))
  const within = (names: readonly FormName[]) => (forms: [FormName, FormName]) =>
    forms.every((name) => names.includes(name))
  const three = enumerate(
    Array.from({ length: 3 }, () => ({ steps: ['confirm', 'change', 'cancel'] as const })),
    DESIGN_RULES,
    limits,
  )
  // The same orders under the replaced rules, with every in-hour change an imminent member's link.
  const groups = [...FORM_NAMES.map((name) => [name]), ...pairs.map(({ forms }) => forms)]
  const replaced = groups.map((names) => ({
    forms: names,
    result: enumerate(
      names.map((name) => FORMS[name]),
      REPLACED_RULES,
      limits,
    ),
  }))
  return {
    orders:
      FORM_NAMES.reduce((sum, name) => sum + single[name].orders, 0) +
      pairs.reduce((sum, { result }) => sum + result.orders, 0),
    suppressing:
      FORM_NAMES.reduce((sum, name) => sum + single[name].suppressing, 0) +
      pairs.reduce((sum, { result }) => sum + result.suppressing, 0),
    one: worstOf(['confirmed', 'older']),
    oneRefused: worstOf(['confirmedRefused', 'olderRefused']),
    two: worstPairs(within(['confirmed', 'older'])),
    twoRefused: worstPairs(within(['confirmedRefused', 'olderRefused'])),
    twoDeferred: worstPairs((forms) => forms.includes('deferred')),
    pairs,
    three,
    seriesSpacing: {
      one: enumerate([FORMS.deferred], SERIES_SPACING, limits),
      two: enumerate([FORMS.deferred, FORMS.deferred], SERIES_SPACING, limits),
    },
    replaced,
  }
}

/** Minutes after the first attempt at which a copy's last attempt is due. */
function lastAttempt(code: CodeFacts) {
  const limits = modelLimits(code)
  let total = 0
  for (let attempt = 1; attempt < code.outboxAttempts; attempt++)
    total += limits.retryDelay(attempt)
  return total
}

const hoursAndMinutes = (minutes: number) =>
  `${Math.floor(minutes / 60)} hours ${minutes % 60} minute${minutes % 60 === 1 ? '' : 's'}`
const clock = (base: number) => (minutes: number) => {
  const total = base + minutes
  const seconds = Math.round((total % 1) * 60)
  const hh = String(Math.floor(total / 60)).padStart(2, '0')
  const mm = String(Math.floor(total % 60)).padStart(2, '0')
  return seconds === 0 ? `${hh}:${mm}` : `${hh}:${mm}:${String(seconds).padStart(2, '0')}`
}

/**
 * The timed case in the mail budget proof (the independent review's counterexample): series X
 * commits at 08:00, the booker's confirmation copy is refused six times, member 1 fails and is
 * repaired, and series Y confirms before both are cancelled.
 */
function timedCase(code: CodeFacts) {
  const limits = modelLimits(code)
  const commit = 0
  const confirm = commit + design('Series confirmation conference wait in minutes')
  const refusals = 6
  const refuse = (copy: Copy, attempt: number, at: number) =>
    copy === 'confirmation' && attempt <= refusals ? at + limits.retryDelay(attempt) : undefined
  const failure = 45
  const repair = 105
  const plans = (refusing: boolean): SeriesPlan[] => [
    {
      confirm,
      changes: [
        { at: failure, failed: true },
        { at: repair, imminent: true },
      ],
      cancel: 120,
      ...(refusing && { refuse }),
    },
    { confirm: 111, cancel: 125 },
  ]
  return {
    at: clock(8 * 60),
    commit,
    confirm,
    refusals,
    failure,
    repair,
    booker: simulate(plans(true), DESIGN_RULES, limits),
    host: simulate(plans(false), DESIGN_RULES, limits, 'host'),
    guest: simulate(plans(false), DESIGN_RULES, limits, 'guest'),
    replaced: simulate(plans(true), REPLACED_RULES, limits),
  }
}

/** The documented third-series case, and the same with admissions counted for 90 minutes. */
function thirdSeries(code: CodeFacts) {
  const limits = modelLimits(code)
  const wait = design('Series confirmation conference wait in minutes')
  const [b, c] = [60.5, 61]
  const rolling = simulate(
    [
      { confirm: wait, cancel: 62 },
      { confirm: b + 0.1, cancel: 63 },
      { confirm: c + 0.1, cancel: 64 },
    ],
    DESIGN_RULES,
    limits,
  )
  const [b90, c90] = [90.5, 91]
  const ninety = simulate(
    [
      { confirm: wait, changes: [{ at: wait + 1 }], cancel: 92 },
      { confirm: b90 + 0.1, cancel: 93 },
      { confirm: c90 + 0.1, cancel: 94 },
    ],
    DESIGN_RULES,
    limits,
  )
  return {
    at: clock(9 * 60),
    admissions: [0, b, c],
    ninetyAdmissions: [0, b90, c90],
    rolling,
    ninety,
  }
}

/** The daily-scope case: one actor books and cancels a pair of series every 65 minutes. */
function dailyScope(code: CodeFacts) {
  const limits = modelLimits(code)
  const period = code.ledgerHourMinutes + 5
  const pairs = Math.floor(code.ledgerDayMinutes / period)
  const plans = Array.from({ length: 2 * pairs }, (_, index) => {
    const start = Math.floor(index / 2) * period + (index % 2) / 2
    return { confirm: start, cancel: start + 1 }
  })
  const result = simulate(plans, DESIGN_RULES, limits)
  const pairOf = (series: number) => Math.floor(series / 2) + 1
  return {
    period,
    plans,
    result,
    pairOf,
    firstSuppressedPair: Math.min(...result.suppressed.map(({ series }) => pairOf(series))),
  }
}

const ORDINALS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh']

/** The mail proof, derived from the code limits, the proposed rules and the model. */
function mailProof(code: CodeFacts, spacing = design(SPACING)) {
  const occurrences = design('Maximum occurrences')
  const cap = design(CAP)
  const updates = design(DAILY_UPDATES)
  const invitees = 1 + code.guests
  const perMail = invitees + code.hosts
  const model = mailModel(code, spacing)
  const { one, oneRefused, two, twoRefused, twoDeferred } = model
  const day = 1 + updates + 1
  const accepted = [
    ['Create', 1, 1, perMail, perMail],
    ['Create, then whole-series cancel in the same hour', 2, 2, 2 * perMail, 2 * perMail],
    [
      `All ${occurrences} automatic conferences fail, the host repairs all, then whole-series cancel`,
      one,
      3,
      one * perMail,
      3 * perMail,
    ],
    [
      `Series-mail maximum for one series in a rolling day: confirmation, ${updates} link updates, whole-series cancel`,
      one,
      day,
      one * perMail,
      day * perMail,
    ],
    [
      'One series at the maximum, every copy refused once by SMTP and retried',
      oneRefused,
      day,
      oneRefused * perMail,
      day * perMail,
    ],
    [
      'Two series at the admission cap, each at the series-mail maximum',
      two,
      cap * day,
      two * perMail,
      cap * day * perMail,
    ],
    [
      'Two series at the cap, every copy refused once by SMTP and retried',
      twoRefused,
      cap * day,
      twoRefused * perMail,
      cap * day * perMail,
    ],
    [
      "Two series at the cap, a recipient's confirmation copies deferred for hours by SMTP",
      twoDeferred,
      cap * day,
      twoDeferred * perMail,
      cap * day * perMail,
    ],
    [
      'Two series at the cap with different invitees',
      one,
      day,
      cap * one * perMail,
      cap * day * perMail,
    ],
    [
      'Two series with different invitees, every copy refused once by SMTP and retried',
      oneRefused,
      day,
      cap * oneRefused * perMail,
      cap * day * perMail,
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
  return { occurrences, cap, updates, invitees, perMail, day, model, accepted, rejected }
}

function verifyMailProof(source: string, code: CodeFacts, spacing?: number) {
  const proof = mailProof(code, spacing)
  const { occurrences, cap, updates, invitees, perMail, day, model } = proof
  expect(model.suppressing, 'no enumerated order of one or two series suppresses mail').toBe(0)
  expect(
    numericRows(section(source, 'Mail budget proof'), 4),
    'mail budget rows match the code limits and the model',
  ).toEqual([...proof.accepted, proof.rejected])
  // A mail is suppressed only once the count before it reaches the limit.
  for (const [label, hour, perDay, instanceHour] of proof.accepted) {
    expect(hour, `${label}: recipient hourly limit`).toBeLessThanOrEqual(code.recipientHour)
    expect(perDay, `${label}: recipient daily limit`).toBeLessThanOrEqual(code.recipientDay)
    expect(instanceHour, `${label}: instance hourly limit`).toBeLessThanOrEqual(code.instanceHour)
  }
  expect(proof.rejected[1], 'the rejected alternative exceeds the limit').toBeGreaterThan(
    code.recipientHour,
  )
  expect(code.recipientHour - model.two, 'two series leave one slot').toBe(1)
  const threeInstance = 3 * 2 * perMail
  expect(threeInstance, 'three series exceed the instance limit').toBeGreaterThan(code.instanceHour)
  const last = lastAttempt(code)
  const lag = last + design(SPACING)
  const timed = timedCase(code)
  const third = thirdSeries(code)
  const daily = dailyScope(code)
  const bookerMails = timed.booker.log.filter((entry) => entry.outcome === 'delivered').length
  const sentAt = (result: ReturnType<typeof simulate>, copy: Copy) =>
    result.log.find((entry) => entry.copy === copy && entry.outcome === 'delivered')?.at
  const bookerConfirmed = sentAt(timed.booker, 'confirmation') ?? Number.NaN
  expectPhrases(source, 'derived mail figures in the prose', [
    `(${invitees} invitee recipients) and ${code.hosts} collective hosts`,
    `One series mail costs 1 per invitee recipient and ${perMail} instance mails`,
    `One series therefore costs at most ${model.one} per invitee recipient in an hour, and two series at most ${model.two}, one below the hourly limit`,
    `a series sends at most ${perMail} regular copies and ${perMail} cancellation copies in an hour, and two series at most ${model.two * perMail} instance mails, whoever their invitees are`,
    `In a rolling day a recipient gets at most 1 + ${updates} + 1 = ${day} mails of one series (gate 3)`,
    `None of the ${model.orders} orders suppresses mail, and the worst hour holds ${model.one} mails for one series and ${model.two} for two`,
    `share the recipient's hour (${model.seriesSpacing.one.worst} mails for one series), and two such series suppress a cancellation in all ${model.seriesSpacing.two.orders} orders`,
    `The model finds a suppressed cancellation in all ${model.three.orders} orders of three series that each confirm, change a link and cancel within one hour`,
    `Three such series also attempt ${threeInstance} instance mails in that hour, over the instance limit, so with different invitees the invitee copies after the ${code.instanceHour}th are suppressed`,
    `of which ${occurrences - code.recipientHour} are suppressed, and attempt ${proof.rejected[3]} instance mails`,
    `${code.outboxAttempts} attempts, the delay starting at ${code.outboxFirstRetryMinutes} minute and doubling to at most ${code.outboxLongestRetryMinutes}, so the last attempt is due ${last} minutes (${hoursAndMinutes(last)}) after the first, later only by the dispatcher's polling and an interrupted attempt's lease`,
    `(gates 1 and 2), about ${lag} minutes (${hoursAndMinutes(lag)}) after that copy's first attempt`,
    `(up to about ${lag} minutes after that copy's first attempt)`,
    `keeps that recipient's next link update waiting until it is exhausted, about ${last} minutes after its first attempt, and one delivered on its last attempt keeps it waiting until about ${lag} minutes after it; no other recipient waits.`,
    `so its confirmation is due at ${timed.at(timed.confirm)} (rule 2) and reaches ${perMail - 1} recipients then`,
    `refuses its copy with 4xx until the ${ORDINALS[timed.refusals + 1]} attempt, at ${timed.at(bookerConfirmed)}`,
    `Member 1 fails at ${timed.at(timed.failure)} and is repaired at ${timed.at(timed.repair)}`,
    `The booker's ${timed.at(bookerConfirmed)} confirmation already shows the failure, its link update cannot be due before ${timed.at(bookerConfirmed + design(SPACING))} and is skipped after the cancellation, and the booker gets ${bookerMails} series mails in that hour, none suppressed`,
    `No other recipient waits for the booker: hosts get the failure in X's link update at ${timed.at(sentAt(timed.host, 'update') ?? Number.NaN)}, and guests the repaired link at ${timed.at(sentAt(timed.guest, 'update') ?? Number.NaN)}`,
    `the booker gets ${bookerMails} series mails in the hour, its link update is not due before ${timed.at(bookerConfirmed + design(SPACING))}, and hosts and guests get theirs at ${timed.at(sentAt(timed.host, 'update') ?? Number.NaN)} and ${timed.at(sentAt(timed.guest, 'update') ?? Number.NaN)}`,
    `the booker's link update waits until that copy is final and the other ${perMail - 1} recipients get theirs`,
    `B and C of the same actor and event commit at ${third.at(third.admissions[1] ?? 0)} and ${third.at(third.admissions[2] ?? 0)}, after A's admission has left the cap window`,
    `B and C commit at ${third.at(third.admissions[1] ?? 0)} and ${third.at(third.admissions[2] ?? 0)}, and all three are cancelled by ${third.at(64)}`,
    `C's cancellation, the ${ORDINALS[third.rolling.attempted]} series mail, is suppressed`,
    `the ${ORDINALS[third.rolling.attempted]} series mail of that hour, C's cancellation, is suppressed`,
    `${occurrences}-occurrence/${code.guests}-guest/${code.hosts}-host`,
    `Keep ${occurrences} occurrences and ${code.guests} guests`,
    `defaults the maximum to ${occurrences}`,
    `adds ${cap} committed new series per rolling hour per actor and event`,
    `at most ${cap} new series per event per hour`,
    `gets ${cap} new series per event per hour`,
    `produces exactly ${perMail} confirmations and then ${perMail} bulk-cancel mails`,
    `all ready gives ${perMail} confirmations with ${occurrences} entries`,
    `gives ${perMail} confirmations that carry that first member's link`,
    `gives exactly ${perMail} link-update mails with ${occurrences} updated entries no earlier than ${design(SPACING)} minutes after the confirmation`,
    `deliver exactly ${perMail} complete mails each`,
    `exactly ${perMail} link-update mails no earlier than ${design(SPACING)} minutes after the confirmation, then ${perMail} cancellation mails; ${3 * perMail} in total and at most ${model.one * perMail} in any rolling hour`,
    `at most ${model.two} per invitee recipient and ${model.two * perMail} instance mails in any rolling hour, zero suppressed, also when every copy is refused once by SMTP and retried`,
    `A ${ORDINALS[updates + 1]} link-update copy to one recipient in a rolling day waits, without using any of its attempts`,
    // The daily scope: the recipient's rolling day.
    `recipient's rolling day takes ${code.recipientDay} invitee mails: ${code.recipientDay / day} series at the series-mail maximum (${day} each), or ${code.recipientDay / 2} that each confirm and cancel`,
    `the ${code.recipientDay + 1}st invitee mail, which can be a cancellation, is suppressed (\`recipient_daily_limit\`)`,
    `an actor that books and cancels a pair of series for the same booker every ${daily.period} minutes stays within the admission cap and never puts more than two series in one rolling hour, yet the ${ORDINALS[daily.firstSuppressedPair]} pair's mail, its cancellations included, is suppressed`,
    `a recipient's rolling day takes ${code.recipientDay} invitee mails, so when one actor books and cancels a pair of series for the same booker every ${daily.period} minutes, within the admission cap, the ${ORDINALS[daily.firstSuppressedPair]} pair's mail, cancellations included, is suppressed`,
  ])
  expect(design('Maximum occurrence-host evaluations'), 'occurrences times hosts').toBe(
    occurrences * code.hosts,
  )
}

function verifyRuleProse(source: string) {
  const wait = design('Series confirmation conference wait in minutes')
  const lead = design('Series confirmation lead before the first start in minutes')
  const imminent = design('Imminent-start confirmation wait in minutes')
  const spacing = design(SPACING)
  const updates = design(DAILY_UPDATES)
  expectPhrases(source, 'rule statements in the prose', [
    `conference wait (${wait} minutes)`,
    `lead (${lead} minutes)`,
    `imminent-start wait (${imminent} minutes)`,
    `from ${lead + imminent} minutes on, the lead point governs unless point 2 comes first`,
    `confirmation due at all-terminal, the ${wait}-minute wait,`,
    // The link-update rule, stated once.
    'Link updates are scheduled per recipient. Each recipient has at most one waiting link-update copy per series, in its own outbox row; later changes join it.',
    'They are checked when it is sent, and again on every retry after an SMTP rollback, inside its send transaction after the existing mail-budget lock that every booking-mail send takes',
    '1. Ordering: every earlier copy of the same series to that recipient (confirmation, link update or cancellation) is final, meaning no further attempt of it will be made: delivered, suppressed, rejected for good by the mail server, skipped, or exhausted after its last attempt.',
    `2. Spacing: at least ${spacing} minutes have passed since that recipient's last delivered confirmation or link-update copy of the series, counted from the delivery time on its receipt.`,
    `3. Daily cap: fewer than ${updates} link-update copies of the series reached that recipient in the last rolling day, counted the same way.`,
    "A copy whose gates are closed waits, and waiting is not an attempt: a closed gate ends the claim without counting against the copy's attempts and moves its due time to when the spacing and the daily cap allow, and the transaction that makes the earlier copy final also makes the waiting copy due.",
    'Only a delivery attempt that SMTP refuses or that is interrupted counts.',
    "Each gate looks only at that recipient's own copies, so a recipient whose mail server defers its copies never holds back anyone else's link updates.",
    'Confirmations and cancellations have no gates and are sent when due.',
    `a recipient's link update becomes due at most ${spacing} minutes after a change, with two exceptions that affect only that recipient: once ${updates} link-update copies reached it in a rolling day, the next waits up to a day (gate 3); and while its own earlier series copies are being retried, its link update waits until the last of them is final, and then ${spacing} more minutes if that was a delivered confirmation or link update (gates 1 and 2)`,
    'Every series copy is rendered when it is sent, again on each retry after an SMTP failure',
    'No change skips that rule: a link that becomes ready shortly before its member starts waits like any other',
    `Gate 2 of the [link-update rule](#link-update-rule): a link-update copy waits this long after that recipient's last delivered confirmation or link-update copy of the series.`,
    'Gate 3 of the [link-update rule](#link-update-rule); later changes wait.',
    `gates 1 and 2 of the [link-update rule](#link-update-rule) space a recipient's regular copies of a series at least ${spacing} minutes apart by their own delivery times. No link update goes before an earlier copy is final, and none within ${spacing} minutes of the last one delivered, so an SMTP refusal or deferral only moves a copy later, and the next one is spaced from when it arrived.`,
    "one row per series, recipient and sequence for a link update, so each recipient's link updates wait and retry on their own",
    "that recipient's link-update counter in the series for a link update",
    'and gate 1 (ordering) of the [link-update rule](#link-update-rule), with the waiting copy made due in the transaction that makes the earlier copy final and closed gates not counted as attempts; content follows in 4b.4b and gates 2 and 3 in 4b.4c.',
    'Mutations that drop gate 1, skip the wake or count a closed gate as an attempt each fail.',
    'the waiting copy becomes due in the transaction that makes the confirmation copy final, with its attempts untouched; a confirmation copy rejected for good or exhausted after 13 attempts also releases it',
    "Gates 2 (spacing) and 3 (daily cap) of the [link-update rule](#link-update-rule), read from each recipient's own receipts and checked when each copy is sent and on every retry",
    "Mutations measuring the spacing from the series' other copies, from a copy's first attempt instead of its delivery time or from link updates only, or removing the daily cap, each fail the counts.",
    'Mutations that render a copy when it is queued instead of when it is sent, report started members or send failure-only updates to guests each fail.',
    'After the confirmation, later readiness changes reach recipients in series mail only through link updates',
    'A per-occurrence reminder stays ready-gated as today, so a reminder of a member that is still due when its link becomes ready carries that link too.',
    'the same with every copy refused once by SMTP and retried at a later step',
    'a further one can be suppressed, and the suppressed mail can then be a whole-series cancellation',
    'and no series mail reports it: the first link update',
    `the first link update cannot be due before ${spacing} minutes after the confirmation, and that member has started by then`,
    // Known limitations for late links and lag.
    `With automatic conferences, a recipient's link update becomes due at most ${spacing} minutes after a change, except after ${updates} link updates to that recipient in a rolling day (up to a day) and while that recipient's own earlier series copy is still retried by SMTP`,
    "When a member's meeting link becomes ready, changes or fails shortly before that member starts, recipients may see it only on the series manage page, host series detail, the host's booking page, a provider calendar copy or a still-due reminder of that member until the next link update.",
    `That update is due no earlier than ${spacing} minutes after the recipient's previous confirmation or link update, so the change can wait up to ${spacing} minutes (longer in the two cases above), and a member that has started by then is never reported in series mail`,
    'three series in one hour also exceed the instance limit',
    // Where a late link is shown: data in 5d, display in 6c and 6d.
    '(step 5d returns it, steps 6c and 6d show it)',
    "the host read and the managed read (booker and guest capabilities) return each confirmed ready member's current join URL, also after that member starts, and none for pending, failed or cancelled members; a member moved separately shows its current successor's link, never a predecessor's",
    "host series detail shows each ready member's current join link, also after that member starts",
    "each ready member's current join link, or its pending or failed marker, per member, including a started member's link, which no series mail reports",
    // The existing per-booking conference pages that step 7 updates.
    '`/docs/automatic-google-meet` (apps/site/src/content/docs/docs/automatic-google-meet.md, “Booking and notifications”)',
    '`/docs/automatic-zoom` (automatic-zoom.md, “Status, notifications and retry”)',
    '`/docs/notifications` (notifications.md, its automatic Google Meet paragraph and “Conference outbox delivery budget”)',
    `(1) the series confirmation is not held until every link is ready, as today's confirmed emails and REQUEST ICS are, but sent by [rules 1–3](#automatic-conferences), at most ${wait} minutes after commit`,
    '(2) a link or failure after that reaches series mail only in link updates under the [link-update rule](#link-update-rule), never after the member starts',
    '(3) a series root gets no “Meeting link needs attention” (`conference_failed`) notice',
    '(4) unchanged per member: reminders stay ready-gated, cancellations are never held',
    'the three conference pages each state exceptions (1)–(4) beside the per-booking promise they change',
    // The personal CSV export is on main.
    '`series_id` and `series_ordinal` are appended after the existing columns of the personal CSV export (`exportBookingsCsv` GET `/bookings/export.csv`, MCP `export_bookings`, CLI `export`).',
    // Replay before the revision check.
    'both series-mode member routes, reschedule and cancel, accept the existing optional `rescheduleRequestId`',
    'In series mode this check runs before the `expectedRevision` check',
    'a mismatch returns 409 `series_changed`, except for the reschedule-request replay described above.',
    'returns the picked booking with `manageToken: null`, not `series_changed`, because the request check runs first',
    'a replay with that id and the now-stale revision returns the cancelled member rather than `series_changed`',
    `${design('Maximum occurrence-host evaluations')} evaluations, at most ${design('Maximum batch database read statements')} reads/${design('Maximum batch fact rows')} rows, abort at ${design('Batch deadline in milliseconds')} ms`,
  ])
  const prose = flat(source)
  for (const removed of [/urgent/i, /room check/i, /held back/i, /PR #238/, /not yet on main/])
    expect(prose, 'no removed rule or stale reference remains').not.toMatch(removed)
}

/** The per-booking promises that step 7 names still read as the design quotes them. */
function verifySitePages(pages: typeof sitePages) {
  expect(pages.meet).toContain('\n## Booking and notifications\n')
  expect(flat(pages.meet)).toContain(
    'Confirmed/rescheduled emails, REQUEST ICS attachments and reminders are held until that revision is ready.',
  )
  expect(pages.meet).toContain('“Meeting link needs attention”')
  expect(pages.zoom).toContain('\n## Status, notifications and retry\n')
  expect(flat(pages.zoom)).toContain(
    'Final meeting invitations and ICS wait for a current ready participant link.',
  )
  expect(pages.notifications).toContain('\n### Conference outbox delivery budget\n')
  expect(flat(pages.notifications)).toContain(
    'For explicitly automatic Google Meet bookings, confirmed/rescheduled invitations and reminders wait for current-revision readiness',
  )
}

/** The final plan: one-day rows, backward dependencies and the admission rollout. */
const PLAN = [
  ['1a', 'Rule expansion', 'None', 'Hard-off'],
  ['1b', 'Batch availability', '1a', 'Hard-off'],
  ['2a.1', 'Series schema', '1a', 'Hard-off'],
  ['2a.2', 'Receipt, notification and admission tables', '2a.1', 'Hard-off'],
  ['2b', 'Atomic creation service', '1b, 2a.2', 'Hard-off'],
  ['3a', 'Capabilities and member integration', '2b', 'Hard-off'],
  ['3b', 'Tail/all cancellation service', '3a', 'Hard-off'],
  ['4a.1', 'Series mail content', '3b', 'Hard-off'],
  ['4a.2', 'Aggregate notification delivery', '4a.1', 'Hard-off'],
  ['4b.1', 'Aggregate calendar attachment', '4a.2', 'Hard-off'],
  ['4b.2', 'Provider calendar jobs', '4b.1', 'Hard-off'],
  ['4b.3', 'Conference-ready series confirmation', '4b.2', 'Hard-off'],
  ['4b.4a', 'Link-update outbox and ordering', '4b.3', 'Hard-off'],
  ['4b.4b', 'Link-update content', '4b.4a', 'Hard-off'],
  ['4b.4c', 'Link-update spacing and daily cap', '4b.4b', 'Hard-off'],
  ['4b.5', 'Calendar client check', '4b.4c', 'Hard-off'],
  ['5a', 'Event configuration interfaces', '2a.1, 4b.5', 'Hard-off'],
  ['5b', 'Preview interfaces', '1b, 5a', 'Hard-off'],
  ['5c', 'Creation interfaces', '2b, 4b.5, 5b', 'Hard-off'],
  ['5d', 'Series read interfaces', '3a, 5c', 'Hard-off'],
  ['5e', 'Series cancellation interfaces', '3b, 5d', 'Hard-off'],
  ['5f.1', 'Series-mode manage reads', '3a, 5e', 'Hard-off'],
  ['5f.2', 'Series-mode reschedule', '5f.1', 'Hard-off'],
  ['5f.3', 'Series-mode single cancel', '5f.2', 'Hard-off'],
  ['5g', 'Series metadata on existing reads, export and webhooks', '3b, 5f.3', 'Hard-off'],
  ['6a', 'Admin configuration UI', '5a', 'Hard-off'],
  ['6b', 'Public booking page', '5b, 5c, 6a', 'Hard-off'],
  ['6c', 'Host series UI', '5d, 5e, 5f.3, 5g', 'Hard-off'],
  ['6d', 'Series manage page', '5d, 5e, 5f.3, 6b, 6c', 'Hard-off'],
  ['7', 'Guides and admission setting', '1a–6d', 'Setting, default false'],
  ['8', 'Final acceptance and default on', '7', 'Default true'],
] as const

function planRows(source: string) {
  return [...source.matchAll(/^\| (\d[\w.]*)\. ([^|]+) \| ([^|]+) \|.*\| ([^|]+) \|$/gm)].map(
    ([, step, title, dependencies, admission]) => [step, title, dependencies, admission],
  )
}

function verifyPlan(source: string) {
  const rows = planRows(source)
  expect(rows, 'the implementation plan rows').toEqual(PLAN)
  const steps = rows.map(([step]) => step)
  rows.forEach(([step, , dependencies], index) => {
    if (dependencies === 'None') return
    for (const dependency of (dependencies ?? '').split(', ')) {
      const [from, to] = dependency.split('–')
      const earlier = steps.slice(0, index)
      expect(earlier, `${step} depends on an earlier row`).toContain(from)
      if (to !== undefined) expect(earlier, `${step} depends on earlier rows`).toContain(to)
    }
  })
}

/** Minutes after commit at which the series confirmation becomes due; see rule 3. */
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
  expectPhrases(source, 'confirmation timing in the prose', [
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
}

function verify(source: string, code: CodeFacts) {
  verifyProposed(source)
  verifyExisting(source, code)
  verifyMailProof(source, code)
  verifyRuleProse(source)
  verifyTiming(source)
  verifyPlan(source)
}

const assertionFailure = expect.objectContaining({ name: 'AssertionError' })

describe('recurring booking design bounds', () => {
  it('pins the proposed limits, existing limits, derived mail figures, rules and plan', () => {
    verify(document, facts)
    verifySitePages(sitePages)
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
    // The outbox schedule is read from its source: 13 attempts, 1 minute doubling to 60.
    expect(Number.isInteger(facts.outboxAttempts), 'outbox attempts read').toBe(true)
    expect(facts.outboxFirstRetryMinutes, 'first outbox delay read').toBeGreaterThan(0)
    expect(lastAttempt(facts), 'last outbox attempt').toBe(423)
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

  it('detects a longer ledger window, which would let regular copies share an hour', () => {
    expect(() => verifyMailProof(document, { ...facts, ledgerHourMinutes: 120 })).toThrow(
      assertionFailure,
    )
    verifyMailProof(document, facts)
  })

  it('derives the hourly series-mail figures from the per-recipient spacing', () => {
    const spacing = design(SPACING)
    expect(spacing, 'spacing covers the ledger window').toBeGreaterThanOrEqual(
      facts.ledgerHourMinutes,
    )
    // Half the spacing lets two regular copies of a series share an hour; the table is wrong.
    expect(mailModel(facts, spacing / 2).two).toBeGreaterThan(mailModel(facts).two)
    expect(() => verifyMailProof(document, facts, spacing / 2)).toThrow(assertionFailure)
    verifyMailProof(document, facts)
  })

  it('enumerates every order of one and two series under the link-update rule', () => {
    const model = mailModel(facts)
    expect(model.orders, 'orders enumerated').toBe(5869)
    expect(model.suppressing, 'orders that suppress mail').toBe(0)
    expect([model.one, model.oneRefused, model.two, model.twoRefused, model.twoDeferred]).toEqual([
      2, 2, 4, 4, 4,
    ])
    for (const { forms, result } of model.pairs)
      expect(result, `${forms.join(' + ')}`).toMatchObject({ suppressing: 0 })
    // Rejected: the spacing measured from the series' other copies lets a deferred
    // confirmation copy and the link update behind it share the recipient's hour.
    expect(model.seriesSpacing.one.worst).toBe(3)
    expect(model.seriesSpacing.two).toMatchObject({ orders: 70, cancellations: 70 })
    // The replaced rules suppress a cancellation only where a confirmation copy was deferred.
    const replacedSuppressing = model.replaced.filter(({ result }) => result.cancellations > 0)
    expect(replacedSuppressing.every(({ forms }) => forms.includes('deferred'))).toBe(true)
    expect(replacedSuppressing.reduce((sum, { result }) => sum + result.cancellations, 0)).toBe(288)
    // Three series in one hour: the sixth mail, always a cancellation, is suppressed.
    expect(model.three).toMatchObject({ orders: 1680, cancellations: 1680, attempted: 6 })
  })

  it('needs each gate of the link-update rule', () => {
    const limits = modelLimits(facts)
    // Without gate 2 a recipient's link update follows its confirmation in the same hour.
    const noSpacing = enumerate([FORMS.confirmed, FORMS.confirmed], DESIGN_RULES, {
      ...limits,
      spacing: 0,
    })
    expect(noSpacing.cancellations).toBeGreaterThan(0)
    // Without gate 3 a recipient gets more than three link updates in a rolling day.
    const changes = Array.from({ length: 30 }, (_, index) => ({ at: 1 + index * 61 }))
    const day = (dailyUpdates: number) =>
      simulate([{ confirm: 0, changes }], DESIGN_RULES, { ...limits, dailyUpdates })
        .log.filter(
          ({ copy, at, outcome }) => copy === 'update' && outcome === 'delivered' && at < 24 * 60,
        )
        .map(({ at }) => at)
    expect(day(design(DAILY_UPDATES))).toEqual([60, 120, 180])
    expect(day(Number.POSITIVE_INFINITY).length).toBeGreaterThan(design(DAILY_UPDATES))
  })

  it('replays the timed case: no suppression under the link-update rule, one under the replaced rules', () => {
    const timed = timedCase(facts)
    const outcomes = (result: ReturnType<typeof simulate>) =>
      result.log.map(
        ({ series, copy, at, outcome }) => `${timed.at(at)} ${'XY'[series]} ${copy} ${outcome}`,
      )
    expect(outcomes(timed.booker)).toEqual([
      '09:33 X confirmation delivered',
      '09:51 Y confirmation delivered',
      '10:00 X cancellation delivered',
      '10:05 Y cancellation delivered',
    ])
    expect(outcomes(timed.host)).toEqual([
      '08:30 X confirmation delivered',
      '09:30 X update delivered',
      '09:51 Y confirmation delivered',
      '10:00 X cancellation delivered',
      '10:05 Y cancellation delivered',
    ])
    expect(outcomes(timed.guest)).toContain('09:45 X update delivered')
    // Each copy is rendered when it is sent: the booker's late confirmation shows the failure.
    const reports = (result: ReturnType<typeof simulate>, copy: Copy) =>
      result.log.find((entry) => entry.copy === copy && entry.series === 0)?.reports
    expect(reports(timed.booker, 'confirmation')).toEqual([timed.failure])
    expect(reports(timed.host, 'update')).toEqual([timed.failure])
    expect(reports(timed.guest, 'update')).toEqual([timed.repair])
    // The replaced rules: spacing from the other copies and an immediate repaired-link update.
    expect(outcomes(timed.replaced)).toEqual([
      '09:33 X confirmation delivered',
      '09:33 X update delivered',
      '09:45 X update delivered',
      '09:51 Y confirmation delivered',
      '10:00 X cancellation delivered',
      '10:05 Y cancellation suppressed',
    ])
  })

  it('applies the strict ledger window and the lifecycle to every attempt', () => {
    const limits = modelLimits(facts)
    const spacing = design(SPACING)
    // Copies exactly 60 minutes apart never share a rolling hour.
    const spaced = simulate([{ confirm: 0, changes: [{ at: 1 }] }], DESIGN_RULES, limits)
    expect(spaced.log.map(({ copy, at }) => [copy, at])).toEqual([
      ['confirmation', 0],
      ['update', spacing],
    ])
    expect(spaced.worst).toBe(1)
    // As many mails as the limit fit in one window; one exactly an hour after the first fits too.
    const full = simulate(
      Array.from({ length: facts.recipientHour + 1 }, (_, index) => ({
        confirm: index < facts.recipientHour ? index : facts.ledgerHourMinutes,
      })),
      DESIGN_RULES,
      limits,
    )
    expect(full.suppressed).toEqual([])
    expect(full.worst).toBe(facts.recipientHour)
    // A link-update copy refused by SMTP is checked again at its retry: cancelled by then, skipped.
    const retried = simulate(
      [
        {
          confirm: 0,
          changes: [{ at: 1 }],
          cancel: spacing + 1,
          refuse: (copy, attempt, at) =>
            copy === 'update' && attempt === 1 ? at + limits.retryDelay(1) + 1 : undefined,
        },
      ],
      DESIGN_RULES,
      limits,
    )
    expect(retried.log.map(({ copy, outcome }) => [copy, outcome])).toEqual([
      ['confirmation', 'delivered'],
      ['cancellation', 'delivered'],
      ['update', 'skipped'],
    ])
  })

  it('bounds the wait behind a copy that SMTP retries for hours', () => {
    const limits = modelLimits(facts)
    const last = lastAttempt(facts)
    const retried = (refusals: number) => (copy: Copy, attempt: number, at: number) =>
      copy === 'confirmation' && attempt <= refusals ? at + limits.retryDelay(attempt) : undefined
    const run = (refusals: number) =>
      simulate(
        [
          {
            confirm: 0,
            changes: [{ at: 10 }, { at: 200 }, { at: 430 }],
            refuse: retried(refusals),
          },
        ],
        DESIGN_RULES,
        limits,
      ).log.filter(({ outcome }) => outcome === 'delivered')
    // Delivered on the last attempt: the link update waits for it and then the spacing.
    expect(run(facts.outboxAttempts - 1).map(({ copy, at }) => [copy, at])).toEqual([
      ['confirmation', last],
      ['update', last + design(SPACING)],
    ])
    // Exhausted after its last attempt: final, so the waiting link update goes at once.
    const exhausted = simulate(
      [{ confirm: 0, changes: [{ at: 10 }, { at: 200 }, { at: 430 }], refuse: retried(99) }],
      DESIGN_RULES,
      limits,
    ).log
    expect(exhausted.map(({ copy, at, outcome }) => [copy, at, outcome])).toEqual([
      ['confirmation', last, 'exhausted'],
      ['update', last, 'delivered'],
      ['update', last + design(SPACING), 'delivered'],
    ])
    // Another recipient of the same series is not held back.
    expect(run(0).map(({ copy, at }) => [copy, at])).toEqual([
      ['confirmation', 0],
      ['update', 60],
      ['update', 200],
      ['update', 430],
    ])
  })

  it('reproduces the documented daily-scope case', () => {
    const daily = dailyScope(facts)
    const cap = design(CAP)
    const window = facts.ledgerHourMinutes
    // Within the admission cap, and no rolling hour holds mail from more than two series.
    const admissions = daily.plans.map(({ confirm }) => confirm)
    for (const at of admissions)
      expect(
        admissions.filter((other) => other > at - window && other <= at).length,
      ).toBeLessThanOrEqual(cap)
    for (const { at } of daily.result.log) {
      const series = new Set(
        daily.result.log
          .filter((other) => other.at > at - window && other.at <= at)
          .map((other) => other.series),
      )
      expect(series.size).toBeLessThanOrEqual(cap)
    }
    // The pair after the recipient's daily limit loses every mail, cancellations included.
    const day = 1 + 1
    const first = facts.recipientDay / (cap * day) + 1
    expect(daily.firstSuppressedPair).toBe(first)
    expect(
      daily.result.suppressed
        .filter(({ series }) => daily.pairOf(series) === first)
        .map(({ copy }) => copy),
    ).toEqual(['confirmation', 'confirmation', 'cancellation', 'cancellation'])
  })

  it('reproduces the documented third-series case with the ledger and cap windows', () => {
    const third = thirdSeries(facts)
    const cap = design(CAP)
    const window = facts.ledgerHourMinutes
    const admitted = (capWindow: number, admissions: number[]) =>
      admissions.every(
        (at, index) =>
          admissions.slice(0, index).filter((other) => other > at - capWindow).length < cap,
      )
    expect(admitted(window, third.admissions)).toBe(true)
    expect(third.rolling.suppressed.map(({ series, copy }) => [series, copy])).toEqual([
      [2, 'cancellation'],
    ])
    // Counting admissions for 90 minutes: A's link update takes its confirmation's place.
    const wait = design('Series confirmation conference wait in minutes')
    expect(admitted(window + wait, third.ninetyAdmissions)).toBe(true)
    expect(third.ninety.suppressed.map(({ series, copy }) => [series, copy])).toEqual([
      [2, 'cancellation'],
    ])
    expectPhrases(document, 'third-series case in the prose', [
      'Counting each admission for 90 minutes would not close this',
      "No admission window closes it, because a deferred copy or an older series' link update can land in any hour",
    ])
  })

  it('pins confirmation times to rule 3 and rejects its earlier reading', () => {
    verifyTiming(document)
    expect(() => verifyTiming(document, (start) => confirmationDue(start, false))).toThrow(
      assertionFailure,
    )
  })

  it('detects a changed derived mail figure in an isolated document copy', () => {
    const { perMail } = mailProof(facts)
    const anchor = `| 2 | 3 | ${2 * perMail} | ${3 * perMail} |`
    expect(document.split(anchor), 'exactly one mutation anchor').toHaveLength(2)
    const mutated = document.replace(anchor, `| 2 | 3 | ${2 * perMail} | ${3 * perMail + 1} |`)
    expect(() => verifyMailProof(mutated, facts)).toThrow(assertionFailure)
    verifyMailProof(document, facts)
  })

  it('detects a plan row whose dependency points forward', () => {
    const anchor = '| 4b.4a. Link-update outbox and ordering | 4b.3 |'
    expect(document.split(anchor), 'exactly one mutation anchor').toHaveLength(2)
    expect(() =>
      verifyPlan(document.replace(anchor, '| 4b.4a. Link-update outbox and ordering | 4b.5 |')),
    ).toThrow(assertionFailure)
  })
})
