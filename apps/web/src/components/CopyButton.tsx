import { useEffect, useState } from 'react'

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Copies `text` to the clipboard and says so. Clipboard access needs a secure context
 * (https or localhost); where it is refused, people can still select the text themselves.
 */
export function CopyButton({
  text,
  label = 'Copy',
  accessibleLabel,
}: {
  text: string
  label?: string
  /** A fuller name for screen readers, e.g. when a list has several copy buttons. */
  accessibleLabel?: string
}) {
  const [state, setState] = useState<CopyState>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2500)
    return () => clearTimeout(timer)
  }, [state])

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  return (
    <span className="copy">
      <button
        type="button"
        className="button button-small"
        onClick={copy}
        {...(accessibleLabel && { 'aria-label': accessibleLabel })}
      >
        {label}
      </button>
      <span className="copy-status" role="status">
        {state === 'copied' && 'Copied'}
        {state === 'failed' && 'Could not copy; select the text and copy it yourself'}
      </span>
    </span>
  )
}
