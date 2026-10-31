import { z } from 'zod'
import { DomainError } from './errors.ts'

const recipients = z.strictObject({ invitee: z.boolean(), guests: z.boolean(), host: z.boolean() })
const rule = z.strictObject({ id: z.string(), offsetMinutes: z.number(), recipients })

/** Shape errors are Zod errors, mapped to invalid_request by a future transport. */
export const NotificationSettingsSchema = z.strictObject({
  reminders: z.array(rule),
  followUps: z.array(rule),
})
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>
export type NotificationRule = NotificationSettings['reminders'][number]
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
export function validateNotifications(value: unknown): NotificationSettings {
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
  const notifications = validateNotifications(value)
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
