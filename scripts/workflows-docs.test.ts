import { readdirSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../apps/server/src/config.ts'
import {
  bookingNotificationJob,
  type NotificationDeps,
} from '../packages/notifications/src/index.ts'
import {
  notificationEmailBudget,
  notificationSuppressionReason,
  signInEmailBudget,
} from '../packages/notifications/src/mail-limits.ts'
import { REMINDER_MIN_GAP } from '../packages/notifications/src/scheduled.ts'
import { MAX_GUESTS } from '../packages/scheduling/src/bookings.ts'
import { hasValidHostShape } from '../packages/scheduling/src/hosts.ts'
import {
  DEFAULT_NOTIFICATIONS,
  validateNotifications,
} from '../packages/scheduling/src/notification-settings.ts'
import { type WebhookDeps, webhookDeliveryJob } from '../packages/webhooks/src/delivery.ts'
import { WEBHOOK_EVENTS } from '../packages/webhooks/src/service.ts'
import { WORKFLOW_AUDIT_EVENTS } from '../packages/workflows/src/audit.ts'
import {
  PERSONAL_ONLY_CONDITION_FIELDS,
  WorkflowConditionSchema,
} from '../packages/workflows/src/conditions.ts'
import {
  WORKFLOW_ANSWER_CONDITION_QUESTION_TYPES,
  WorkflowTriggerSchema,
} from '../packages/workflows/src/definition.ts'
import { WORKFLOWS_IMPLEMENTED } from '../packages/workflows/src/hard-off.ts'
import { WORKFLOW_LIMITS } from '../packages/workflows/src/limits.ts'
import { WORKFLOW_BOOKING_SOURCES } from '../packages/workflows/src/ownership.ts'
import {
  templateVariableProblem,
  WORKFLOW_ANSWER_VARIABLE_PREFIX,
  WORKFLOW_RECIPIENT_CLASSES,
  WORKFLOW_TEMPLATE_VARIABLES,
} from '../packages/workflows/src/variables.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const document = read('docs/workflows.md')
/** The document with line wrapping removed, for checks on sentences that span lines. */
const text = document.replace(/\s+/g, ' ')
const code = (values: readonly string[]) => values.map((value) => `\`${value}\``)
const prose = (values: readonly string[]) =>
  values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`
const numberWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/** Every migration in order, so the last match of a constraint is the one main installs. */
const migrations = readdirSync(new URL('../packages/db/migrations/', import.meta.url))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({
    number: name.slice(0, 4),
    sql: read(`packages/db/migrations/${name}`),
  }))
function latest(pattern: RegExp) {
  const found = migrations.flatMap(({ number, sql }) =>
    [...sql.matchAll(pattern)].map((match) => ({ number, match })),
  )
  expect(found.length, `a migration matches ${pattern}`).toBeGreaterThan(0)
  return found.at(-1) as { number: string; match: RegExpMatchArray }
}
const quoted = (list: string | undefined) =>
  [...(list ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1])
/** Repository files under a directory whose names match, skipping installed and built output. */
function files(directory: string, name: RegExp): string[] {
  return readdirSync(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true }).flatMap(
    (entry) =>
      entry.isDirectory()
        ? ['node_modules', 'dist', 'build'].includes(entry.name)
          ? []
          : files(`${directory}/${entry.name}`, name)
        : name.test(entry.name)
          ? [`${directory}/${entry.name}`]
          : [],
  )
}
const testFile = /\.test\.[cm]?[jt]sx?$/
const planRows = () => [
  ...document.matchAll(/^\| (\d+[a-z]?)\. ([^|]+)\| ([^|]+)\| ([^|]+)\| ([^|]+)\| ([^|]+)\|$/gm),
]
const dependencies = (row: RegExpMatchArray | undefined) =>
  (row?.[3] ?? '')
    .trim()
    .split(',')
    .map((value) => value.trim())
function number(name: string): number {
  const rows = [...document.matchAll(new RegExp(`^\\| \\x60${name}\\x60 \\| (\\d+) \\|`, 'gm'))]
  expect(rows, `one numeric contract row for ${name}`).toHaveLength(1)
  return Number(rows[0]?.[1])
}

const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/workflows_docs_unused',
  BETTER_AUTH_SECRET: 'workflows-docs-synthetic-secret-32-characters',
})
const env = parseEnv(read('.env.example'))
const mailKeys = [
  'MAIL_RECIPIENT_MAX_PER_HOUR',
  'MAIL_RECIPIENT_MAX_PER_DAY',
  'SIGN_IN_MAIL_MAX_PER_HOUR',
  'SIGN_IN_MAIL_MAX_PER_DAY',
  'MAIL_MAX_PER_HOUR',
] as const

type Suppress = typeof notificationSuppressionReason
function verifyMailDefaults(suppress: Suppress) {
  const cap = number('MAIL_MAX_PER_HOUR')
  const hostCap = Math.floor((cap * number('MAIL_HOST_RESERVE_PERCENT')) / 100)
  for (const [invitee, ceiling] of [
    [true, cap],
    [false, hostCap],
  ] as const) {
    expect(
      suppress({}, { instanceHour: ceiling - 1, recipientHour: 0, recipientDay: 0 }, invitee),
    ).toBeUndefined()
    expect(
      suppress({}, { instanceHour: ceiling, recipientHour: 0, recipientDay: 0 }, invitee),
    ).toBe('instance_hourly_limit')
  }
  const hourly = number('MAIL_RECIPIENT_MAX_PER_HOUR')
  const daily = number('MAIL_RECIPIENT_MAX_PER_DAY')
  expect(
    suppress({}, { instanceHour: 0, recipientHour: hourly - 1, recipientDay: daily - 1 }, true),
  ).toBeUndefined()
  expect(suppress({}, { instanceHour: 0, recipientHour: hourly, recipientDay: 0 }, true)).toBe(
    'recipient_hourly_limit',
  )
  expect(suppress({}, { instanceHour: 0, recipientHour: 0, recipientDay: daily }, true)).toBe(
    'recipient_daily_limit',
  )
  expect(
    suppress(
      { mailMaxPerHour: 0 },
      { instanceHour: cap * 10, recipientHour: 0, recipientDay: 0 },
      true,
    ),
  ).toBeUndefined()
}

const designLimits = {
  WORKFLOW_MAX_ENABLED_PER_EVENT: 5,
  WORKFLOW_MAX_DEFINITIONS_PER_OWNER: 100,
  WORKFLOW_NAME_MAX_BYTES: 200,
  WORKFLOW_SUBJECT_MAX_BYTES: 200,
  WORKFLOW_BODY_MAX_BYTES: 8000,
  WORKFLOW_RENDERED_MAX_BYTES: 16000,
  WORKFLOW_MAX_ACTIONS: 1,
  WORKFLOW_MAX_CONDITIONS: 5,
  WORKFLOW_MIN_TIMER_OFFSET_MINUTES: 5,
  WORKFLOW_MAX_OFFSET_MINUTES: 43200,
  WORKFLOW_MAX_LATE_MINUTES: 60,
  WORKFLOW_MAIL_MAX_PER_HOUR: 20,
  WORKFLOW_INSTANCE_MAIL_CAP_DIVISOR: 5,
  WORKFLOW_OWNER_MAIL_MAX_PER_HOUR: 5,
  WORKFLOW_RECIPIENT_EMAILS_PER_HOUR: 1,
  WORKFLOW_RECIPIENT_EMAILS_PER_DAY: 3,
  WORKFLOW_HISTORY_DAYS: 30,
} as const

function rules(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `rule-${index}`,
    offsetMinutes: 5 + index,
    recipients: { invitee: true, guests: true, host: true },
  }))
}

describe('workflow design numeric contracts', () => {
  it('binds documented mail defaults to server parsing and the example environment', () => {
    for (const key of mailKeys) {
      expect(number(key), key).toBe(config[key])
      expect(number(key), key).toBe(Number(env[key]))
    }
    verifyMailDefaults(notificationSuppressionReason)
  })

  it('binds the separate sign-in defaults and reserve to the real budget function without a database', async () => {
    const counts = { count: '0', day: '0', hour: '0' }
    const query = {
      select: () => query,
      where: () => query,
      executeTakeFirstOrThrow: async () => counts,
    }
    const db = { selectFrom: () => query } as unknown as Db
    const reason = () =>
      signInEmailBudget(db, {}, Buffer.alloc(32), new Date('2026-01-01T00:00:00Z'))
    counts.hour = String(number('SIGN_IN_MAIL_MAX_PER_HOUR') - 1)
    counts.day = String(number('SIGN_IN_MAIL_MAX_PER_DAY') - 1)
    expect(await reason()).toBeUndefined()
    counts.hour = String(number('SIGN_IN_MAIL_MAX_PER_HOUR'))
    expect(await reason()).toBe('recipient_hourly_limit')
    counts.hour = '0'
    counts.day = String(number('SIGN_IN_MAIL_MAX_PER_DAY'))
    expect(await reason()).toBe('recipient_daily_limit')
    counts.day = '0'
    counts.count = String(
      Math.floor((number('MAIL_MAX_PER_HOUR') * number('MAIL_HOST_RESERVE_PERCENT')) / 100) - 1,
    )
    expect(await reason()).toBeUndefined()
    counts.count = String(Number(counts.count) + 1)
    expect(await reason()).toBe('instance_hourly_limit')
  })

  it('binds guest, host and reminder constraints to existing runtime policy', () => {
    expect(number('MAX_GUESTS')).toBe(MAX_GUESTS)
    const hosts = Array.from({ length: number('MAX_HOSTS') }, (_, index) => `host-${index}`)
    expect(hasValidHostShape('collective', hosts)).toBe(true)
    expect(hasValidHostShape('collective', [...hosts, 'extra'])).toBe(false)
    expect(number('REMINDER_MIN_GAP_HOURS')).toBe(REMINDER_MIN_GAP.hours)
    expect(number('DEFAULT_REMINDER_OFFSET_MINUTES')).toBe(
      DEFAULT_NOTIFICATIONS.reminders[0]?.offsetMinutes,
    )
    for (const [category, key] of [
      ['reminders', 'REMINDER_MAX_RULES'],
      ['followUps', 'FOLLOW_UP_MAX_RULES'],
    ] as const) {
      expect(() =>
        validateNotifications({ reminders: [], followUps: [], [category]: rules(number(key)) }),
      ).not.toThrow()
      expect(() =>
        validateNotifications({ reminders: [], followUps: [], [category]: rules(number(key) + 1) }),
      ).toThrow()
    }
    for (const category of ['reminders', 'followUps'] as const) {
      for (const [key, delta] of [
        ['NOTIFICATION_MIN_OFFSET_MINUTES', -1],
        ['NOTIFICATION_MAX_OFFSET_MINUTES', 1],
      ] as const) {
        const rule = rules(1)[0]
        const settings = {
          reminders: [],
          followUps: [],
          [category]: [{ ...rule, offsetMinutes: number(key) }],
        }
        expect(() => validateNotifications(settings)).not.toThrow()
        expect(() =>
          validateNotifications({
            ...settings,
            [category]: [{ ...rule, offsetMinutes: number(key) + delta }],
          }),
        ).toThrow()
      }
    }
  })

  it('binds every workflow limit row to its source constant', () => {
    // The limit table's workflow rows and the constants are the same set, number for number.
    const rows = [...document.matchAll(/^\| `(WORKFLOW_[A-Z_]+)` \| \d+ \|/gm)].map(
      (match) => match[1] as string,
    )
    expect(rows).toEqual(Object.keys(WORKFLOW_LIMITS))
    for (const [key, value] of Object.entries(WORKFLOW_LIMITS)) expect(number(key), key).toBe(value)
    // And both stay at the reviewed numbers: changing one is a design change, not an edit.
    expect({ ...WORKFLOW_LIMITS }).toEqual(designLimits)
    expect(text).toContain(
      'The following limits are source constants in `packages/workflows/src/limits.ts`',
    )
    expect(text).not.toMatch(/proposed limits|not existing runtime constants/)
  })

  it('binds the trigger, condition, variable and audit catalogs to the definition contract', () => {
    // Triggers: the trigger table names exactly the schema's trigger types, in order.
    const triggerSection = document
      .split('## Triggers, conditions and snapshots')[1]
      ?.split('\n## ')[0] as string
    const triggers = [...triggerSection.matchAll(/^\| `([a-z_.]+)` \|/gm)].map((match) => match[1])
    expect(triggers).toEqual(WorkflowTriggerSchema.options.map((option) => option.shape.type.value))
    // Conditions: each table row is one schema field, in order, with the operators its label
    // names; the "Personal only" rows are exactly the fields team definitions cannot use.
    const conditionTable =
      triggerSection.split('| Condition | Rationale and comparison |')[1]?.split('\n\n')[0] ?? ''
    const conditionRows = [...conditionTable.matchAll(/^\| ([A-Z][^|]*?) \| ([^|]+) \|$/gm)].map(
      ([, label, rationale]) => ({ label: label as string, rationale: rationale as string }),
    )
    const fields: Record<string, string> = {
      'Event type': 'event_type',
      'Booking source': 'booking_source',
      'Attendee answer': 'answer',
      'Location kind': 'location_kind',
      'Guest count': 'guest_count',
    }
    const schemaFields = WorkflowConditionSchema.options.map((option) => option.shape.field.value)
    expect(conditionRows.map(({ label }) => fields[label.replace(/ equals.*$/, '')])).toEqual(
      schemaFields,
    )
    for (const { label } of conditionRows) {
      const field = fields[label.replace(/ equals.*$/, '')]
      const operators = label
        .slice(label.indexOf('equals'))
        .split('/')
        .map((operator) => operator.replace(' ', '_'))
      expect(
        WorkflowConditionSchema.options.find((option) => option.shape.field.value === field)?.shape
          .operator.options,
        label,
      ).toEqual(operators)
    }
    expect(
      conditionRows
        .filter(({ rationale }) => rationale.startsWith('Personal only'))
        .map(({ label }) => fields[label.replace(/ equals.*$/, '')]),
    ).toEqual([...PERSONAL_ONLY_CONDITION_FIELDS])
    expect(
      conditionRows.find(({ label }) => label.startsWith('Attendee answer'))?.rationale,
    ).toContain(`of a ${WORKFLOW_ANSWER_CONDITION_QUESTION_TYPES.join(' or ')} question`)
    // The source predicate compares the stored enum main installs, without imported bookings.
    const sources = latest(/bookings_source_check\s+CHECK \(source IN \(([^)]*)\)\)/g)
    expect(quoted(sources.match[1]).filter((source) => source !== 'import')).toEqual([
      ...WORKFLOW_BOOKING_SOURCES,
    ])
    // Variables: the placeholder table is the catalog, plus the answer form, and each row's
    // audience is what the catalog allows.
    const placeholders = [
      ...document.matchAll(/^\| `\{\{([a-z_.]+(?:<questionId>)?)\}\}` \| [^|]+ \| ([^|]+) \|$/gm),
    ].map(([, name, audience]) => ({ name: name as string, audience: (audience as string).trim() }))
    expect(placeholders.map(({ name }) => name)).toEqual([
      ...Object.keys(WORKFLOW_TEMPLATE_VARIABLES),
      `${WORKFLOW_ANSWER_VARIABLE_PREFIX}<questionId>`,
    ])
    const everyone = { recipients: WORKFLOW_RECIPIENT_CLASSES, eventType: undefined }
    for (const { name, audience } of placeholders.slice(0, -1)) {
      expect(audience, name).toBe('Every workflow and recipient class')
      for (const owner of ['personal', 'team'] as const)
        expect(templateVariableProblem(name, { ...everyone, owner }), name).toBeUndefined()
    }
    expect(placeholders.at(-1)?.audience).toBe(
      'Personal workflows of one event type whose recipients exclude other attendees',
    )
    const eventType = {
      id: '40000000-0000-4000-8000-000000000001',
      organizationId: '20000000-0000-4000-8000-000000000001',
      ownerUserId: '10000000-0000-4000-8000-000000000001',
      bookingMode: 'individual',
      deleted: false,
      questions: [{ id: 'plan', type: 'select', options: ['a'] }],
    }
    const answerFor = (
      context: Omit<Parameters<typeof templateVariableProblem>[1], 'eventType'> & {
        eventType?: typeof eventType
      },
    ) =>
      templateVariableProblem(`${WORKFLOW_ANSWER_VARIABLE_PREFIX}plan`, {
        eventType: undefined,
        ...context,
      })
    expect(
      answerFor({ owner: 'personal', recipients: ['booker', 'hosts'], eventType }),
    ).toBeUndefined()
    expect(answerFor({ owner: 'team', recipients: ['booker'], eventType })).toBeDefined()
    expect(answerFor({ owner: 'personal', recipients: ['booker'] })).toBeDefined()
    expect(answerFor({ owner: 'personal', recipients: ['guests'], eventType })).toBeDefined()
    expect(text).toContain(
      'The catalog in `packages/workflows/src/variables.ts` names these placeholders',
    )
    // Audit: the recorded events are exactly the port's event list.
    const recorded = text.split('Record `workflow.created`')[1]?.split('. ')[0] as string
    expect(
      [...`\`workflow.created\`${recorded}`.matchAll(/`(workflow\.[a-z_]+)`/g)].map((m) => m[1]),
    ).toEqual([...WORKFLOW_AUDIT_EVENTS])
    // Hard-off: the constant the rollout names is the false source constant.
    expect(WORKFLOWS_IMPLEMENTED).toBe(false)
    expect(text).toContain('Step 1 introduces the source constant `WORKFLOWS_IMPLEMENTED = false`')
  })

  it('binds worst-case demand and the shared allowance formula to documented limits', () => {
    const guests = number('MAX_GUESTS')
    const hosts = number('MAX_HOSTS')
    const recipients = 1 + guests + hosts
    const workflows = number('WORKFLOW_MAX_ENABLED_PER_EVENT')
    const reminders = number('REMINDER_MAX_RULES')
    const followUps = number('FOLLOW_UP_MAX_RULES')
    const busyHourBookings = 10 // Scenario assumption, not an admission rate guarantee.
    expect(document).toContain(`1 + ${guests} + ${hosts} = ${recipients}`)
    expect(document).toContain(
      `${busyHourBookings} * ${workflows} * ${recipients} = ${busyHourBookings * workflows * recipients}`,
    )
    expect(document).toContain(
      `${busyHourBookings} * (${reminders} + ${followUps}) * ${recipients} = ${busyHourBookings * (reminders + followUps) * recipients}`,
    )
    expect(document).toContain(
      `min(${number('WORKFLOW_MAIL_MAX_PER_HOUR')}, floor(MAIL_MAX_PER_HOUR / ${number('WORKFLOW_INSTANCE_MAIL_CAP_DIVISOR')}))`,
    )
    const cap = number('MAIL_MAX_PER_HOUR')
    const combined = Math.floor((cap * number('MAIL_HOST_RESERVE_PERCENT')) / 100)
    const workflowCap = Math.min(
      number('WORKFLOW_MAIL_MAX_PER_HOUR'),
      Math.floor(cap / number('WORKFLOW_INSTANCE_MAIL_CAP_DIVISOR')),
    )
    expect(document).toContain(`base ceiling ${cap}`)
    expect(document).toContain(`combined ceiling ${combined}`)
    expect(document).toContain(`${cap} - ${workflowCap} = ${cap - workflowCap}`)
    expect(document).toContain(`owner ${number('WORKFLOW_OWNER_MAIL_MAX_PER_HOUR')}/h`)
    expect(document).toContain(
      `recipient ${number('WORKFLOW_RECIPIENT_EMAILS_PER_HOUR')}/h and ${number('WORKFLOW_RECIPIENT_EMAILS_PER_DAY')}/day`,
    )
  })

  it('binds the shared ledger and recipient windows to the actual budget queries', async () => {
    const now = new Date('2026-01-02T12:00:00Z')
    const predicates: unknown[][] = []
    const tables: string[] = []
    const aggregate = {
      as: () => aggregate,
      filterWhere: (...args: unknown[]) => {
        predicates.push(args)
        return aggregate
      },
    }
    const query = {
      select: (selection: (eb: unknown) => unknown) => {
        selection({ fn: { countAll: () => aggregate } })
        return query
      },
      where: (...args: unknown[]) => {
        predicates.push(args)
        return query
      },
      executeTakeFirstOrThrow: async () => ({ count: '0', day: '0', hour: '0' }),
    }
    const db = {
      selectFrom: (table: string) => {
        tables.push(table)
        return query
      },
    } as unknown as Db
    const hash = Buffer.alloc(32)
    for (const budget of [
      () => notificationEmailBudget(db, {}, hash, true, now),
      () => signInEmailBudget(db, {}, hash, now),
    ]) {
      predicates.length = 0
      tables.length = 0
      expect(await budget()).toBeUndefined()
      expect(tables).toEqual(['notification_email_sends', 'notification_email_sends'])
      expect(predicates).toEqual([
        ['sent_at', '>', new Date(now.getTime() - number('MAIL_LEDGER_WINDOW_HOURS') * 3_600_000)],
        ['sent_at', '>', new Date(now.getTime() - number('MAIL_LEDGER_WINDOW_HOURS') * 3_600_000)],
        ['recipient_hash', '=', hash],
        ['sent_at', '>', new Date(now.getTime() - 24 * 3_600_000)],
      ])
    }
  })

  it('keeps every implementation dependency earlier than its owning step', () => {
    const rows = planRows()
    // The exact plan, so a dropped, merged or added row cannot go untracked.
    expect(rows.map((row) => row[1])).toEqual([
      ...['1', '2', '3', '4', '5', '6', '7', '8a', '8b', '8c', '9', '10', '11a', '11b'],
      ...['12a', '12b', '13a', '13b', '13c', '13d', '13e', '14a', '14b', '15a', '15b'],
      ...['16a', '16b', '16c', '17a', '17b', '18a', '18b', '19a', '19b', '20'],
    ])
    const seen = new Set<string>()
    for (const row of rows) {
      const step = row[1] as string
      const dependencies = (row[3] as string).trim()
      expect(seen.has(step), `step ${step} has a unique owner`).toBe(false)
      if (dependencies !== 'None') {
        for (const dependency of dependencies.split(',').map((value) => value.trim())) {
          expect(seen.has(dependency), `step ${step} requires earlier step ${dependency}`).toBe(
            true,
          )
        }
      }
      seen.add(step)
    }
    for (const step of ['6', '7']) {
      const row = rows.find((entry) => entry[1] === step)
      expect(row, `step ${step} remains in the plan`).toBeDefined()
      expect(dependencies(row)).toContain('3')
      expect(row?.[6]).not.toMatch(/without a duplicate send|racing worker/)
    }
  })

  it('splits dense steps and wires execution audit events before binding the writer', () => {
    const rows = planRows()
    const step = (id: string) => rows.find((entry) => entry[1] === id)
    for (const id of ['13d', '13e', '15b', '16b', '16c', '17a', '17b', '19a', '19b'])
      expect(step(id), `step ${id} is in the plan`).toBeDefined()
    // Merged rows must not return: the old webhook outbox, audit and opt-in steps.
    for (const id of ['13', '17', '19', '9a', '9b'])
      expect(step(id), `no step ${id}`).toBeUndefined()
    // Pure timer rules precede capture, so capture can record minimum_gap/offset_not_future.
    expect(dependencies(step('8a'))).toEqual(['1'])
    expect(dependencies(step('8b'))).toContain('8a')
    const wiring = step('15b')?.[4] ?? ''
    for (const owner of ['(8b, 8c)', '(9)', '(12a, 12b)', '(14a, 14b)', 'previewed (15a)'])
      expect(wiring).toContain(owner)
    expect(dependencies(step('16b'))).toContain('15b')
    expect(dependencies(step('16c'))).toEqual(['16b'])
    expect(text).toContain('Step 15b alone wires every execution and preview event into the port')
  })

  it('keeps disabled behavior distinct from interface publication and enabled parity inventory', () => {
    const rollout = document
      .split('## Rollout and limitations')[1]
      ?.split('## ')[0]
      ?.replace(/\s+/g, ' ')
    expect(rollout).toContain(
      'Hard-off means behavior, not registration: every workflow operation returns `404 workflows_disabled`',
    )
    expect(rollout).toContain(
      'MCP `tools/list` omits workflow tools while off; direct known-tool calls return the same `404 workflows_disabled`',
    )
    expect(rollout).toContain('Build the parity inventory with the feature enabled')
    expect(rollout).toContain('scope-registry rows ship in each operation')
    expect(rollout).toContain(
      '`apps/site/src/content/docs/docs/api-keys.md` and `mcp.md`, generated from `packages/auth/src/api-key-operations.ts`, list workflow operations',
    )
    expect(rollout).toContain('add adjacent prose documenting them as disabled until enabled')
    // The cited MCP seam: hidden catalog tools still reach runTool on a direct call.
    const tools = read('apps/server/src/mcp/tools.ts')
    expect(tools).toContain(
      'const catalog = new Map(tools.map((prepared) => [prepared.tool.name, prepared]))',
    )
    expect(tools).toContain('return runTool(known.tool, request.params.arguments, call, logError)')
    expect(rollout).toContain('Step 4 extends the catalog/visible split in `registerTools()`')
    expect(rollout).toContain('Workflow tools are always included in `productTools()`')
    for (const consumer of [
      'apps/server/src/capability-contracts.test.ts',
      'apps/server/src/mcp/scopes.test.ts',
      'apps/server/src/mcp/schema-contracts.test.ts',
    ]) {
      expect(read(consumer)).toMatch(/productTools\(\{ db[^)]*slotSnippetsEnabled: true \}\)/)
      expect(rollout).toContain(`\`${consumer}\``)
    }
  })

  it('binds the webhook expansion to the enum, constraints and delivery key on main', () => {
    const current = WEBHOOK_EVENTS.length
    const extended = current + 1
    expect(text).toContain(
      `\`WEBHOOK_EVENTS\` has ${current} kinds: ${prose(code(WEBHOOK_EVENTS))}.`,
    )
    // The service already derives its bound from the constant, so appending needs no literal.
    expect(read('packages/webhooks/src/service.ts')).toContain('.max(WEBHOOK_EVENTS.length)')
    expect(text).toContain('Service `eventsOf()` already validates `.max(WEBHOOK_EVENTS.length)`')
    expect(text).toContain('`eventsOf()` keeps `.max(WEBHOOK_EVENTS.length)` and gains no literal')

    // The installed subscription CHECK is the last one in migration order.
    const subscriptionCheck =
      /cardinality\(events\) BETWEEN 1 AND (\d+) AND\s+events <@ ARRAY\[([^\]]*)\]/g
    const subscription = latest(subscriptionCheck)
    expect(Number(subscription.match[1])).toBe(current)
    expect(quoted(subscription.match[2])).toEqual([...WEBHOOK_EVENTS])
    expect(text).toContain(
      `The webhook baseline on main comes from migration ${subscription.number}`,
    )
    expect(text).toContain(
      `${subscription.number}'s \`webhooks_events_check\` is \`cardinality(events) BETWEEN 1 AND ${current}\``,
    )
    // Step 13d replaces the installed CHECK; every migration that defined one stays as published.
    expect(text).toContain(`replaces ${subscription.number}'s \`webhooks.events\` CHECK`)
    // Both event CHECKs, inline in the first migration and named later, in migration order.
    const deliveryCheck =
      /event_type(?:_check| text NOT NULL) CHECK \(\s*event_type IN \(([^)]*)\)\s*\)/g
    const history = (pattern: RegExp, list: number) =>
      migrations.flatMap(({ number, sql }) =>
        [...sql.matchAll(pattern)].map((match) => ({ number, match, kinds: quoted(match[list]) })),
      )
    const subscriptions = history(subscriptionCheck, 2)
    const deliveries = history(deliveryCheck, 1)
    const definers = subscriptions.map(({ number }) => number)
    expect(definers.at(-1)).toBe(subscription.number)
    expect(deliveries.map(({ number }) => number)).toEqual(definers)
    // Each definition keeps the earlier kinds in order and only appends ("only widened").
    for (const defined of [subscriptions, deliveries])
      for (const [index, { kinds }] of defined.entries()) {
        const earlier = defined[index - 1]?.kinds ?? []
        expect(kinds.slice(0, earlier.length)).toEqual(earlier)
        expect(kinds.length).toBeGreaterThan(earlier.length)
      }
    for (const { match, kinds } of subscriptions) expect(Number(match[1])).toBe(kinds.length)
    expect(text).toContain(
      `${definers.at(-1)} only widened both constraints; ${definers[0]} created them and ${prose(definers.slice(1, -1))} replaced them before`,
    )
    expect(text).toContain(`Published migrations ${prose(definers)} remain unchanged`)
    expect(text).toContain(`\`cardinality(events) BETWEEN 1 AND ${current}\``)
    expect(text).toContain(`\`cardinality(events) BETWEEN 1 AND ${extended}\``)
    for (const [, upper] of text.matchAll(/BETWEEN 1 AND (\d+)/g))
      expect([current, extended]).toContain(Number(upper))
    const counts = [
      ...text.matchAll(/(\d+) to (\d+) kinds/g),
      ...text.matchAll(/(\d+) current kinds to (\d+)/g),
    ]
    expect(counts.length).toBeGreaterThanOrEqual(4)
    for (const [, from, to] of counts)
      expect([Number(from), Number(to)]).toEqual([current, extended])
    // Any other digit count, with up to two words before kinds, events or event types or in the
    // hyphenated "6-kind" form, or a "1 to N" cardinality, is the current or extended set.
    for (const [phrase, count] of text.matchAll(
      /\b(\d+)(?:-| (?:[a-z]+ ){0,2})(?:kinds?|events|event types)\b/g,
    ))
      expect([current, extended], phrase).toContain(Number(count))
    for (const [phrase, upper] of text.matchAll(/cardinality[^.]*?\b1 ?(?:to|–|-) ?(\d+)\b/g))
      expect([current, extended], phrase).toContain(Number(upper))
    // A "1 to N" range in any sentence about kinds, events or their CHECKs, with or without
    // the word cardinality ("previously 1 to 4"), is the current or extended set too.
    const ranges = text
      .split(/(?<=\.) /)
      .filter((sentence) => /\bkinds?\b|CHECK|cardinality|WEBHOOK_EVENTS/.test(sentence))
      .flatMap((sentence) => [...sentence.matchAll(/\b1 ?(?:to|–|-) ?(\d+)\b/g)])
    for (const [phrase, upper] of ranges)
      expect([current, extended], phrase).toContain(Number(upper))
    expect(text).toContain(
      `The bound of ${extended} lets an endpoint already subscribed to all ${current} current kinds add the workflow kind`,
    )

    // Delivery kinds and the delivery uniqueness key as main installs and uses them.
    const deliveryKinds = latest(deliveryCheck)
    expect(quoted(deliveryKinds.match[1])).toEqual([...WEBHOOK_EVENTS])
    // The baseline says one migration ("its") defines both event CHECKs.
    expect(deliveryKinds.number).toBe(subscription.number)
    expect(text).toContain(
      `replaces ${deliveryKinds.number}'s \`webhook_deliveries.event_type\` CHECK`,
    )
    const key = latest(/ALTER TABLE webhook_deliveries ADD UNIQUE NULLS NOT DISTINCT \(([^)]*)\)/g)
    const columns = key.match[1] as string
    expect(columns).toBe('webhook_id, booking_id, event_type, request_id')
    const delivery = read('packages/webhooks/src/delivery.ts')
    expect(delivery).toContain(
      `oc.columns([${columns
        .split(', ')
        .map((column) => `'${column}'`)
        .join(', ')}]).doNothing()`,
    )
    expect(key.number).not.toBe(subscription.number)
    expect(text).toContain(
      `\`UNIQUE NULLS NOT DISTINCT (${columns})\`, which ${key.number} added and ${subscription.number} left unchanged`,
    )
    expect(text).toContain(`the delivery key is still the one ${key.number} added`)
    const requestColumn = latest(/ALTER TABLE webhook_deliveries ADD COLUMN (request_id) uuid;/g)
    expect(text).toContain(`follows ${requestColumn.number}'s \`request_id\` pattern`)
    // Migration numbers in these spellings must be main's: "NNNN's `webhooks.events` CHECK",
    // "the NNNN event_type/delivery/subscription CHECK", "NNNN's `webhooks_events_check`" or
    // "`webhook_deliveries_event_type_check`", and for the key "NNNN's NULLS NOT DISTINCT",
    // "NNNN's delivery key" or "the delivery key is still the one NNNN added".
    for (const [phrase, checkNumber, constraintNumber] of text.matchAll(
      /\b(\d{4})(?:'s)? `?(?:webhooks_events_check|webhooks\.events|webhook_deliveries(?:\.event_type|_event_type_check)|event_type|delivery|subscription)`? CHECK|\b(\d{4})(?:'s)? `(?:webhooks_events_check|webhook_deliveries_event_type_check)`/g,
    ))
      expect(checkNumber ?? constraintNumber, phrase).toBe(subscription.number)
    for (const [phrase, keyNumber, addedNumber] of text.matchAll(
      /\b(\d{4})(?:'s)? (?:NULLS NOT DISTINCT|delivery key)|\bdelivery key is still the one (\d{4}) added/g,
    ))
      expect(keyNumber ?? addedNumber, phrase).toBe(key.number)
    expect(text).toContain(`\`UNIQUE NULLS NOT DISTINCT (${columns}, workflow_run_id)\``)
    expect(text).toContain('No existing row is rewritten or backfilled')
    // Attendance rows store a fresh per-change receipt in request_id, as the baseline says.
    expect(delivery).toContain(
      "const receiptId = event.type === 'attendee_no_show_changed' ? eventId : requestId",
    )
    expect(delivery).toContain('request_id: receiptId,')
    expect(text).toContain('Attendance rows carry a fresh per-change receipt ID')
    expect(text).toContain("Request-origin rows carry the reschedule request's ID")

    // Stale baselines from before the reschedule-request and attendance kinds must not return.
    for (const stale of [
      /\.max\(3\)/,
      /\.max\(\d+\)/,
      // Counts of kinds are written as digits, which the checks above derive from main.
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)(?:-| (?:[a-z]+ ){0,2})(?:kinds?|events|event types)\b/i,
      /from three to four/i,
      /\b1[–-]4\b/,
      /\(4\), matching/,
      /\(webhook_id, booking_id, event_type\)/,
      /Backfill existing rows as booking-origin/,
      /No-show marking is absent/,
    ])
      expect(text).not.toMatch(stale)

    expect(text).toContain('Steps 13d and 13e own the additive `workflow.executed` subscription')
    expect(text).toContain(
      'Document response enums as open and tell consumers to ignore unknown events',
    )
    expect(text).toContain(
      '`WebhookDelivery.bookingId` remains a required UUID, never null or omitted, including team workflow deliveries',
    )
    expect(text).toContain('verifies an additive OpenAPI diff')
    expect(text).toContain('so `workflows_disabled` wins when both apply')
    expect(text).toContain('compares the requested set with the row locked by `lockedWebhook()`')
    // Postgres needs the exact arbiter columns once 14a re-keys the delivery uniqueness.
    expect(text).toContain("moves the existing capture's conflict target")
    const step = (id: string) => planRows().find((row) => row[1] === id)?.[4] ?? ''
    expect(step('13d')).toContain(`replaces the ${subscription.number} webhooks.events CHECK`)
    expect(step('13d')).toContain(`BETWEEN 1 AND ${extended}`)
    expect(step('13d')).toContain(`${current} to ${extended} kinds`)
    expect(step('14a')).toContain('webhook_deliveries.workflow_run_id')
    expect(step('14a')).toContain(`re-keys the ${key.number} NULLS NOT DISTINCT uniqueness`)
    expect(step('14a')).toContain(`replaces the ${deliveryKinds.number} event_type CHECK`)
  })

  it('keeps plan rows and prose agreeing on precedence, lazy disable, the ledger and availability', () => {
    const step = (id: string) => planRows().find((row) => row[1] === id)?.[4] ?? ''
    const acceptance = (id: string) => planRows().find((row) => row[1] === id)?.[6] ?? ''
    // Error precedence: workflows_disabled answers before webhooks_disabled, in row and prose.
    expect(acceptance('13d')).toContain(
      'returns 404 workflows_disabled while off, ahead of 409 webhooks_disabled',
    )
    expect(text).toContain(
      'For create, the check runs with event validation, before the destination policy and the existing `409 webhooks_disabled` check, so `workflows_disabled` wins when both apply',
    )
    for (const reversed of [
      /after (?:the existing )?`?409 webhooks_disabled/,
      /behind (?:the existing )?`?409 webhooks_disabled/,
      /`?webhooks_disabled`? wins/,
    ])
      expect(text).not.toMatch(reversed)
    // Disabling one definition is lazy; deletion is the eager retirement.
    expect(acceptance('6')).toContain(
      'disable and re-enable change only the definition row and never write, retire or backfill an execution row',
    )
    expect(text).toContain(
      'Disabling one definition is lazy, like the operator switch below: it changes no execution row',
    )
    expect(`${step('6')} ${acceptance('6')}`).not.toMatch(/retires? (?:every|all|each|pending)/)
    expect(acceptance('7')).toContain(
      'the deleting transaction marks every pending fixture run of the definition retired',
    )
    // The operator-off sweep is lazy too: only claimed runs are skipped.
    expect(text).toContain(
      'Pending runs become terminally skipped as `instance_disabled` only when they are claimed while off; future runs are not eagerly swept',
    )
    expect(acceptance('19a')).toContain('only due wakes skip while off and future rows survive')
    expect(text).not.toMatch(/(?<!not )eagerly swept|sweeps? (?:every|all) pending/)
    // Workflow mail is charged in the shared ledger, never a separate one.
    expect(step('10')).toContain(
      'admission inserts the workflow-linked `notification_email_sends` row and the reservation row in one transaction',
    )
    expect(`${step('10')} ${acceptance('10')}`).not.toMatch(/separate (?:workflow )?ledger/)
    // Step 4 owns the availability field on /instance, and reports false.
    expect(step('4')).toContain(
      'Add optional `workflowsEnabled` to existing `GET /api/v1/instance`',
    )
    expect(acceptance('4')).toContain('`/instance` reports false')
    expect(acceptance('19b')).toContain('`/instance` reports false')
  })

  it('decides attendee no-shows and every booking webhook kind, and names the integration tests 13d updates', () => {
    const listed = (pattern: RegExp) =>
      [...(pattern.exec(text)?.[1] ?? '').matchAll(/`([a-z_.]+)`/g)].map((match) => match[1])
    // Every notifier the scheduling package exposes is decided by name in the design.
    const context = read('packages/scheduling/src/context.ts')
    const notifiers = [...context.matchAll(/^export type (\w+Notifier) =/gm)].map(
      (match) => match[1] as string,
    )
    expect(notifiers).toEqual(expect.arrayContaining(['BookingNotifier', 'AttendeeNoShowNotifier']))
    for (const notifier of notifiers) expect(text).toContain(`\`${notifier}\``)
    // Today only webhook capture implements the attendance notifier.
    expect(read('apps/server/src/server.ts')).toContain(
      'const notifyAttendeeNoShow = webhookAttendeeNoShowNotifier(jobs, webhookSettings)',
    )
    expect(text).toContain('`AttendeeNoShowNotifier`, which only webhook capture implements')

    // Lifecycle triggers share their names with webhook kinds; every other booking kind on
    // main is explicitly not a trigger, so a new kind fails here until the design decides it.
    const triggerSection = document
      .split('## Triggers, conditions and snapshots')[1]
      ?.split('\n## ')[0]
    const triggers = [...(triggerSection ?? '').matchAll(/^\| `(booking\.[a-z_]+)` \|/gm)].map(
      (match) => match[1] as string,
    )
    expect(triggers).toEqual(['booking.created', 'booking.cancelled', 'booking.rescheduled'])
    for (const trigger of triggers) expect(WEBHOOK_EVENTS).toContain(trigger)
    expect(
      listed(
        /booking webhook kinds on main that are not workflow triggers are ((?:`[a-z_.]+`(?:, | and )?)+)\./,
      ),
    ).toEqual(
      WEBHOOK_EVENTS.filter((kind) => kind.startsWith('booking.') && !triggers.includes(kind)),
    )
    expect(text).toContain('`booking.attendee_no_show_changed` is not a workflow trigger')
    expect(text).toContain('a mark or unmark changes no workflow run')
    expect(text).toContain(
      'Existing subscriptions that include `booking.attendee_no_show_changed` keep working unchanged',
    )
    // The no-show guide this decision relies on: private marker, no email, follow-ups continue.
    const noShows = read('apps/site/src/content/docs/docs/no-shows.md').replace(/\s+/g, ' ')
    expect(noShows).toContain('Marking or unmarking sends no email')
    expect(noShows).toContain('a follow-up may still be sent to an attendee marked as a no-show')

    // Decisions restated in rows, lists and prose, which the board turns into separate cards.
    const step = (id: string) => planRows().find((row) => row[1] === id)?.[4] ?? ''
    const acceptance = (id: string) => planRows().find((row) => row[1] === id)?.[6] ?? ''
    expect(acceptance('1')).toContain(
      'a no-show trigger, condition or variable is rejected as unknown',
    )
    expect(step('8c')).toContain('workflows register nothing on `AttendeeNoShowNotifier`')
    expect(acceptance('8c')).toContain('and so does marking or unmarking an attendee as a no-show')
    expect(acceptance('9')).toContain(
      'a pending reschedule request or a no-show mark neither delays nor skips a due run',
    )
    expect(text).toContain(
      'triggers on reschedule requests or attendee no-show changes, and workflow triggers in Zapier, n8n or Make',
    )
    expect(text).toContain('No stored `events` array is rewritten or expanded')
    // Only owners and admins who do not host the booking are limited to a browser session.
    expect(text).toContain(
      'team owners and admins who do not host the booking can mark only through a browser session',
    )
    expect(text).toContain(
      'The `workflows_disabled` check below concerns only adding `workflow.executed`, so keeping, adding or removing the attendance kind behaves as today',
    )
    // The no-show migration is the one that adds the marker.
    const markers = migrations.filter(({ sql }) => /ADD COLUMN no_show_marked_at\b/.test(sql))
    expect(markers).toHaveLength(1)
    expect(text).toContain(`Attendee no-show marking is on main (migration ${markers[0]?.number},`)

    // Every test under tools/ or scripts/ that binds to WEBHOOK_EVENTS, and every internal test
    // that subscribes an endpoint to every kind, is named in step 13d, which appends the
    // workflow kind. Zapier has none, so it needs no change.
    const binders = ['tools', 'scripts']
      .flatMap((directory) => files(directory, testFile))
      .filter((file) => file !== 'scripts/workflows-docs.test.ts')
      .filter((file) => read(file).includes('WEBHOOK_EVENTS'))
      .sort()
    const subscribers = ['packages', 'apps']
      .flatMap((directory) => files(directory, testFile))
      .filter((file) =>
        /events:\s*(?:\[\s*\.\.\.WEBHOOK_EVENTS\s*\]|Array\.from\(\s*WEBHOOK_EVENTS\s*\)|WEBHOOK_EVENTS(?:\.slice\(\))?\b)/.test(
          read(file),
        ),
      )
      .sort()
    expect(binders.length).toBeGreaterThan(0)
    expect(subscribers.length).toBeGreaterThan(0)
    expect(
      [...step('13d').matchAll(/`([^`]+\.test\.tsx?)`/g)].map((match) => match[1]).sort(),
    ).toEqual([...binders, ...subscribers].sort())
    for (const file of [...binders, ...subscribers]) expect(text).toContain(`\`${file}\``)
    const count = numberWords[binders.length] ?? String(binders.length)
    expect(text).toContain(
      `${count.charAt(0).toUpperCase()}${count.slice(1)} integration tests bind to \`WEBHOOK_EVENTS\``,
    )
    expect(binders.filter((file) => file.includes('zapier'))).toEqual([])
    expect(text).toContain('Zapier needs no change')
    expect(text).toContain('Zapier, n8n and Make do not offer `workflow.executed` in v1')
    expect(text).toContain('through one explicit exclusion of that kind')
    expect(step('13d')).toContain('including the n8n OpenAPI enum comparison')
    expect(step('13d')).toContain('the n8n EVENTS, Make tables and Zapier app stay unchanged')
    expect(step('13e')).toContain(
      'state in the Zapier, n8n and Make guides that they do not offer it',
    )
    expect(text).toContain(
      'Step 13e says in the Zapier, n8n and Make guides that they do not offer the workflow kind',
    )

    // Guides that say webhook management has no MCP/CLI operation are rewritten by step 13a,
    // the first step that adds one.
    const restOnly = [
      'README.md',
      ...files('packages', /^README\.md$/),
      ...['docs', 'apps/site/src/content', 'tools'].flatMap((directory) =>
        files(directory, /\.md$/),
      ),
    ]
      .filter((file) => file !== 'docs/workflows.md')
      .filter((file) => read(file).replace(/\s+/g, ' ').includes('Webhook management is REST-only'))
      .sort()
    expect(restOnly.length).toBeGreaterThan(0)
    expect([...step('13a').matchAll(/`([^`]+\.md)`/g)].map((match) => match[1]).sort()).toEqual(
      restOnly,
    )
    expect(step('13a')).toContain('"Webhook management is REST-only" sentence')
  }, 30_000) // Reads every test and Markdown file it scans; a cold file cache can be slow.

  it('decides every BookingNotifier event kind on main for workflow capture', () => {
    const context = read('packages/scheduling/src/context.ts')
    const union = context.split('export type BookingEvent =')[1]?.split('\n\n')[0] ?? ''
    const kinds = [...union.matchAll(/type: '([a-z_]+)'/g)].map((match) => match[1] as string)
    expect(kinds.length).toBeGreaterThan(0)
    const listed = (pattern: RegExp) =>
      [...(pattern.exec(text)?.[1] ?? '').matchAll(/`([a-z_]+)`/g)].map((match) => match[1])
    const capturing = listed(/and only for its ((?:`[a-z_]+`(?:, | and )?)+) events/)
    const silent = listed(/also has ((?:`[a-z_]+`(?:, | and )?)+)\. Those \w+ capture no workflow/)
    expect(capturing).toEqual(['created', 'rescheduled', 'cancelled'])
    expect([...capturing, ...silent].sort()).toEqual([...kinds].sort())
    expect(text).toContain(
      `Those ${numberWords[silent.length]} capture no workflow and create no occurrence. They neither retire, recalculate nor postpone timers or delayed work`,
    )
    expect(text).toContain('V1 offers no workflow trigger for reschedule requests')
  })

  it('records workflow charges in the shared ledger and bounds SMTP outage behavior', () => {
    expect(text).toContain(
      'Workflow charges are recorded in `notification_email_sends`, the table that core admission already counts, not in a separate ledger',
    )
    expect(text).toContain(
      'one `notification_email_sends` row with a workflow-purpose recipient hash and `workflow_reservation_id` set',
    )
    expect(text).toContain('It recounts every window without its own ledger row')
    expect(text).toContain('A retry never adds a second ledger row')
    const retry = bookingNotificationJob({} as NotificationDeps).retry
    expect(retry).toEqual({
      limit: number('NOTIFICATION_RETRY_LIMIT'),
      delaySeconds: number('NOTIFICATION_RETRY_DELAY_SECONDS'),
      backoff: true,
      maxDelaySeconds: number('NOTIFICATION_RETRY_MAX_DELAY_SECONDS'),
    })
    // Webhook deliveries share the schedule the design calls "roughly seven-hour".
    expect(webhookDeliveryJob({} as WebhookDeps).retry).toEqual(retry)
    let seconds = 0
    for (let attempt = 0; attempt < number('NOTIFICATION_RETRY_LIMIT'); attempt++)
      seconds += Math.min(
        number('NOTIFICATION_RETRY_DELAY_SECONDS') * 2 ** attempt,
        number('NOTIFICATION_RETRY_MAX_DELAY_SECONDS'),
      )
    const hours = numberWords[Math.round(seconds / 3600)]
    expect(text).toContain(
      `Core booking-notification mail retries ${number('NOTIFICATION_RETRY_LIMIT')} times, from one minute, doubling, capped at one hour: about ${hours} hours in total`,
    )
    expect(text).toContain(`roughly ${hours}-hour retry schedule`)
    expect(text).toContain(
      `An SMTP outage longer than the ${number('WORKFLOW_MAX_LATE_MINUTES')}-minute late bound`,
    )
    expect(text).toContain(
      `An SMTP outage longer than ${number('WORKFLOW_MAX_LATE_MINUTES')} minutes expires the workflow email due in it, while core mail retries for about ${hours} hours`,
    )
  })

  it('forwards workflow settings through Compose with empty defaults and lazy disable', () => {
    const compose = read('docker-compose.yml')
    expect(compose).not.toMatch(/^\s*env_file:/m)
    expect(compose).toMatch(/^ {4}environment:$/m)
    expect(read('docker-compose.worker.yml')).toMatch(/extends:\n\s+file: docker-compose\.yml/)
    // Empty Compose forwards mean the server default for flags and mail limits alike.
    const synthetic = {
      DATABASE_URL: 'postgres://localhost/workflows_docs_unused',
      BETTER_AUTH_SECRET: 'workflows-docs-synthetic-secret-32-characters',
    }
    const empty = loadConfig({
      ...synthetic,
      SLOT_SNIPPETS_ENABLED: '',
      FOLLOW_UP_HOST_NOTES_ENABLED: '',
      MAIL_MAX_PER_HOUR: '',
    })
    expect(empty.SLOT_SNIPPETS_ENABLED).toBe(false)
    expect(empty.FOLLOW_UP_HOST_NOTES_ENABLED).toBe(true)
    expect(empty.MAIL_MAX_PER_HOUR).toBe(number('MAIL_MAX_PER_HOUR'))
    for (const key of [
      'WORKFLOWS_ENABLED',
      'WORKFLOW_MAIL_MAX_PER_HOUR',
      'WORKFLOW_OWNER_MAIL_MAX_PER_HOUR',
    ]) {
      expect(text).toContain(`\`\${${key}:-}\``)
      expect(text).toContain(`\`${key}=\``)
      expect(document).not.toMatch(new RegExp(`\\$\\{${key}:-[^}]`))
    }
    expect(text).toContain('so step 10 adds no `.env.example` line or `configuration.md` row')
    const step = (id: string) => planRows().find((row) => row[1] === id)?.[4] ?? ''
    expect(step('10')).toContain(`Compose \`\${…:-}\` forwards`)
    expect(step('19b')).toContain(`\`\${WORKFLOWS_ENABLED:-}\``)
    expect(text).toContain('Disabling one definition is lazy')
    expect(text).toContain('Deletion is eager')
    expect(text).toContain('`workflowsEnabled`')
    const instance = read('apps/server/src/routes/instance.ts')
    for (const field of ['followUpHostNotesEnabled', 'slotSnippetsEnabled'])
      expect(instance).toContain(`${field}: z.boolean().optional()`)
  })

  it('keeps host-authored workflow text under the existing Cloud abuse policy', () => {
    expect(text).toContain(
      'Host-written subject and body text use the same `FOLLOW_UP_HOST_NOTES_ENABLED` policy',
    )
    expect(text).toContain(
      'When false, save/update/preview reject custom subject/body with `invalid_workflow`; templates permit only built-in localized text and safe variables',
    )
    expect(text).toContain('Dispatch rechecks the switch and falls back to built-in text')
    expect(text).toContain('Hourmere Cloud MUST keep it false')
    expect(text).toContain('Self-hosted defaults retain the existing true host-notes default')
    expect(text).toContain(
      'The final workflow default flip does not change this independent switch or relax the Cloud requirement',
    )
  })
})
