import { type ReactNode, useEffect, useRef } from 'react'
import { Logo } from '../components/Logo.tsx'
import { usePageTitle } from '../hooks.ts'
import { LanguageSwitcher, useI18n } from '../i18n/runtime.tsx'
import { useEmbedded } from './embed-context.ts'
import './public.css'

/**
 * The frame of the public pages (booking pages and invitee links): no app navigation, the
 * page itself and a small footer. These pages load nothing of the signed-in app.
 */
export function PublicLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { t } = useI18n()

  const embedded = useEmbedded()
  return (
    <div className={`public${embedded ? ' public-embedded' : ''}`}>
      <div className="public-language">
        <LanguageSwitcher />
      </div>
      <main id="main" className={`public-main${wide ? ' public-main-wide' : ''}`}>
        {children}
      </main>
      <footer className="public-footer">
        {embedded ? (
          <a href="https://hourmere.com" target="_blank" rel="noopener noreferrer">
            {t('Powered by')} <Logo size={18} />
          </a>
        ) : (
          <Logo size={18} />
        )}
      </footer>
    </div>
  )
}

/** A heading that takes focus when it appears, e.g. after a step of a flow changes. */
export function FocusHeading({
  children,
  level = 1,
  id,
  className,
}: {
  children: ReactNode
  level?: 1 | 2
  id?: string
  className?: string
}) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  const Tag = level === 1 ? 'h1' : 'h2'
  return (
    <Tag ref={ref} id={id} tabIndex={-1} className={className}>
      {children}
    </Tag>
  )
}

export function PublicStatus({ children }: { children: ReactNode }) {
  return (
    <div className="page-status" role="status">
      {children}
    </div>
  )
}

/** Unknown host or event type: say so plainly, without links into the signed-in app. */
export function PublicNotFound({ what = 'page' }: { what?: 'page' | 'event' }) {
  const { t } = useI18n()

  usePageTitle('Page not found')
  return (
    <PublicLayout>
      <div className="card public-card">
        <h1>{what === 'event' ? t('This booking page doesn’t exist') : t('Page not found')}</h1>
        <p>
          {what === 'event'
            ? t('The link may be mistyped, or the host may have removed or renamed this event.')
            : t('There is nothing at this address. Check the link you were given.')}
        </p>
      </div>
    </PublicLayout>
  )
}
