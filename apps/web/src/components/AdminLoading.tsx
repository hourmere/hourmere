import { useDocumentLanguage, useI18n } from '../i18n/runtime.tsx'
import { Logo } from './Logo.tsx'
import { PageSkeleton } from './PageSkeleton.tsx'

/** Shell geometry is available while the session and admin route chunks load. */
export function AdminLoading() {
  const { locale, t } = useI18n()
  useDocumentLanguage(locale)
  return (
    <div className="app" aria-busy="true">
      <a className="skip-link" href="#main">
        {t('Skip to content')}
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/app" aria-label={t('Go to Hourmere')}>
            <Logo />
          </a>
        </div>
      </header>
      <div className="layout">
        <div className="sidebar" aria-hidden="true">
          <div className="sidebar-inner">
            <div className="sidenav skeleton-nav">
              {Array.from({ length: 9 }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative placeholders
                <div className="skeleton" key={index} />
              ))}
            </div>
            <div className="skeleton-sidebar-footer">
              <div className="skeleton" />
            </div>
          </div>
        </div>
        <main id="main" className="main-content" tabIndex={-1}>
          <PageSkeleton />
        </main>
      </div>
    </div>
  )
}
