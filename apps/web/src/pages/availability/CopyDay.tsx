import { useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '../../i18n/runtime.tsx'
import { WEEKDAYS, type Weekday } from './weekly-hours.ts'

export function CopyDay({
  source,
  onCopy,
}: {
  source: Weekday
  onCopy: (targets: Weekday[]) => void
}) {
  const { t, ui } = useI18n()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const label = WEEKDAYS.find((d) => d.day === source)?.label ?? source
  return (
    <>
      <button
        ref={button}
        type="button"
        className="button button-small weekday-copy"
        aria-label={`${t('Copy to…')} ${t('Copy hours from {0}', { '0': ui(label) })}`}
        onClick={() => setOpen(true)}
      >
        {t('Copy to…')}
      </button>
      {open && (
        <CopyDialog
          source={source}
          onClose={() => {
            setOpen(false)
            button.current?.focus()
          }}
          onCopy={onCopy}
        />
      )}
    </>
  )
}
function CopyDialog({
  source,
  onClose,
  onCopy,
}: {
  source: Weekday
  onClose: () => void
  onCopy: (targets: Weekday[]) => void
}) {
  const { t, ui } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const description = useId()
  const [selected, setSelected] = useState<Weekday[]>([])
  const days = WEEKDAYS.filter((d) => d.day !== source)
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    element.querySelector('button')?.focus()
  }, [])
  function close() {
    if (typeof dialog.current?.close === 'function') dialog.current.close()
    onClose()
  }
  return (
    <dialog
      ref={dialog}
      className="one-time-link-dialog"
      aria-modal="true"
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          close()
        }
        if (e.key !== 'Tab') return
        const controls = dialog.current?.querySelectorAll<HTMLElement>(
          'input, button:not(:disabled)',
        )
        const first = controls?.[0]
        const last = controls?.[controls.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }}
    >
      <h2 id={title}>
        {t('Copy hours from {0}', {
          '0': ui(WEEKDAYS.find((d) => d.day === source)?.label ?? source),
        })}
      </h2>
      <p id={description}>
        {t(
          'Replace the selected days with these hours, including unavailable days. Changes are saved with Save changes.',
        )}
      </p>
      <div className="form-actions">
        <button
          type="button"
          className="button"
          onClick={() =>
            setSelected(
              days.filter((d) => d.day !== 'saturday' && d.day !== 'sunday').map((d) => d.day),
            )
          }
        >
          {t('Weekdays')}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => setSelected(days.map((d) => d.day))}
        >
          {t('All days')}
        </button>
      </div>
      {days.map(({ day, label }) => (
        <label key={day} className="checkbox">
          <input
            type="checkbox"
            checked={selected.includes(day)}
            onChange={(e) =>
              setSelected(e.target.checked ? [...selected, day] : selected.filter((d) => d !== day))
            }
          />
          {ui(label)}
        </label>
      ))}
      <div className="form-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!selected.length}
          onClick={() => {
            onCopy(selected)
            close()
          }}
        >
          {t('Apply copy')}
        </button>
        <button type="button" className="button" onClick={close}>
          {t('Cancel')}
        </button>
      </div>
    </dialog>
  )
}
