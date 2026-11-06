import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { parseEnv } from 'node:util'
import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../apps/server/src/config.ts'
import {
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
  WORKFLOW_INSTANCE_EMAILS_PER_HOUR: 20,
  WORKFLOW_INSTANCE_MAIL_CAP_DIVISOR: 5,
  WORKFLOW_OWNER_EMAILS_PER_HOUR: 5,
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

  it('binds worst-case arithmetic and the isolated allowance formula to documented limits', () => {
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
      `min(${number('WORKFLOW_INSTANCE_EMAILS_PER_HOUR')}, floor(MAIL_MAX_PER_HOUR / ${number('WORKFLOW_INSTANCE_MAIL_CAP_DIVISOR')}))`,
    )
    const combined =
      Math.floor((number('MAIL_MAX_PER_HOUR') * number('MAIL_HOST_RESERVE_PERCENT')) / 100) +
      number('WORKFLOW_INSTANCE_EMAILS_PER_HOUR')
    expect(document).toContain(`${combined}, not ${number('MAIL_MAX_PER_HOUR')}`)
  })

  it('kills a changed instance default in an isolated source copy, then verifies the original', () => {
    const source = read('packages/notifications/src/mail-limits.ts')
    const functionSource = source.slice(
      source.indexOf('export function notificationSuppressionReason('),
      source.indexOf('/**\n * Use after identity locks'),
    )
    expect(functionSource).toContain('limits.mailMaxPerHour ?? 100')
    const compile = (text: string): Suppress =>
      new Function(
        `${stripTypeScriptTypes(text).replace('export ', '')}; return notificationSuppressionReason`,
      )() as Suppress
    verifyMailDefaults(compile(functionSource))
    const mutant = compile(
      functionSource.replace('limits.mailMaxPerHour ?? 100', 'limits.mailMaxPerHour ?? 101'),
    )
    expect(() => verifyMailDefaults(mutant)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyMailDefaults(compile(functionSource))
    expect(read('packages/notifications/src/mail-limits.ts')).toBe(source)
  })
})
