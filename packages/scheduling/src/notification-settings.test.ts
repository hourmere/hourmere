import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { FOLLOW_UP_HOST_NOTE_MAX_LENGTH } from '@hourmere/core/follow-up-note'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { DomainError } from './errors.ts'
import {
  createNotificationSnapshot,
  DEFAULT_NOTIFICATIONS,
  type FollowUpRule,
  isLegacyDefault,
  notificationSnapshot,
  parseNotifications,
  type ReminderRule,
  validateNotifications,
} from './notification-settings.ts'

type SettingsModule = Pick<
  typeof import('./notification-settings.ts'),
  | 'validateNotifications'
  | 'createNotificationSnapshot'
  | 'notificationSnapshot'
  | 'isLegacyDefault'
  | 'parseNotifications'
>
type Replacement = readonly [string, string]

function sourceCopy(replacement?: Replacement): SettingsModule {
  let source = readFileSync('packages/scheduling/src/notification-settings.ts', 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source.replace(/^import .*\n/gm, '')).replace(/\bexport /g, '')
  return new Function(
    'z',
    'DomainError',
    'FOLLOW_UP_HOST_NOTE_MAX_LENGTH',
    `${source}; return { validateNotifications, createNotificationSnapshot, notificationSnapshot, isLegacyDefault, parseNotifications }`,
  )(z, DomainError, FOLLOW_UP_HOST_NOTE_MAX_LENGTH) as SettingsModule
}

function rule(id = 'rule-1', offsetMinutes = 60) {
  return { id, offsetMinutes, recipients: { invitee: true, guests: false, host: false } }
}

const settings = (reminders = [rule()], followUps: ReturnType<typeof rule>[] = []) => ({
  reminders,
  followUps,
})

const malformed: [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['an array', []],
  ['missing reminders', { followUps: [] }],
  ['missing follow-ups', { reminders: [] }],
  ['extra top-level properties', { ...settings(), hostNote: 'unexpected' }],
  ['a null reminder list', { ...settings(), reminders: null }],
  ['a non-array follow-up list', { ...settings(), followUps: {} }],
  ['a null rule', { reminders: [null], followUps: [] }],
  [
    'a missing id',
    { reminders: [{ offsetMinutes: 60, recipients: rule().recipients }], followUps: [] },
  ],
  ['a non-string id', settings([{ ...rule(), id: 42 } as never])],
  ['a missing offset', { reminders: [{ id: 'a', recipients: rule().recipients }], followUps: [] }],
  ['a string offset', settings([{ ...rule(), offsetMinutes: '60' } as never])],
  ['a missing recipient object', { reminders: [{ id: 'a', offsetMinutes: 60 }], followUps: [] }],
  ['a null recipient object', settings([{ ...rule(), recipients: null } as never])],
  ['extra rule properties', settings([{ ...rule(), subject: 'Unexpected' } as never])],
  [
    'missing recipient flags',
    settings([{ ...rule(), recipients: { invitee: true, host: false } } as never]),
  ],
  [
    'non-boolean recipient flags',
    settings([{ ...rule(), recipients: { ...rule().recipients, guests: 1 } } as never]),
  ],
  [
    'extra recipient flags',
    settings([{ ...rule(), recipients: { ...rule().recipients, organizer: true } } as never]),
  ],
]

const invalid: [string, unknown][] = [
  ['too many reminders', settings(Array.from({ length: 6 }, (_, i) => rule(`r${i}`, 5 + i)))],
  [
    'too many follow-ups',
    settings(
      [],
      Array.from({ length: 4 }, (_, i) => rule(`f${i}`, 5 + i)),
    ),
  ],
  ...['', 'a b', '中文', 'a.b', '__proto__', 'a'.repeat(65)].map((id): [string, unknown] => [
    `invalid id ${JSON.stringify(id)}`,
    settings([rule(id)]),
  ]),
  ...[-1, 0, 4, 43201, 5.5, Number.NaN, Number.POSITIVE_INFINITY].map(
    (offset): [string, unknown] => [
      `invalid reminder offset ${offset}`,
      settings([rule('a', offset)]),
    ],
  ),
  ...[-1, 0, 4, 43201, 5.5].map((offset): [string, unknown] => [
    `invalid follow-up offset ${offset}`,
    settings([], [rule('a', offset)]),
  ]),
  ['duplicate reminder ids', settings([rule('a', 60), rule('a', 120)])],
  ['duplicate follow-up ids', settings([], [rule('a', 60), rule('a', 120)])],
  ['ids repeated between categories', settings([rule('a', 60)], [rule('a', 120)])],
  ['duplicate reminder offsets', settings([rule('a', 60), rule('b', 60)])],
  ['duplicate follow-up offsets', settings([], [rule('a', 60), rule('b', 60)])],
  [
    'no selected reminder recipients',
    settings([{ ...rule(), recipients: { invitee: false, guests: false, host: false } }]),
  ],
  [
    'no selected follow-up recipients',
    settings([], [{ ...rule(), recipients: { invitee: false, guests: false, host: false } }]),
  ],
]

