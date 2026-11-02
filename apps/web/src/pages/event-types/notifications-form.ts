import { FOLLOW_UP_HOST_NOTE_MAX_LENGTH } from '@hourmere/core/follow-up-note'
import type { Schemas } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import { type FieldErrors, parseWhole, wholeNumberProblem } from '../../components/forms.tsx'
import { literal, msg, type UiText } from '../../i18n/translate.ts'
import { randomHex } from '../../random.ts'

type NotificationSettings = Schemas['EventTypeNotificationsInput']
export type NotificationCategory = 'reminders' | 'followUps'
export interface NotificationRuleDraft {
  id: string
  offsetMinutes: string
  recipients: { invitee: boolean; guests: boolean; host: boolean }
  hostNote?: string
}
export interface NotificationsDraft {
  reminders: NotificationRuleDraft[]
  followUps: NotificationRuleDraft[]
}

export const NOTIFICATION_LIMITS = {
  reminders: 5,
  followUps: 3,
  minOffset: 5,
  maxOffset: 43200,
  hostNoteMaxLength: FOLLOW_UP_HOST_NOTE_MAX_LENGTH,
} as const

/** Allocate once, independently of timing, position or translated labels. */
export function newNotificationRule(offsetMinutes: number): NotificationRuleDraft {
  return {
    id: `n_${randomHex(16)}`,
    offsetMinutes: String(offsetMinutes),
    recipients: { invitee: true, guests: true, host: true },
  }
}

export function defaultNotificationsDraft(): NotificationsDraft {
  return {
    reminders: [
      {
        id: 'default-24h',
        offsetMinutes: '1440',
        recipients: { invitee: true, guests: true, host: true },
      },
    ],
    followUps: [],
  }
}

export function notificationsFromSettings(settings: NotificationSettings): NotificationsDraft {
  const rule = (item: NotificationSettings['followUps'][number]): NotificationRuleDraft => ({
    ...item,
    offsetMinutes: String(item.offsetMinutes),
    recipients: { ...item.recipients },
  })
  return { reminders: settings.reminders.map(rule), followUps: settings.followUps.map(rule) }
}

// ':' cannot appear in a rule ID, so saved API IDs cannot collide with field suffixes.
export const notificationField = (
  category: NotificationCategory,
  rule: NotificationRuleDraft,
  part: 'offsetMinutes' | 'recipients' | 'hostNote' | 'id',
) => `notification-${category}-${rule.id}:${part}`

/** A removed row must not leave an error-summary link to a control that no longer exists. */
export function pruneNotificationErrors(
  errors: FieldErrors,
  draft: NotificationsDraft,
): FieldErrors {
  const targets = new Set<string>()
  for (const category of ['reminders', 'followUps'] as const)
    for (const rule of draft[category])
      for (const part of ['id', 'offsetMinutes', 'recipients', 'hostNote'] as const)
        targets.add(notificationField(category, rule, part))
  return Object.fromEntries(
    Object.entries(errors).filter(([id]) => {
      // A list change also makes root/count refusals stale; submit validates the new list.
      if (id === 'notifications' || id.startsWith('notifications.')) return false
      return !id.startsWith('notification-') || targets.has(id)
    }),
  )
}

/** Match write normalization without silently removing invalid text or truncating notes. */
export const normalizedHostNote = (note: string) =>
  note.replace(/\r\n/g, '\n').replace(/[\u202a-\u202e\u2066-\u2069]/g, '')

/** Keep request order so server indexes refer to the visible rows; the server sorts saves. */
export function notificationsInput(draft: NotificationsDraft): NotificationSettings {
  const rule = (item: NotificationRuleDraft) => ({
    id: item.id,
    offsetMinutes: parseWhole(item.offsetMinutes) as number,
    recipients: { ...item.recipients },
  })
  return {
    reminders: draft.reminders.map(rule),
    followUps: draft.followUps.map((item) => ({
      ...rule(item),
      ...(item.hostNote !== undefined &&
        normalizedHostNote(item.hostNote) !== '' && {
          hostNote: normalizedHostNote(item.hostNote),
        }),
    })),
  }
}

/** Array order and empty optional notes do not make a configuration change. */
export function comparableNotifications(draft: NotificationsDraft): string {
  const settings = notificationsInput(draft)
  return JSON.stringify({
    reminders: settings.reminders.sort((a, b) => a.id.localeCompare(b.id)),
    followUps: settings.followUps.sort((a, b) => a.id.localeCompare(b.id)),
  })
}

