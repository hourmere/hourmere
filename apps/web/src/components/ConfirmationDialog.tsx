import { useId, useLayoutEffect, useRef } from 'react'
import { useI18n } from '../i18n/runtime.tsx'

export function ConfirmationDialog({
  heading,
  description,
  confirmLabel,
  destructive = false,
  onCancel,
  onConfirm,
}: {
  heading: string
  description: string
  confirmLabel: string
  destructive?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useI18n()
  const headingId = useId()
  const descriptionId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    cancel.current?.focus()
    return () => element.close?.()
  }, [])

  function close(next: () => void) {
    dialog.current?.close?.()
    next()
  }

  return (
    <dialog
      ref={dialog}
      className="one-time-link-dialog"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        close(onCancel)
      }}
      onCancel={(event) => {
        event.preventDefault()
        close(onCancel)
      }}
    >
      <h2 id={headingId}>{heading}</h2>
      <p id={descriptionId}>{description}</p>
      <div className="form-actions">
        <button type="button" className="button" ref={cancel} onClick={() => close(onCancel)}>
          {t('Cancel')}
        </button>
        <button
          type="button"
          className={destructive ? 'button button-danger' : 'button button-primary'}
          onClick={() => close(onConfirm)}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  )
}