function verifySemantic(copy: SettingsModule) {
  for (const [label, value] of invalid) {
    // NaN/infinity are malformed JSON numbers and may be rejected by the shape parser.
    if (label.includes('NaN') || label.includes('Infinity')) continue
    expect(() => copy.validateNotifications(value), label).toThrow(
      expect.objectContaining({ kind: 'invalid', code: 'invalid_notifications' }),
    )
  }
}

function verifyCanonical(copy: SettingsModule) {
  const input = settings(
    [rule('near', 5), rule('far', 43200)],
    [rule('later', 43200), rule('soon', 5)],
  )
  expect(copy.validateNotifications(input)).toEqual({
    reminders: [rule('far', 43200), rule('near', 5)],
    followUps: [rule('soon', 5), rule('later', 43200)],
  })
  expect(input.reminders.map((r) => r.id)).toEqual(['near', 'far'])
  expect(input.followUps.map((r) => r.id)).toEqual(['later', 'soon'])
}

function verifyModes(copy: SettingsModule) {
  expect(copy.isLegacyDefault(DEFAULT_NOTIFICATIONS)).toBe(true)
  const renamed = structuredClone(DEFAULT_NOTIFICATIONS)
  const first = renamed.reminders[0]
  if (!first) throw new Error('Missing default reminder fixture')
  renamed.reminders[0] = { ...first, id: 'stable-custom-spelling' }
  expect(copy.createNotificationSnapshot(renamed)).toEqual({
    version: 1,
    executionMode: 'legacy_default',
    notifications: renamed,
  })
  const allRoles = { invitee: true, guests: true, host: true }
  for (const value of [
    settings([]),
    settings([rule('a', 1440)]),
    settings([{ ...rule('a', 1439), recipients: allRoles }]),
    settings([{ ...rule('a', 1440), recipients: allRoles }, rule('b', 60)]),
    ...(['invitee', 'guests', 'host'] as const).map((role) =>
      settings([{ ...rule('a', 1440), recipients: { ...allRoles, [role]: false } }]),
    ),
    { ...DEFAULT_NOTIFICATIONS, followUps: [rule('f', 60)] },
  ]) {
    expect(copy.isLegacyDefault(value)).toBe(false)
    expect(copy.createNotificationSnapshot(value).executionMode).toBe('configurable')
  }
  expect(copy.notificationSnapshot(null)).toEqual({
    version: 1,
    executionMode: 'legacy_default',
    notifications: DEFAULT_NOTIFICATIONS,
  })
}

function verifyHostNotes(copy: SettingsModule) {
  for (const hostNote of [
    '',
    '<script>A & B</script>\nNext line',
    'a'.repeat(2000),
    '😀'.repeat(1000),
  ]) {
    const input = { reminders: [], followUps: [{ ...rule('f'), hostNote }] }
    expect(copy.validateNotifications(input)).toEqual(input)
    const snapshot = copy.createNotificationSnapshot(input)
    expect(copy.notificationSnapshot(snapshot).notifications).toEqual(input)
    expect(() => copy.validateNotifications(input, { followUpHostNotesEnabled: false })).toThrow(
      expect.objectContaining({ code: 'invalid_notifications' }),
    )
  }
  const raw = `${'a'.repeat(1998)}\r\n\u202aX\u202e\u2066\u2069`
  let canonical: ReturnType<SettingsModule['validateNotifications']> | undefined
  expect(() => {
    canonical = copy.validateNotifications({
      reminders: [],
      followUps: [{ ...rule('f'), hostNote: raw }],
    })
  }).not.toThrow()
  expect(canonical?.followUps[0]?.hostNote).toBe(`${'a'.repeat(1998)}\nX`)
  for (const hostNote of [null, 42, {}])
    expect(() =>
      copy.validateNotifications({ reminders: [], followUps: [{ ...rule('f'), hostNote }] }),
    ).toThrow(z.ZodError)
  for (const hostNote of [
    'a'.repeat(2001),
    '😀'.repeat(1001),
    '\ud800',
    '\udc00',
    '\u0000',
    '\t',
    '\r',
    '\u000b',
    '\u007f',
    '\u0085',
  ])
    expect(() =>
      copy.validateNotifications({ reminders: [], followUps: [{ ...rule('f'), hostNote }] }),
    ).toThrow(expect.objectContaining({ code: 'invalid_notifications' }))
  expect(() =>
    copy.validateNotifications({ reminders: [{ ...rule(), hostNote: '' }], followUps: [] }),
  ).toThrow(z.ZodError)
  expect(() =>
    copy.validateNotifications({ reminders: [], followUps: [{ ...rule('f'), unexpected: true }] }),
  ).toThrow(z.ZodError)
  expect(copy.validateNotifications(settings(), { followUpHostNotesEnabled: false })).toEqual(
    settings(),
  )
}

