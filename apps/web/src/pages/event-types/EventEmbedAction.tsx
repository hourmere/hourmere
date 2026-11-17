import './EventEmbedAction.css'
import { embedOrigin, publicBookingPath } from '@hourmere/core/embed'
import { embedSnippet } from '@hourmere/core/embed-snippet'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, unwrap } from '../../api/client.ts'
import { errorMessage } from '../../api/errors.ts'
import type { EventType } from '../../api/resources.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { UiText } from '../../i18n/translate.ts'

const loadInstance = (signal: AbortSignal) => unwrap(api.GET('/api/v1/instance/embed', { signal }))

export interface EventEmbedProps {
  event: EventType
  /** Only the saved, reusable public address. Never a one-time link or draft. */
  bookingPath: string | null
  disabled?: boolean
}

/** Saved-event actions share a keyboard-operable menu. */
export function EventEmbedAction({
  event,
  bookingPath,
  disabled = false,
  inMenu = false,
  onDuplicate,
  onDelete,
}: EventEmbedProps & {
  inMenu?: boolean
  onDuplicate?: () => Promise<void>
  onDelete?: () => Promise<void>
}) {
  const { t, uiText } = useI18n()
  const [failure, setFailure] = useState<UiText | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const initialItem = useRef<'first' | 'last'>('first')
  const [menu, setMenu] = useState(false)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const item = useRef<HTMLButtonElement>(null)
  const container = useRef<HTMLSpanElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!menu) return
    const items = container.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]')
    if (initialItem.current === 'last') items?.[items.length - 1]?.focus()
    else items?.[0]?.focus()
    const outside = (event: Event) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setMenu(false)
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
    }
  }, [menu])

  async function duplicate() {
    if (!onDuplicate) return
    setMenu(false)
    setBusy(true)
    setFailure(null)
    try {
      await onDuplicate()
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
      trigger.current?.focus()
    }
  }

  function close() {
    setOpen(false)
    trigger.current?.focus()
  }

  return (
    <span className="event-embed-action" ref={container}>
      <button
        ref={trigger}
        type="button"
        className={`button button-small${inMenu ? ' event-more-trigger' : ''}`}
        disabled={disabled || busy}
        aria-label={inMenu ? t('More actions for {0}', { '0': event.title }) : undefined}
        aria-haspopup={inMenu ? 'menu' : 'dialog'}
        aria-expanded={inMenu ? menu : undefined}
        aria-controls={menu ? menuId : undefined}
        onClick={() => {
          initialItem.current = 'first'
          inMenu ? setMenu(!menu) : setOpen(true)
        }}
        onKeyDown={(event) => {
          if (inMenu && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            initialItem.current = event.key === 'ArrowUp' ? 'last' : 'first'
            setMenu(true)
          }
        }}
      >
        {inMenu ? <span aria-hidden="true">…</span> : t('Embed')}
      </button>
      {menu && (
        <span
          id={menuId}
          className="event-actions-menu"
          role="menu"
          aria-label={t('More actions for {0}', { '0': event.title })}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setMenu(false)
              trigger.current?.focus()
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const items = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]'),
              )
              const index = items.indexOf(document.activeElement as HTMLButtonElement)
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
              items[next]?.focus()
            } else if (event.key === 'Tab') {
              setMenu(false)
              trigger.current?.focus()
            }
          }}
        >
          {onDuplicate && (
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => void duplicate()}>
              {t('Duplicate')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            ref={item}
            tabIndex={-1}
            onClick={() => {
              setMenu(false)
              setOpen(true)
            }}
          >
            {t('Embed')}
          </button>
          {onDelete && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setMenu(false)
                setDeleting(true)
              }}
            >
              {t('Delete')}
            </button>
          )}
        </span>
      )}
      {failure && <span role="alert">{uiText(failure)}</span>}
      {deleting && onDelete && (
        <DeleteEventDialog
          event={event}
          onConfirm={onDelete}
          onClose={() => {
            setDeleting(false)
            trigger.current?.focus()
          }}
        />
      )}
      {open && !disabled && (
        <EventEmbedDialog event={event} bookingPath={bookingPath} onClose={close} />
      )}
    </span>
  )
}

function DeleteEventDialog({
  event,
  onConfirm,
  onClose,
}: {
  event: EventType
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const { t, uiText } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const id = useId()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<UiText | null>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    cancel.current?.focus()
    return () => element?.close()
  }, [])
  async function confirm() {
    setBusy(true)
    setFailure(null)
    try {
      await onConfirm()
      onClose()
    } catch (error) {
      setFailure(errorMessage(error))
      setBusy(false)
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="embed-dialog"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id={id}>{t('Delete “{0}”? This cannot be undone.', { '0': event.title })}</h2>
      <button
        type="button"
        className="button button-danger"
        disabled={busy}
        onClick={() => void confirm()}
      >
        {t(busy ? 'Deleting…' : 'Delete event type')}
      </button>
      <button ref={cancel} type="button" className="button" disabled={busy} onClick={onClose}>
        {t('Cancel')}
      </button>
      {failure && (
        <p role="alert">
          {t('Could not delete the event type.')} {uiText(failure)}
        </p>
      )}
    </dialog>,
    document.body,
  )
}

