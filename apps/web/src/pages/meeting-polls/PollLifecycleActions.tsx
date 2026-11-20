import { useEffect, useRef } from 'react'
import { useI18n } from '../../i18n/runtime.tsx'
import type { LifecycleAction, PollResults } from './poll-results-api.ts'

const ACTIONS = {
  close: {
    button: 'Close voting…',
    prompt:
      'Close voting now? Voters can no longer change their votes. You can still schedule the meeting.',
    confirm: 'Close voting',
    pending: 'Closing voting…',
  },
  cancel: {
    button: 'Cancel poll…',
    prompt: 'Cancel this poll? Voting ends and active voters receive a cancellation notice.',
    confirm: 'Cancel poll',
    pending: 'Canceling poll…',
  },
  delete: {
    button: 'Delete poll…',
    prompt: 'Permanently delete this poll and its votes? Any booking created from it is kept.',
    confirm: 'Delete poll',
    pending: 'Deleting poll…',
  },
} as const

export function PollLifecycleActions({
  status,
  confirmation,
  busy,
  disabled,
  onChoose,
  onConfirm,
}: {
  status: PollResults['poll']['status']
  confirmation: LifecycleAction | null
  busy: boolean
  disabled: boolean
  onChoose: (action: LifecycleAction | null) => void
  onConfirm: (action: LifecycleAction) => void
}) {
  const { t } = useI18n()
  const returnTo = useRef<LifecycleAction | null>(null)
  const elements = useRef<Partial<Record<LifecycleAction, HTMLButtonElement | null>>>({})
  const dismiss = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirmation) dismiss.current?.focus()
    else if (returnTo.current) {
      elements.current[returnTo.current]?.focus()
      returnTo.current = null
    }
  }, [confirmation])

  return (
    <section className="panel" aria-labelledby="meeting-poll-actions">
      <h2 id="meeting-poll-actions">{t('Poll actions')}</h2>
      {confirmation ? (
        // biome-ignore lint/a11y/useSemanticElements: this action uses buttons independently of any form
        <div
          className="confirm"
          role="group"
          aria-labelledby="meeting-poll-confirmation-prompt"
          data-testid="meeting-poll-confirmation"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) {
              event.stopPropagation()
              onChoose(null)
            }
          }}
        >
          <p id="meeting-poll-confirmation-prompt">{t(ACTIONS[confirmation].prompt)}</p>
          <div className="confirm-buttons">
            <button
              type="button"
              className="button button-small button-danger"
              disabled={busy || disabled}
              onClick={() => onConfirm(confirmation)}
            >
              {t(ACTIONS[confirmation][busy ? 'pending' : 'confirm'])}
            </button>
            <button
              ref={dismiss}
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() => onChoose(null)}
            >
              {t('Go back')}
            </button>
          </div>
        </div>
      ) : (
        <div className="form-actions">
          {(['close', 'cancel', 'delete'] as const)
            .filter(
              (action) =>
                action === 'delete' ||
                (action === 'close' && status === 'open') ||
                (action === 'cancel' && (status === 'open' || status === 'closed')),
            )
            .map((action) => (
              <button
                key={action}
                type="button"
                className="button button-small"
                disabled={busy || disabled}
                ref={(element) => {
                  elements.current[action] = element
                }}
                onClick={() => {
                  returnTo.current = action
                  onChoose(action)
                }}
              >
                {t(ACTIONS[action].button)}
              </button>
            ))}
        </div>
      )}
    </section>
  )
}
