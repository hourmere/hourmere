import './EventEmbedAction.css'
import { embedOrigin, publicBookingPath } from '@hourmere/core/embed'
import { embedSnippet } from '@hourmere/core/embed-snippet'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, unwrap } from '../../api/client.ts'
import type { EventType } from '../../api/resources.ts'
import { CopyButton } from '../../components/CopyButton.tsx'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'

const loadInstance = (signal: AbortSignal) => unwrap(api.GET('/api/v1/instance/embed', { signal }))

export interface EventEmbedProps {
  event: EventType
  /** Only the saved, reusable public address. Never a one-time link or draft. */
  bookingPath: string | null
  disabled?: boolean
}

/** The row menu deliberately starts with one action, ready for future row actions. */
export function EventEmbedAction({
  event,
  bookingPath,
  disabled = false,
  inMenu = false,
}: EventEmbedProps & { inMenu?: boolean }) {
  const { t } = useI18n()
  const [menu, setMenu] = useState(false)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const item = useRef<HTMLButtonElement>(null)
  const container = useRef<HTMLSpanElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!menu) return
    item.current?.focus()
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
        disabled={disabled}
        aria-label={inMenu ? t('More actions for {0}', { '0': event.title }) : undefined}
        aria-haspopup={inMenu ? 'menu' : 'dialog'}
        aria-expanded={inMenu ? menu : undefined}
        aria-controls={menu ? menuId : undefined}
        onClick={() => (inMenu ? setMenu(!menu) : setOpen(true))}
        onKeyDown={(event) => {
          if (inMenu && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
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
              item.current?.focus()
            } else if (event.key === 'Tab') {
              setMenu(false)
              trigger.current?.focus()
            }
          }}
        >
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
        </span>
      )}
      {open && !disabled && (
        <EventEmbedDialog event={event} bookingPath={bookingPath} onClose={close} />
      )}
    </span>
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
