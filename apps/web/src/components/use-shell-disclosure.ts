import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'

export function useShellDisclosure() {
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  function closeAndRestoreFocus() {
    setOpen(false)
    trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    function closeOutside(event: Event) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('focusin', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('focusin', closeOutside)
    }
  }, [open])

  return {
    open,
    panelId,
    closeAndRestoreFocus,
    triggerProps: {
      ref: trigger,
      'aria-controls': panelId,
      'aria-expanded': open,
      onClick: () => setOpen(!open),
    },
    containerProps: {
      ref: container,
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (open && event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          closeAndRestoreFocus()
        }
      },
    },
  }
}