export function validateNotificationsDraft(draft: NotificationsDraft): FieldErrors {
  const errors: FieldErrors = {}
  for (const category of ['reminders', 'followUps'] as const) {
    if (draft[category].length > NOTIFICATION_LIMITS[category])
      errors[`notifications.${category}`] = msg('Add at most {count} messages to this list.', {
        count: NOTIFICATION_LIMITS[category],
      })
    const offsets = new Set<number>()
    for (const rule of draft[category]) {
      const problem = wholeNumberProblem(
        rule.offsetMinutes,
        { min: NOTIFICATION_LIMITS.minOffset, max: NOTIFICATION_LIMITS.maxOffset },
        true,
      )
      const minutes = parseWhole(rule.offsetMinutes) as number
      if (problem) errors[notificationField(category, rule, 'offsetMinutes')] = problem
      else if (offsets.has(minutes))
        errors[notificationField(category, rule, 'offsetMinutes')] =
          'Use each reminder or follow-up time only once per list.'
      offsets.add(minutes)
      if (!Object.values(rule.recipients).some(Boolean))
        errors[notificationField(category, rule, 'recipients')] = 'Choose at least one recipient.'
      if (category !== 'followUps' || rule.hostNote === undefined) continue
      const note = normalizedHostNote(rule.hostNote)
      const field = notificationField(category, rule, 'hostNote')
      if (note.length > NOTIFICATION_LIMITS.hostNoteMaxLength)
        errors[field] = msg('Use at most {0} characters (now {1}).', {
          '0': NOTIFICATION_LIMITS.hostNoteMaxLength,
          '1': note.length,
        })
      else if (!note.isWellFormed()) errors[field] = 'Use valid Unicode text.'
      // biome-ignore lint/suspicious/noControlCharactersInRegex: match the write contract
      else if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(note))
        errors[field] =
          'Use plain text with line breaks only; remove tabs and other control characters.'
    }
  }
  return errors
}

function notificationProblem(constraint: string): UiText {
  if (constraint === 'must be an integer number of minutes') return 'Enter a whole number.'
  if (constraint === 'must be between 5 and 43200 minutes')
    return msg('Enter a number from {0} to {1}.', { '0': '5', '1': '43,200' })
  if (constraint === 'must be unique within this message category')
    return 'Use each reminder or follow-up time only once per list.'
  if (constraint === 'at least one recipient must be selected')
    return 'Choose at least one recipient.'
  if (constraint === 'must contain at most 2000 UTF-16 code units')
    return msg('Use at most {0} characters.', { '0': NOTIFICATION_LIMITS.hostNoteMaxLength })
  if (constraint === 'must contain well-formed Unicode') return 'Use valid Unicode text.'
  if (constraint === 'must not contain control characters other than LF')
    return 'Use plain text with line breaks only; remove tabs and other control characters.'
  if (constraint === 'host notes are disabled by the operator')
    return 'Host notes are disabled on this instance. Remove saved notes before changing reminders or follow-ups.'
  if (constraint.startsWith('must be ') || constraint === 'must not be __proto__')
    return 'Reload the event type and try again.'
  const count = /^at most ([53]) messages are allowed$/.exec(constraint)
  if (count) return msg('Add at most {count} messages to this list.', { count: count[1] as string })
  return literal(constraint)
}

/** Both domain bracket paths and shape-validation dotted paths identify visible fields. */
export function notificationServerErrors(
  err: unknown,
  draft: NotificationsDraft,
): FieldErrors | null {
  if (
    !(err instanceof RequestError) ||
    (err.code !== 'invalid_notifications' && err.code !== 'invalid_request')
  )
    return null
  const errors: FieldErrors = {}
  for (const detail of err.message.split('; ')) {
    const match =
      /^notifications(?:\.(reminders|followUps))?(?:\[(\d+)\]|\.(\d+))?(?:\.(id|offsetMinutes|recipients|hostNote)(?:\.(?:invitee|guests|host))?)?: (.+)$/s.exec(
        detail,
      )
    if (!match) continue
    const [, category, bracketIndex, dottedIndex, part, constraint] = match
    const rules = category ? draft[category as NotificationCategory] : undefined
    const index = bracketIndex ?? dottedIndex
    const rule = index === undefined ? undefined : rules?.[Number(index)]
    const field =
      category && rule
        ? notificationField(
            category as NotificationCategory,
            rule,
            (part ?? 'id') as Parameters<typeof notificationField>[2],
          )
        : category
          ? `notifications.${category}`
          : 'notifications'
    errors[field] = notificationProblem(constraint as string)
  }
  if (Object.keys(errors).length > 0) return errors
  return err.code === 'invalid_notifications' ? { notifications: literal(err.message) } : null
}
