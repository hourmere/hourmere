import { localeRegistry } from '@hourmere/core/language'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '../i18n/runtime.tsx'

/** Public pages share the existing language preference without the permanent field label. */
export function PublicLanguageSwitcher() {
  const { locale, t, available, setLanguage } = useI18n()
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const menuId = useId()
  const selected = available.indexOf(locale)
  const label = t('Language: {0}', { '0': localeRegistry[locale].nativeName })

  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = localeRegistry[locale].direction
  }, [locale])

  useEffect(() => {
    if (open) items.current[selected]?.focus()
  }, [open, selected])

  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
    }
  }, [open])

  function closeMenu() {
    setOpen(false)
    trigger.current?.focus()
  }

  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      return
    }
    const index = items.current.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Tab' && event.shiftKey) {
      // Options are not tab stops, so Shift+Tab from any option returns to the trigger inside the picker.
      event.preventDefault()
      closeMenu()
      return
    }
    let next: number | undefined
    if (event.key === 'ArrowDown') next = (index + 1) % available.length
    if (event.key === 'ArrowUp') next = (index - 1 + available.length) % available.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = available.length - 1
    if (next !== undefined) {
      event.preventDefault()
      items.current[next]?.focus()
    }
  }

  return (
    <div className="public-language-switcher" ref={container}>
      <button
        type="button"
        className="button public-language-trigger"
        ref={trigger}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? closeMenu() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
          if (event.key === 'Escape' && open) {
            event.preventDefault()
            closeMenu()
          }
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" />
        </svg>
        <span lang={locale}>{localeRegistry[locale].nativeName}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div
          className="public-language-menu"
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={menuKey}
        >
          {available.map((code, index) => (
            <button
              key={code}
              type="button"
              role="menuitemradio"
              lang={code}
              aria-checked={code === locale}
              tabIndex={-1}
              ref={(element) => {
                items.current[index] = element
              }}
              onClick={() => {
                setLanguage(code)
                closeMenu()
              }}
            >
              <span>{localeRegistry[code].nativeName}</span>
              {code === locale && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
