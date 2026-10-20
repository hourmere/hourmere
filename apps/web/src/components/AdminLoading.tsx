import { LanguageSwitcher, useI18n } from '../i18n/runtime.tsx'
import { Logo } from './Logo.tsx'
import { PageSkeleton } from './PageSkeleton.tsx'

/** Shell geometry is available while the session and admin route chunks load. */
export function AdminLoading() {
  const { t } = useI18n()
  return (
    <div className="app" aria-busy="true">
      <a className="skip-link" href="#main">
        {t('Skip to content')}
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/app">
            <Logo />
          </a>
          <LanguageSwitcher compact />
        </div>
      </header>
      <div className="layout">
        <div className="sidenav skeleton-nav" aria-hidden="true">
          {Array.from({ length: 9 }, (_, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative placeholders
            <div className="skeleton" key={index} />
          ))}
        </div>
        <main id="main" className="main-content" tabIndex={-1}>
          <PageSkeleton />
        </main>
      </div>
    </div>
  )
}
