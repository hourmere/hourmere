import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../apps/server/src/config.ts'
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

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const document = read('docs/workflows.md')
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
  WORKFLOW_MAX_DEFINITIONS_PER_OWNER: 100,
  WORKFLOW_NAME_MAX_BYTES: 200,
  WORKFLOW_SUBJECT_MAX_BYTES: 200,
  WORKFLOW_BODY_MAX_BYTES: 8000,
  WORKFLOW_RENDERED_MAX_BYTES: 16000,
  WORKFLOW_MAX_ENABLED_PER_EVENT: 5,
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

  it('pins the design limits separately from existing product limits', () => {
    for (const [key, expected] of Object.entries(designLimits))
      expect(number(key), key).toBe(expected)
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
    const rows = [
      ...document.matchAll(
        /^\| (\d+[a-z]?)\. ([^|]+)\| ([^|]+)\| ([^|]+)\| ([^|]+)\| ([^|]+)\|$/gm,
      ),
    ]
    expect(rows.length).toBeGreaterThanOrEqual(26)
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
      expect(row?.[3]?.split(',').map((value) => value.trim())).toContain('3')
      expect(row?.[6]).not.toMatch(/without a duplicate send|racing worker/)
    }
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
  })

  it('owns additive webhook expansion while preserving the published booking identifier', () => {
    const text = document.replace(/\s+/g, ' ')
    expect(text).toContain(
      'Step 13d owns the additive `workflow.executed` subscription expansion: `WEBHOOK_EVENTS`',
    )
    expect(text).toContain(
      'becoming `.max(WEBHOOK_EVENTS.length)` (4), matching published create/update input bounds',
    )
    expect(text).toContain(
      'Document response enums as open and tell consumers to ignore unknown events',
    )
    expect(text).toContain(
      '`WebhookDelivery.bookingId` remains a required UUID, never null or omitted, including team workflow deliveries',
    )
    expect(text).toContain('Step 13d verifies an additive OpenAPI diff')
  })

  it('keeps host-authored workflow text under the existing Cloud abuse policy', () => {
    const text = document.replace(/\s+/g, ' ')
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
