import { useEffect, useId, useRef } from 'react'
import { CopyButton } from '../../components/CopyButton.tsx'
import { useI18n } from '../../i18n/runtime.tsx'

export function PollPublicLink({ link, onDismiss }: { link: string; onDismiss: () => void }) {
  const { t } = useI18n()
  const titleId = useId()
  const title = useRef<HTMLHeadingElement>(null)
  const disclosure = useRef<HTMLElement>(null)

  useEffect(() => {
    title.current?.focus()
  }, [])

  useEffect(() => {
    const hide = () => {
      // Hide the disclosure in any document snapshot kept for back/forward navigation.
      disclosure.current?.setAttribute('hidden', '')
    }
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) onDismiss()
    }
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', restore)
    return () => {
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', restore)
    }
  }, [onDismiss])

  return (
    <section
      ref={disclosure}
      className="panel"
      aria-labelledby={titleId}
      data-testid="meeting-poll-public-link"
    >
      <h2 ref={title} id={titleId} tabIndex={-1}>
        {t('Public voting link')}
      </h2>
      <p>{t('Copy this link now. It will only be shown here once.')}</p>
      <p className="user-content" data-private>
        {link}
      </p>
      <div className="form-actions">
        <CopyButton text={link} label="Copy voting link" />
        <button className="button" type="button" onClick={onDismiss}>
          {t('Hide voting link')}
        </button>
      </div>
    </section>
  )
}