function verifyStoredHostNotes(
  copy: Pick<
    SettingsModule,
    'parseNotifications' | 'createNotificationSnapshot' | 'notificationSnapshot'
  >,
) {
  const legacy = {
    reminders: [],
    followUps: [{ ...rule('f'), hostNote: 'Stored\ttext\r\nPreserved\rtoo' }],
  }
  expect(() => copy.parseNotifications(legacy)).not.toThrow()
  expect(copy.parseNotifications(legacy)).toEqual(legacy)
  expect(() => copy.createNotificationSnapshot(legacy)).not.toThrow()
  const snapshot = copy.createNotificationSnapshot(legacy)
  expect(snapshot.notifications).toEqual(legacy)
  expect(copy.notificationSnapshot(snapshot)).toEqual(snapshot)
}

describe('notification settings contract', () => {
  it('excludes follow-up notes from reminder rules structurally at the type level', () => {
    expectTypeOf<FollowUpRule>().not.toMatchTypeOf<ReminderRule>()
    expectTypeOf<{
      id: string
      offsetMinutes: number
      recipients: FollowUpRule['recipients']
      hostNote: string
    }>().not.toMatchTypeOf<ReminderRule>()
  })

  it('preserves historical tab and CRLF notes when parsing stored settings and immutable snapshots', () => {
    verifyStoredHostNotes({ parseNotifications, createNotificationSnapshot, notificationSnapshot })
    verifyStoredHostNotes(sourceCopy())
  })

  it.each<Replacement>([
    [
      'return checkedNotifications(value, {}, true)',
      'return checkedNotifications(value, {}, false)',
    ],
    [
      'const notifications = parseNotifications(value)',
      'const notifications = validateNotifications(value)',
    ],
  ])('detects revalidating historical notes on read with a real assertion failure', (from, to) => {
    expect(() => verifyStoredHostNotes(sourceCopy([from, to]))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })

  it('stores optional plain-text follow-up notes with bounded well-formed Unicode, rejects notes on reminders', () => {
    verifyHostNotes({
      validateNotifications,
      createNotificationSnapshot,
      notificationSnapshot,
      isLegacyDefault,
      parseNotifications,
    })
    verifyHostNotes(sourceCopy())
    expect(DEFAULT_NOTIFICATIONS).toEqual({
      reminders: [
        {
          id: 'default-24h',
          offsetMinutes: 1440,
          recipients: { invitee: true, guests: true, host: true },
        },
      ],
      followUps: [],
    })
  })

  it.each<[string, Replacement]>([
    ['host note length bound', ['note.length > FOLLOW_UP_HOST_NOTE_MAX_LENGTH', 'false']],
    [
      'host note control exclusion',
      ['/[' + '\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f' + ']/.test(note)', 'false'],
    ],
    ['host note Unicode validation', ['!note.isWellFormed()', 'false']],
    ['line-ending normalization', [".replace(/\\r\\n/g, '\\n')", '']],
    ['bidi control normalization', [".replace(/[\\u202a-\\u202e\\u2066-\\u2069]/g, '')", '']],
    ['operator host-note switch', ['options.followUpHostNotesEnabled === false', 'false']],
    ['follow-up-only host note', ['reminders: z.array(rule)', 'reminders: z.array(followUpRule)']],
    ['strict follow-up fields', ['const rule = z.strictObject(', 'const rule = z.object(']],
  ])('detects broken %s using host note assertions', (_, replacement) => {
    expect(() => verifyHostNotes(sourceCopy(replacement))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it.each(malformed)('rejects %s as a shape error', (_, value) => {
    expect(() => validateNotifications(value)).toThrow(z.ZodError)
  })

  it.each(invalid)('rejects %s', (label, value) => {
    const expected =
      label.includes('NaN') || label.includes('Infinity')
        ? z.ZodError
        : expect.objectContaining({ kind: 'invalid', code: 'invalid_notifications' })
    expect(() => validateNotifications(value)).toThrow(expected)
  })

  it('accepts boundary counts, bounds, cross-category offsets and case-sensitive stable identities', () => {
    const value = settings(
      [rule('A', 5), rule('a', 6), rule('r2', 7), rule('r3', 8), rule('z'.repeat(64), 43200)],
      [rule('f0', 5), rule('f1', 60), rule('f2', 43200)],
    )
    expect(validateNotifications(value).reminders).toHaveLength(5)
    expect(validateNotifications(value).followUps).toHaveLength(3)
    expect(validateNotifications(settings([]))).toEqual({ reminders: [], followUps: [] })
  })

  it('canonicalizes order without mutating input or changing logical rule identities', () => {
    verifyCanonical({
      validateNotifications,
      createNotificationSnapshot,
      notificationSnapshot,
      isLegacyDefault,
      parseNotifications,
    })
    const edited = rule('persistent-id', 120)
    expect(validateNotifications(settings([edited])).reminders[0]?.id).toBe('persistent-id')
    edited.offsetMinutes = 180
    expect(validateNotifications(settings([edited])).reminders[0]?.id).toBe('persistent-id')
  })

  it('selects the exact legacy policy independently of id spelling and materializes null snapshots', () =>
    verifyModes({
      validateNotifications,
      createNotificationSnapshot,
      notificationSnapshot,
      isLegacyDefault,
      parseNotifications,
    }))

  it('validates stored snapshot version, shape and execution mode', () => {
    const snapshot = createNotificationSnapshot(settings())
    expect(notificationSnapshot(snapshot)).toEqual(snapshot)
    for (const change of [
      { ...snapshot, version: 2 },
      { ...snapshot, executionMode: 'legacy_default' },
      { ...snapshot, unexpected: true },
      { ...snapshot, notifications: null },
    ])
      expect(() => notificationSnapshot(change)).toThrow()
  })

  it('passes the shared assertions for the unmodified source copy', () => {
    const copy = sourceCopy()
    verifySemantic(copy)
    verifyCanonical(copy)
    verifyModes(copy)
  })

  it.each<[string, Replacement]>([
    [
      'all required shape fields',
      ['const recipients = z.strictObject(', 'const recipients = z.object('],
    ],
    ['strict rule fields', ['const rule = z.strictObject(', 'const rule = z.object(']],
    [
      'strict settings fields',
      ['NotificationSettingsSchema = z.strictObject(', 'NotificationSettingsSchema = z.object('],
    ],
  ])('detects broken %s with a real assertion failure', (_, replacement) => {
    const copy = sourceCopy(replacement)
    expect(() => {
      for (const [label, value] of malformed)
        expect(() => copy.validateNotifications(value), label).toThrow(z.ZodError)
    }).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })

  it.each<[string, Replacement]>([
    ['reminder count', ['parsed.reminders.length > 5', 'false']],
    ['follow-up count', ['parsed.followUps.length > 3', 'false']],
    ['id grammar and length', ['!/^[A-Za-z0-9_-]{1,64}$/.test(item.id)', 'false']],
    ['prototype id exclusion', ["item.id === '__proto__'", 'false']],
    ['global id uniqueness', ['ids.has(item.id)', 'false']],
    ['integer offsets', ['!Number.isInteger(item.offsetMinutes)', 'false']],
    ['minimum offsets', ['item.offsetMinutes < 5', 'false']],
    ['maximum offsets', ['item.offsetMinutes > 43200', 'false']],
    ['per-category offset uniqueness', ['offsets.has(item.offsetMinutes)', 'false']],
    ['nonempty recipient selection', ['!Object.values(item.recipients).some(Boolean)', 'false']],
  ])('detects removal of %s with a real assertion failure', (_, replacement) => {
    const copy = sourceCopy(replacement)
    expect(() => verifySemantic(copy)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })

  it.each<[string, Replacement]>([
    [
      'reminder canonical ordering',
      ['b.offsetMinutes - a.offsetMinutes', 'a.offsetMinutes - b.offsetMinutes'],
    ],
    [
      'follow-up canonical ordering',
      ['a.offsetMinutes - b.offsetMinutes', 'b.offsetMinutes - a.offsetMinutes'],
    ],
  ])('detects broken %s with a real assertion failure', (_, replacement) => {
    const copy = sourceCopy(replacement)
    expect(() => verifyCanonical(copy)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })

  it.each<[string, Replacement]>([
    ['exact default offset', ['reminder?.offsetMinutes === 1440', 'true']],
    ['follow-up exclusion from default', ['settings.followUps.length === 0', 'true']],
    ['single-rule default', ['settings.reminders.length === 1', 'settings.reminders.length > 0']],
    ['all-role default recipients', ['reminder.recipients.guests &&', 'true &&']],
    [
      'legacy null materialization',
      [
        'if (value === null) return createNotificationSnapshot(DEFAULT_NOTIFICATIONS)',
        'if (value === null) return createNotificationSnapshot({ reminders: [], followUps: [] })',
      ],
    ],
  ])('detects broken %s with a real assertion failure', (_, replacement) => {
    const copy = sourceCopy(replacement)
    expect(() => verifyModes(copy)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
})
