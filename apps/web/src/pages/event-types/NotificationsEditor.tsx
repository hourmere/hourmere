import { useEffect, useRef, useState } from 'react'
import { describedBy, Field, FieldError, type FieldErrors } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { msg, type UiText } from '../../i18n/translate.ts'
import {
  NOTIFICATION_LIMITS,
  type NotificationCategory,
  type NotificationRuleDraft,
  type NotificationsDraft,
  newNotificationRule,
  notificationField,
} from './notifications-form.ts'

const PRESETS = {
  reminders: [
    { minutes: 1440, label: '24 hours before' },
    { minutes: 120, label: '2 hours before' },
    { minutes: 30, label: '30 minutes before' },
  ],
  followUps: [
    { minutes: 60, label: '1 hour after' },
    { minutes: 1440, label: '1 day after' },
  ],
} as const

/** Rules retain their identities while timing, recipients and notes are edited. */
export function NotificationsEditor({
  notifications,
  errors,
  hostNotesEnabled,
  onChange,
}: {
  notifications: NotificationsDraft
  errors: FieldErrors
  hostNotesEnabled: boolean
  onChange: (notifications: NotificationsDraft) => void
}) {
  const { t, uiText } = useI18n()
  const [focus, setFocus] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState<UiText>('')
  const announcementTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hasSavedNotes = notifications.followUps.some((rule) => Boolean(rule.hostNote))

  useEffect(() => () => clearTimeout(announcementTimer.current), [])
  useEffect(() => {
    if (focus === null) return
    document.getElementById(focus)?.focus()
    setFocus(null)
  }, [focus])

  function announce(message: UiText) {
    clearTimeout(announcementTimer.current)
    setAnnouncement('')
    announcementTimer.current = setTimeout(() => setAnnouncement(message), 0)
  }

  function update(
    category: NotificationCategory,
    id: string,
    change: Partial<NotificationRuleDraft>,
  ) {
    onChange({
      ...notifications,
      [category]: notifications[category].map((rule) =>
        rule.id === id ? { ...rule, ...change } : rule,
      ),
    })
  }

  function add(category: NotificationCategory) {
    const rules = notifications[category]
    if (rules.length >= NOTIFICATION_LIMITS[category]) return
    const offsets = new Set(rules.map((rule) => Number(rule.offsetMinutes)))
    let offset: number | undefined = PRESETS[category].find(
      (preset) => !offsets.has(preset.minutes),
    )?.minutes
    if (offset === undefined) {
      offset = NOTIFICATION_LIMITS.minOffset
      while (offsets.has(offset)) offset++
    }
    const rule = newNotificationRule(offset)
    onChange({ ...notifications, [category]: [...rules, rule] })
    setFocus(notificationField(category, rule, 'offsetMinutes'))
    announce(
      msg(category === 'reminders' ? 'Added reminder {number}.' : 'Added follow-up {number}.', {
        number: rules.length + 1,
      }),
    )
  }

  function remove(category: NotificationCategory, index: number) {
    const rest = notifications[category].filter((_, i) => i !== index)
    onChange({ ...notifications, [category]: rest })
    const next = rest[index] ?? rest[index - 1]
    setFocus(next ? notificationField(category, next, 'offsetMinutes') : `add-${category}`)
    announce(
      msg(category === 'reminders' ? 'Removed reminder {number}.' : 'Removed follow-up {number}.', {
        number: index + 1,
      }),
    )
  }

  return (
    <section
      id="notifications"
      className="panel notifications-editor"
      tabIndex={-1}
      aria-labelledby="notifications-heading"
      aria-invalid={errors.notifications ? true : undefined}
      aria-describedby={describedBy(
        'notifications-rules',
        errors.notifications && 'notifications-error',
      )}
    >
      <h2 id="notifications-heading">{t('Reminders and follow-ups')}</h2>
      <div id="notifications-rules" className="notification-guidance hint">
        <p>
          {t(
            'Changes apply to new bookings only. Existing bookings and their reschedules keep their saved settings.',
          )}
        </p>
        <p>
          {t(
            'Sent only if the send time is more than 1 hour after the booking or reschedule; otherwise skipped and not sent late.',
          )}
        </p>
        <p>
          {t(
            'Follow-ups use the scheduled meeting end, regardless of attendance. Declining a calendar invitation does not cancel them.',
          )}
        </p>
        <p>
          {t(
            'Cancel in Hourmere before the meeting starts. Invitees cannot stop follow-ups after the start.',
          )}
        </p>
        <p>{t('Email limits or delivery problems can prevent a message from being sent.')}</p>
      </div>
      {errors.notifications && (
        <FieldError id="notifications-error">{errors.notifications}</FieldError>
      )}
      {!hostNotesEnabled && (
        <p className="hint">
          {t(
            hasSavedNotes
              ? 'Host notes are disabled on this instance. Remove saved notes before changing reminders or follow-ups.'
              : 'Host notes are unavailable because the instance operator has disabled them.',
          )}
        </p>
      )}
      {(['reminders', 'followUps'] as const).map((category) => {
        const listId = `notifications.${category}`
        const listError = errors[listId]
        return (
          <fieldset
            key={category}
            id={listId}
            className="notification-category"
            tabIndex={-1}
            aria-invalid={listError ? true : undefined}
            aria-describedby={describedBy(`${listId}-hint`, listError && `${listId}-error`)}
          >
            <legend>
              <h3>
                {t(category === 'reminders' ? 'Pre-meeting reminders' : 'Post-meeting follow-ups')}
              </h3>
            </legend>
            <p id={`${listId}-hint`} className="hint">
              {t('Up to {count} messages. Choose at least one recipient for each message.', {
                count: NOTIFICATION_LIMITS[category],
              })}
            </p>
            {listError && <FieldError id={`${listId}-error`}>{listError}</FieldError>}
            {notifications[category].length === 0 ? (
              <p className="muted">
                {t(category === 'reminders' ? 'No reminders.' : 'No follow-ups.')}
              </p>
            ) : (
              <ol className="notification-list">
                {notifications[category].map((rule, index) => (
                  <li key={rule.id}>
                    <NotificationRule
                      category={category}
                      rule={rule}
                      number={index + 1}
                      errors={errors}
                      hostNotesEnabled={hostNotesEnabled}
                      onUpdate={(change) => update(category, rule.id, change)}
                      onCustomTiming={() =>
                        announce(
                          msg(
                            category === 'reminders'
                              ? 'Custom timing selected for reminder {number}. Enter minutes before the meeting in the next field.'
                              : 'Custom timing selected for follow-up {number}. Enter minutes after the meeting in the next field.',
                            { number: index + 1 },
                          ),
                        )
                      }
                      onRemove={() => remove(category, index)}
                      onRemoveNote={() => {
                        update(category, rule.id, { hostNote: '' })
                        setFocus(notificationField(category, rule, 'hostNote'))
                        announce(
                          msg('Removed the saved host note from follow-up {number}.', {
                            number: index + 1,
                          }),
                        )
                      }}
                    />
                  </li>
                ))}
              </ol>
            )}
            <button
              id={`add-${category}`}
              type="button"
              className="button button-small"
              disabled={notifications[category].length >= NOTIFICATION_LIMITS[category]}
              onClick={() => add(category)}
            >
              {t(category === 'reminders' ? 'Add reminder' : 'Add follow-up')}
            </button>
          </fieldset>
        )
      })}
      <p className="visually-hidden" role="status" aria-atomic="true">
        {uiText(announcement)}
      </p>
    </section>
  )
}

