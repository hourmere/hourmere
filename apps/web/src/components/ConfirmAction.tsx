import { useEffect, useId, useRef, useState } from 'react'
import { errorMessage } from '../api/errors.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'

/**
 * A destructive action that asks for confirmation in place: the button turns into the
 * question with confirm and cancel buttons (as on the API keys page). Focus follows: to
 * Cancel when asked, back to the button when cancelled. Escape cancels.
 */
export function ConfirmAction({
  label,
  accessibleLabel,
  prompt,
  confirmLabel,
  busyLabel,
  failure,
  onConfirm,
  className = '',
}: {
  /** The button's text. */
  label: string
  /** A fuller name for screen readers when the text alone is ambiguous in a list. */
  accessibleLabel?: string
  prompt: string
  confirmLabel: string
  busyLabel: string
  /** Starts the error message, e.g. "Could not delete the event type." */
  failure: string
  /** Does it; throws to show an error. The component may be gone when it resolves. */
  onConfirm: () => Promise<void>
  className?: string
}) {
  const { t, ui } = useI18n()

  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiText | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const start = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  const promptId = useId()
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (confirming) cancel.current?.focus()
    else if (wasConfirming.current) start.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      if (!mounted.current) return
      setError(errorMessage(err))
    }
    if (mounted.current) setBusy(false)
  }

  if (!confirming) {
    return (
      <button
        ref={start}
        type="button"
        className={`button button-small ${className}`.trim()}
        onClick={() => setConfirming(true)}
        {...(accessibleLabel && { 'aria-label': ui(accessibleLabel) })}
      >
        {ui(label)}
      </button>
    )
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring form styling for two buttons
    <div
      className="confirm"
      role="group"
      aria-labelledby={promptId}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation()
          setConfirming(false)
        }
      }}
    >
      <p id={promptId}>{ui(prompt)}</p>
      <div className="confirm-buttons">
        <button
          type="button"
          className="button button-small button-danger"
          onClick={confirm}
          disabled={busy}
        >
          {ui(busy ? busyLabel : confirmLabel)}
        </button>
        <button
          ref={cancel}
          type="button"
          className="button button-small"
          onClick={() => setConfirming(false)}
          disabled={busy}
        >
          {t('Cancel')}
        </button>
      </div>
      {error && (
        <p className="alert alert-error" role="alert">
          {ui(failure)} {ui(error)}
        </p>
      )}
    </div>
  )
}