function EventEmbedDialog({
  event,
  bookingPath,
  onClose,
}: EventEmbedProps & { onClose: () => void }) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()
  const [instance, retry] = useLoad(loadInstance)
  const [mode, setMode] = useState<'inline' | 'popup'>('inline')
  const [height, setHeight] = useState('720')
  const [buttonLabel, setButtonLabel] = useState(t('Book a meeting'))
  const origins = instance.status === 'ready' ? instance.data.embedAllowedOrigins : undefined
  let code: string | null = null
  let generationError: 'publicUrl' | 'bookingPath' | 'unexpected' | null = null
  if (event.isActive && bookingPath && instance.status === 'ready') {
    try {
      code = embedSnippet({
        publicUrl: instance.data.publicUrl,
        bookingPath,
        mode,
        height: mode === 'inline' ? Number(height) : 720,
        buttonLabel,
      })
    } catch {
      // Invalid or unavailable public instance metadata must never fall back to the admin host.
      generationError =
        typeof instance.data.publicUrl !== 'string' || !embedOrigin(instance.data.publicUrl)
          ? 'publicUrl'
          : !publicBookingPath(bookingPath)
            ? 'bookingPath'
            : 'unexpected'
    }
  }
  const invalidHeight =
    !Number.isInteger(Number(height)) || Number(height) < 240 || Number(height) > 2000
  const invalidButtonLabel = mode === 'popup' && buttonLabel.trim().length === 0
  function closeDialog() {
    dialog.current?.close()
    onClose()
  }

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  return createPortal(
    <dialog
      ref={dialog}
      className="embed-dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault()
        closeDialog()
      }}
    >
      <div className="embed-dialog-heading">
        <h2 id={`${id}-title`}>{t('Embed {0}', { '0': event.title })}</h2>
        <button type="button" className="button button-small" onClick={closeDialog}>
          {t('Close')}
        </button>
      </div>
      <p id={`${id}-description`}>
        {t('This booking link uses the saved version. Unsaved changes are not included.')}
      </p>
      {instance.status === 'loading' ? (
        <p role="status">{t('Loading instance settings…')}</p>
      ) : origins === undefined ? (
        <p role="status">
          {t(
            'Embedding configuration is unavailable. Ask the instance operator to confirm allowed website origins.',
          )}
        </p>
      ) : origins.length === 0 ? (
        <div className="alert alert-info">
          <p>
            {t(
              'Embedding is disabled. The instance operator must set EMBED_ALLOWED_ORIGINS and restart the web process. For example:',
            )}
          </p>
          <pre className="embed-config">
            <code>
              {
                'PUBLIC_URL=https://hourmere.example.com\nEMBED_ALLOWED_ORIGINS=https://www.example.com,https://blog.example.com'
              }
            </code>
          </pre>
        </div>
      ) : (
        <div>
          <p>{t('Allowed website origins')}</p>
          <ul>
            {origins.map((origin) => (
              <li className="mono user-content" key={origin}>
                {origin}
              </li>
            ))}
          </ul>
        </div>
      )}
      {instance.status === 'error' && (
        <button type="button" className="button button-small" onClick={retry}>
          {t('Try again')}
        </button>
      )}
      {!event.isActive ? (
        <p>{t('This event type is inactive. Enable it and save before generating embed code.')}</p>
      ) : !bookingPath ? (
        <p>{t('Complete the saved event setup before generating embed code.')}</p>
      ) : (
        <>
          {event.isHidden && (
            <p className="alert alert-info">
              {t(
                'This event type is unlisted. The embed still works; anyone with the code or direct link can book it.',
              )}
            </p>
          )}
          <div className="field">
            <label htmlFor={`${id}-mode`}>{t('Embed mode')}</label>
            <select
              id={`${id}-mode`}
              value={mode}
              onChange={(e) => setMode(e.target.value as 'inline' | 'popup')}
            >
              <option value="inline">{t('Inline')}</option>
              <option value="popup">{t('Popup button')}</option>
            </select>
          </div>
          {mode === 'inline' ? (
            <div className="field">
              <label htmlFor={`${id}-height`}>{t('Initial height (pixels)')}</label>
              <input
                id={`${id}-height`}
                type="number"
                min={240}
                max={2000}
                step={1}
                value={height}
                aria-invalid={invalidHeight || undefined}
                aria-describedby={`${id}-height-hint`}
                onChange={(e) => setHeight(e.target.value)}
              />
              <p id={`${id}-height-hint`}>
                {t('Use a whole number from 240 to 2000. The widget resizes automatically.')}
              </p>
            </div>
          ) : (
            <div className="field">
              <label htmlFor={`${id}-button`}>{t('Button text')}</label>
              <input
                id={`${id}-button`}
                value={buttonLabel}
                maxLength={200}
                aria-invalid={invalidButtonLabel || undefined}
                aria-describedby={invalidButtonLabel ? `${id}-button-error` : undefined}
                onChange={(e) => setButtonLabel(e.target.value)}
              />
              {invalidButtonLabel && (
                <p id={`${id}-button-error`} className="field-error">
                  {t('Enter button text so visitors can identify the button.')}
                </p>
              )}
            </div>
          )}
          {code !== null ? (
            <div className="field">
              <label htmlFor={`${id}-code`}>{t('Embed code')}</label>
              <textarea
                id={`${id}-code`}
                className="mono"
                readOnly
                rows={6}
                value={code}
                spellCheck={false}
              />
              <CopyButton key={code} text={code} label={t('Copy embed code')} />
            </div>
          ) : generationError && !(mode === 'inline' && invalidHeight) && !invalidButtonLabel ? (
            <p>
              {t(
                generationError === 'publicUrl'
                  ? 'The instance public URL is unavailable for embedding. Ask the instance operator to check PUBLIC_URL.'
                  : generationError === 'bookingPath'
                    ? 'This saved booking address cannot be embedded. Use a saved personal or team booking link.'
                    : 'Could not generate embed code. Check the embed settings and try again.',
              )}
            </p>
          ) : null}
        </>
      )}
    </dialog>,
    document.body,
  )
}
