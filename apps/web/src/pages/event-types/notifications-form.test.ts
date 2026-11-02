import { describe, expect, it } from 'vitest'
import { requestError } from '../../api/errors.ts'
import { eventType } from '../../test/fixtures.ts'
import {
  draftFromEventType,
  emptyDraft,
  toInput,
  toPatchInput,
  validateDraft,
} from './event-type-form.ts'
import {
  comparableNotifications,
  defaultNotificationsDraft,
  type NotificationsDraft,
  newNotificationRule,
  notificationField,
  notificationServerErrors,
  notificationsFromSettings,
  notificationsInput,
  pruneNotificationErrors,
  validateNotificationsDraft,
} from './notifications-form.ts'

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Expected a fixture value')
  return value
}

const draft = (): NotificationsDraft => ({ reminders: [], followUps: [] })

describe('notification form values and server field mapping', () => {
  it('separates field parts from every valid saved rule id', () => {
    const first = { ...newNotificationRule(60), id: 'x' }
    const second = { ...newNotificationRule(30), id: 'x-offsetMinutes' }
    const ids = [first, second].flatMap((rule) =>
      (['id', 'offsetMinutes', 'recipients', 'hostNote'] as const).map((part) =>
        notificationField('reminders', rule, part),
      ),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('prunes removed rule and stale list errors while retaining surviving and unrelated field errors', () => {
    const removed = newNotificationRule(60)
    const survivor = newNotificationRule(30)
    const removedField = notificationField('reminders', removed, 'offsetMinutes')
    const survivorField = notificationField('reminders', survivor, 'recipients')
    const errors = {
      [removedField]: 'Enter a whole number.',
      [survivorField]: 'Choose at least one recipient.',
      notifications: 'Check the form and try again.',
      'notifications.reminders': 'Check the form and try again.',
      title: 'Enter a title.',
    }
    expect(pruneNotificationErrors(errors, { reminders: [survivor], followUps: [] })).toEqual({
      [survivorField]: 'Choose at least one recipient.',
      title: 'Enter a title.',
    })
    expect(errors).toHaveProperty(removedField)
  })
  it('allocates unique identities independently of offsets, edits and positions', () => {
    const first = newNotificationRule(60)
    const second = newNotificationRule(60)
    expect(first.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(first.id).not.toBe(second.id)
    const state = { reminders: [first, second], followUps: [] }
    const field = notificationField('reminders', second, 'offsetMinutes')
    state.reminders.shift()
    second.offsetMinutes = '90'
    expect(notificationField('reminders', second, 'offsetMinutes')).toBe(field)
    expect(notificationsInput({ reminders: [second], followUps: [] }).reminders[0]?.id).toBe(
      second.id,
    )
  })

  it('copies stored rule ids, recipients and notes without mutating the saved settings', () => {
    const saved = eventType().notifications
    saved.followUps.push({
      id: 'note',
      offsetMinutes: 60,
      recipients: { invitee: true, guests: false, host: false },
      hostNote: 'Original\n🙂',
    })
    const values = notificationsFromSettings(saved)
    expect(notificationsInput(values)).toEqual(saved)
    required(values.reminders[0]).offsetMinutes = '30'
    required(values.reminders[0]).recipients.invitee = false
    required(values.followUps[0]).hostNote = 'Edited'
    expect(saved.reminders[0]?.offsetMinutes).toBe(1440)
    expect(saved.reminders[0]?.recipients.invitee).toBe(true)
    expect(saved.followUps[0]?.hostNote).toBe('Original\n🙂')
  })

  it('omits unchanged defaults on create and existing settings on metadata patches', () => {
    expect(toInput(emptyDraft())).not.toHaveProperty('notifications')
    const settings = eventType().notifications
    required(settings.reminders[0]).id = 'stored-default-identity'
    settings.followUps.push({
      id: 'saved-note',
      offsetMinutes: 60,
      recipients: { invitee: true, guests: false, host: false },
      hostNote: 'Saved note',
    })
    const baseline = draftFromEventType(eventType({ notifications: settings }))
    expect(toPatchInput({ ...baseline, title: 'Renamed' }, baseline)).not.toHaveProperty(
      'notifications',
    )
    const changed = { ...baseline, notifications: { reminders: [], followUps: [] } }
    expect(toPatchInput(changed, baseline).notifications).toEqual({ reminders: [], followUps: [] })
  })

  it('does not block metadata saves with an unchanged legacy note that is no longer writable', () => {
    const saved = eventType()
    saved.notifications.followUps.push({
      id: 'legacy-note',
      offsetMinutes: 60,
      recipients: { invitee: true, guests: false, host: false },
      hostNote: 'Old\tnote',
    })
    const baseline = draftFromEventType(saved)
    expect(validateDraft({ ...baseline, title: 'New title' }, baseline)).toEqual({})
    const changed = structuredClone(baseline)
    required(changed.notifications.followUps[0]).offsetMinutes = '120'
    expect(validateDraft(changed, baseline)).toHaveProperty(
      notificationField('followUps', required(changed.notifications.followUps[0]), 'hostNote'),
    )
  })

  it.each(['4', '43201', '5.5', '', '1e3', 'Infinity'])(
    'rejects invalid offset %s at its stable field',
    (offsetMinutes) => {
      const rule = { ...newNotificationRule(60), offsetMinutes }
      expect(validateNotificationsDraft({ reminders: [rule], followUps: [] })).toHaveProperty(
        notificationField('reminders', rule, 'offsetMinutes'),
      )
    },
  )

  it('accepts inclusive offset/count bounds and empty categories', () => {
    expect(validateNotificationsDraft(draft())).toEqual({})
    const values = {
      reminders: [5, 6, 7, 8, 43200].map(newNotificationRule),
      followUps: [5, 6, 43200].map(newNotificationRule),
    }
    expect(validateNotificationsDraft(values)).toEqual({})
    values.reminders.push(newNotificationRule(9))
    expect(validateNotificationsDraft(values)).not.toEqual({})
    values.reminders.pop()
    values.followUps.push(newNotificationRule(9))
    expect(validateNotificationsDraft(values)).not.toEqual({})
  })

  it('rejects duplicate times per category and empty recipient selection', () => {
    const first = newNotificationRule(60)
    const repeated = newNotificationRule(60)
    const values = { reminders: [first, repeated], followUps: [newNotificationRule(60)] }
    expect(validateNotificationsDraft(values)).toHaveProperty(
      notificationField('reminders', repeated, 'offsetMinutes'),
    )
    values.reminders.pop()
    expect(validateNotificationsDraft(values)).toEqual({})
    first.recipients = { invitee: false, guests: false, host: false }
    expect(validateNotificationsDraft(values)).toHaveProperty(
      notificationField('reminders', first, 'recipients'),
    )
  })

  it('normalizes notes before validating UTF-16 length without interpreting plain text', () => {
    const followUp = { ...newNotificationRule(60), hostNote: `${'🙂'.repeat(1000)}\u202e` }
    const values = { reminders: [], followUps: [followUp] }
    expect(validateNotificationsDraft(values)).toEqual({})
    expect(notificationsInput(values).followUps[0]?.hostNote).toBe('🙂'.repeat(1000))
    followUp.hostNote = 'Plain <script> {invitee}\r\nNext\u202e'
    expect(notificationsInput(values).followUps[0]?.hostNote).toBe('Plain <script> {invitee}\nNext')
    followUp.hostNote = '🙂'.repeat(1001)
    expect(validateNotificationsDraft(values)).toHaveProperty(
      notificationField('followUps', followUp, 'hostNote'),
    )
  })

  it.each(['\t', '\r', '\u0000', '\u007f', '\u009f', '\ud800'])(
    'rejects a forbidden note character %j',
    (control) => {
      const followUp = { ...newNotificationRule(60), hostNote: `Private${control}note` }
      expect(validateNotificationsDraft({ reminders: [], followUps: [followUp] })).toHaveProperty(
        notificationField('followUps', followUp, 'hostNote'),
      )
    },
  )

  it('omits absent notes and keeps stable identities in comparable values', () => {
    const values = defaultNotificationsDraft()
    expect(notificationsInput(values).reminders[0]).not.toHaveProperty('hostNote')
    const copy = structuredClone(values)
    expect(comparableNotifications(copy)).toBe(comparableNotifications(values))
    required(copy.reminders[0]).id = 'different-rule'
    expect(comparableNotifications(copy)).not.toBe(comparableNotifications(values))
  })

  it.each([
    [
      'notifications.reminders[0].offsetMinutes: must be between 5 and 43200 minutes',
      'reminders',
      'offsetMinutes',
    ],
    [
      'notifications.reminders[0].recipients: at least one recipient must be selected',
      'reminders',
      'recipients',
    ],
    [
      'notifications.followUps[0].hostNote: host notes are disabled by the operator',
      'followUps',
      'hostNote',
    ],
  ] as const)('maps field-level server constraint %s', (message, category, part) => {
    const values = { reminders: [newNotificationRule(60)], followUps: [newNotificationRule(60)] }
    const mapped = notificationServerErrors(
      requestError(400, { error: 'invalid_notifications', message }),
      values,
    )
    expect(mapped).toHaveProperty(notificationField(category, required(values[category][0]), part))
    expect(Object.keys(mapped ?? {})).toHaveLength(1)
  })

  it('keeps unrelated errors generic and gives unknown notification constraints reachable group targets', () => {
    expect(
      notificationServerErrors(
        requestError(400, {
          error: 'invalid_event_type',
          message: 'notifications.reminders[0].offsetMinutes: invalid',
        }),
        defaultNotificationsDraft(),
      ),
    ).toBeNull()
    expect(
      notificationServerErrors(
        requestError(400, { error: 'invalid_notifications', message: 'Something unexpected' }),
        defaultNotificationsDraft(),
      ),
    ).toHaveProperty('notifications')
    expect(
      notificationServerErrors(
        requestError(400, {
          error: 'invalid_notifications',
          message:
            'notifications.reminders[99].offsetMinutes: must be an integer number of minutes',
        }),
        defaultNotificationsDraft(),
      ),
    ).toHaveProperty('notifications.reminders')
  })
})
