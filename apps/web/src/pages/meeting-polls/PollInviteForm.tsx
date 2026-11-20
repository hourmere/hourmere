import { useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/runtime.tsx'
import type { InvitePollBody } from './poll-host-api.ts'

export function PollInviteForm({
  limit,
  publicAdmission,
  disabled,
  onSubmit,
  onCancel,
}: {
  limit: number
  publicAdmission: boolean
  disabled: boolean
  onSubmit: (body: InvitePollBody) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const nextId = useRef(1)
  const [focusId, setFocusId] = useState(0)
  const focusInput = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState([{ id: 0, name: '', email: '' }])

  // The first field in the opened form or newly added row receives focus after it mounts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: row count changes when a row is added
  useLayoutEffect(() => focusInput.current?.focus(), [rows.length])

  function edit(id: number, field: 'name' | 'email', value: string) {
    setRows((previous) => previous.map((row) => (row.id === id ? { ...row, [field]: value } : row)))
  }

  return (
    <form
      autoComplete="off"
      data-testid="meeting-poll-invite-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (disabled || rows.length > limit) return
        const invitees = rows.map(({ name, email }) => ({ name: name.trim(), email: email.trim() }))
        if (invitees.some(({ name, email }) => !name || !email)) return
        onSubmit({ invitees })
      }}
    >
      <fieldset className="form-fieldset stack poll-invite-fields" disabled={disabled}>
        <legend>{t('Invite voters')}</legend>
        <p className="hint">
          {t(
            'Add up to {limit} invitees per batch. If there aren’t enough places for all new voters, the entire batch is refused.',
            { limit },
          )}
          {publicAdmission && (
            <> {t('Inviting someone with a pending public sign-up uses their existing place.')}</>
          )}
        </p>
        {rows.map(({ id, name, email }, index) => (
          <fieldset className="form-fieldset poll-invite-row" key={id}>
            <legend>{t('Invitee {number}', { number: index + 1 })}</legend>
            <label className="field">
              <span>{t('Name')}</span>
              <input
                ref={focusId === id ? focusInput : undefined}
                value={name}
                onChange={(event) => edit(id, 'name', event.target.value)}
                maxLength={200}
                autoComplete="off"
                required
                data-private
              />
            </label>
            <label className="field">
              <span>{t('Email')}</span>
              <input
                type="email"
                value={email}
                onChange={(event) => edit(id, 'email', event.target.value)}
                maxLength={254}
                autoComplete="off"
                spellCheck={false}
                required
                data-private
              />
            </label>
            {rows.length > 1 && (
              <button
                type="button"
                className="button button-small"
                aria-label={t('Remove invitee {number}', { number: index + 1 })}
                onClick={() => {
                  setFocusId(rows[index - 1]?.id ?? rows[index + 1]?.id ?? 0)
                  setRows((previous) => previous.filter((row) => row.id !== id))
                }}
              >
                {t('Remove')}
              </button>
            )}
          </fieldset>
        ))}
        <div>
          <button
            type="button"
            className="button button-small"
            disabled={rows.length >= limit}
            onClick={() => {
              const id = nextId.current++
              setFocusId(id)
              setRows((previous) => [...previous, { id, name: '', email: '' }])
            }}
          >
            {t('Add another invitee')}
          </button>
        </div>
        <div className="form-actions">
          <button
            type="submit"
            className="button button-primary"
            disabled={rows.some(({ name, email }) => !name.trim() || !email.trim())}
          >
            {t('Send invitations')}
          </button>
          <button type="button" className="button" onClick={onCancel}>
            {t('Cancel')}
          </button>
        </div>
      </fieldset>
    </form>
  )
}