function NotificationRule({
  category,
  rule,
  number,
  errors,
  hostNotesEnabled,
  onUpdate,
  onCustomTiming,
  onRemove,
  onRemoveNote,
}: {
  category: NotificationCategory
  rule: NotificationRuleDraft
  number: number
  errors: FieldErrors
  hostNotesEnabled: boolean
  onUpdate: (change: Partial<NotificationRuleDraft>) => void
  onCustomTiming: () => void
  onRemove: () => void
  onRemoveNote: () => void
}) {
  const { t, ui } = useI18n()
  const [customTiming, setCustomTiming] = useState(false)
  const field = (part: 'offsetMinutes' | 'recipients' | 'hostNote' | 'id') =>
    notificationField(category, rule, part)
  const id = field('id')
  const recipientId = field('recipients')
  const noteId = field('hostNote')
  const presetId = `${id}-preset`
  const preset = PRESETS[category].find((value) => String(value.minutes) === rule.offsetMinutes)

  return (
    <fieldset
      id={id}
      className="notification-card"
      tabIndex={-1}
      aria-invalid={errors[id] ? true : undefined}
      aria-describedby={errors[id] ? `${id}-error` : undefined}
    >
      <legend>
        {t(category === 'reminders' ? 'Reminder {number}' : 'Follow-up {number}', { number })}
      </legend>
      {errors[id] && <FieldError id={`${id}-error`}>{errors[id]}</FieldError>}
      <div className="notification-timing">
        <Field id={presetId} label={t('Timing preset')}>
          {(props) => (
            <select
              {...props}
              value={!customTiming && preset ? String(preset.minutes) : ''}
              onChange={(event) => {
                setCustomTiming(event.target.value === '')
                if (event.target.value) onUpdate({ offsetMinutes: event.target.value })
                else onCustomTiming()
              }}
            >
              <option value="">{t('Custom timing')}</option>
              {PRESETS[category].map((value) => (
                <option key={value.minutes} value={value.minutes}>
                  {ui(value.label)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id={field('offsetMinutes')}
          label={t(
            category === 'reminders' ? 'Minutes before the meeting' : 'Minutes after the meeting',
          )}
          hint={t('Use 5–43,200 whole minutes, up to 30 days.')}
          error={errors[field('offsetMinutes')]}
        >
          {(props) => (
            <input
              {...props}
              inputMode="numeric"
              value={rule.offsetMinutes}
              onChange={(event) => {
                setCustomTiming(true)
                onUpdate({ offsetMinutes: event.target.value })
              }}
            />
          )}
        </Field>
      </div>
      <fieldset
        id={recipientId}
        className="notification-recipients"
        tabIndex={-1}
        aria-invalid={errors[recipientId] ? true : undefined}
        aria-describedby={errors[recipientId] ? `${recipientId}-error` : undefined}
      >
        <legend>{t('Recipients')}</legend>
        {errors[recipientId] && (
          <FieldError id={`${recipientId}-error`}>{errors[recipientId]}</FieldError>
        )}
        <div>
          {(['invitee', 'guests', 'host'] as const).map((role) => (
            <label key={role} className="checkbox">
              <input
                type="checkbox"
                checked={rule.recipients[role]}
                onChange={(event) =>
                  onUpdate({ recipients: { ...rule.recipients, [role]: event.target.checked } })
                }
              />
              {t(role === 'invitee' ? 'Invitee' : role === 'guests' ? 'Guests' : 'Host')}
            </label>
          ))}
        </div>
      </fieldset>
      {category === 'followUps' &&
        (hostNotesEnabled ? (
          <Field
            id={noteId}
            label={t('Host note (optional)')}
            hint={t('Plain text only. Line breaks are allowed. Placeholders are sent as written.')}
            error={errors[noteId]}
          >
            {(props) => (
              <>
                <textarea
                  {...props}
                  aria-describedby={describedBy(props['aria-describedby'], `${noteId}-count`)}
                  value={rule.hostNote ?? ''}
                  onChange={(event) => onUpdate({ hostNote: event.target.value })}
                />
                <p id={`${noteId}-count`} className="hint notification-note-count">
                  {t('{count} / {limit} characters', {
                    count: (rule.hostNote ?? '').length,
                    limit: NOTIFICATION_LIMITS.hostNoteMaxLength,
                  })}
                </p>
              </>
            )}
          </Field>
        ) : (
          <fieldset
            id={noteId}
            className="notification-note-disabled"
            tabIndex={-1}
            aria-invalid={errors[noteId] ? true : undefined}
            aria-describedby={describedBy(`${noteId}-hint`, errors[noteId] && `${noteId}-error`)}
          >
            <legend>{t('Host note (optional)')}</legend>
            <p id={`${noteId}-hint`} className="hint">
              {t(
                rule.hostNote
                  ? 'A saved host note is kept until you remove it. Notes will not be sent while this feature is disabled.'
                  : 'Host notes are unavailable because the instance operator has disabled them.',
              )}
            </p>
            {errors[noteId] && <FieldError id={`${noteId}-error`}>{errors[noteId]}</FieldError>}
            {rule.hostNote && (
              <button type="button" className="button button-small" onClick={onRemoveNote}>
                {t('Remove saved host note')}
              </button>
            )}
          </fieldset>
        ))}
      <button
        type="button"
        className="button button-small"
        aria-label={t(
          category === 'reminders' ? 'Remove reminder {number}' : 'Remove follow-up {number}',
          { number },
        )}
        onClick={onRemove}
      >
        {t(category === 'reminders' ? 'Remove reminder' : 'Remove follow-up')}
      </button>
    </fieldset>
  )
}
