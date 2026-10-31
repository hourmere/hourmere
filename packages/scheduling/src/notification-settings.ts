import { FOLLOW_UP_HOST_NOTE_MAX_LENGTH } from '@hourmere/core/follow-up-note'
import { z } from 'zod'
import { DomainError } from './errors.ts'

const recipients = z.strictObject({ invitee: z.boolean(), guests: z.boolean(), host: z.boolean() })
const rule = z.strictObject({ id: z.string(), offsetMinutes: z.number(), recipients })
const followUpRule = rule.extend({ hostNote: z.string().optional() })

/** Shape errors map to invalid_request; semantic errors are checked by the service. */
export const NotificationSettingsSchema = z.strictObject({
  reminders: z.array(rule),
  followUps: z.array(followUpRule),
})
export type ReminderRule = z.infer<typeof rule> & { hostNote?: never }
export type FollowUpRule = z.infer<typeof followUpRule>
export interface NotificationSettings {
  reminders: ReminderRule[]
  followUps: FollowUpRule[]
}
export type NotificationRule = ReminderRule | FollowUpRule
export interface NotificationSnapshot {
  version: 1
  executionMode: 'legacy_default' | 'configurable'
  notifications: NotificationSettings
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  reminders: [
    {
      id: 'default-24h',
      offsetMinutes: 1440,
      recipients: { invitee: true, guests: true, host: true },
    },
  ],
  followUps: [],
}

/** Return a fresh canonical value; never derive a rule identity from its time or position. */
export function validateNotifications(
  value: unknown,
  options: { followUpHostNotesEnabled?: boolean | undefined } = {},
): NotificationSettings {
  return checkedNotifications(value, options, false)
}

/** Stored values keep the original envelope; tighter write rules do not rewrite booking history. */
export function parseNotifications(value: unknown): NotificationSettings {
  return checkedNotifications(value, {}, true)
}

function checkedNotifications(
  value: unknown,
  options: { followUpHostNotesEnabled?: boolean | undefined },
  stored: boolean,
): NotificationSettings {
  const parsed = NotificationSettingsSchema.parse(value)
  const invalid = () => new DomainError('invalid', 'invalid_notifications')
  if (parsed.reminders.length > 5 || parsed.followUps.length > 3) throw invalid()
  const ids = new Set<string>()
  for (const rules of [parsed.reminders, parsed.followUps]) {
    const offsets = new Set<number>()
    for (const item of rules) {
      if (
        !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) ||
        item.id === '__proto__' ||
        ids.has(item.id) ||
        !Number.isInteger(item.offsetMinutes) ||
        item.offsetMinutes < 5 ||
        item.offsetMinutes > 43200 ||
        offsets.has(item.offsetMinutes) ||
        !Object.values(item.recipients).some(Boolean)
      )
        throw invalid()
      ids.add(item.id)
      offsets.add(item.offsetMinutes)
    }
  }
  for (const followUp of parsed.followUps) {
    if (followUp.hostNote === undefined) continue
    if (stored) {
      if (
        followUp.hostNote.length > FOLLOW_UP_HOST_NOTE_MAX_LENGTH ||
        !followUp.hostNote.isWellFormed() ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: original stored-note envelope
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(
          followUp.hostNote,
        )
      )
        throw invalid()
      continue
    }
    if (options.followUpHostNotesEnabled === false) throw invalid()
    const note = followUp.hostNote
      .replace(/\r\n/g, '\n')
      .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    if (
      note.length > FOLLOW_UP_HOST_NOTE_MAX_LENGTH ||
      !note.isWellFormed() ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject controls except LF
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(note)
    )
      throw invalid()
    followUp.hostNote = note
  }
  parsed.reminders.sort((a, b) => b.offsetMinutes - a.offsetMinutes)
  parsed.followUps.sort((a, b) => a.offsetMinutes - b.offsetMinutes)
  return parsed
}

/** Rule ID spelling does not affect exact legacy behavior selection. */
export function isLegacyDefault(settings: NotificationSettings): boolean {
  const reminder = settings.reminders[0]
  return (
    settings.reminders.length === 1 &&
    settings.followUps.length === 0 &&
    reminder?.offsetMinutes === 1440 &&
    reminder.recipients.invitee &&
    reminder.recipients.guests &&
    reminder.recipients.host
  )
}

export function createNotificationSnapshot(value: unknown): NotificationSnapshot {
  const notifications = parseNotifications(value)
  return {
    version: 1,
    executionMode: isLegacyDefault(notifications) ? 'legacy_default' : 'configurable',
    notifications,
  }
}

/** NULL is an immutable legacy default, never a request to inherit live event settings. */
export function notificationSnapshot(value: unknown): NotificationSnapshot {
  if (value === null) return createNotificationSnapshot(DEFAULT_NOTIFICATIONS)
  const parsed = z
    .strictObject({
      version: z.literal(1),
      executionMode: z.enum(['legacy_default', 'configurable']),
      notifications: NotificationSettingsSchema,
    })
    .parse(value)
  const snapshot = createNotificationSnapshot(parsed.notifications)
  if (snapshot.executionMode !== parsed.executionMode)
    throw new Error('Invalid notification snapshot')
  return snapshot
}
