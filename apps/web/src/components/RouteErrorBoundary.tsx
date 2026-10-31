import { explicitLanguage } from '@hourmere/core/language'
import { type ReactNode, useEffect } from 'react'
import { useLocation } from 'react-router'
import { reloadPage } from '../browser.ts'
import { usePageTitle } from '../hooks.ts'
import { EmbedLanguage, useI18n } from '../i18n/runtime.tsx'
import { PATHS } from '../paths.ts'
import { notifyEmbedReady } from '../public/embed-context.ts'
import { Logo } from './Logo.tsx'
import { RouteErrorScope, ScopedRouteErrorBoundary } from './route-error-scope.tsx'

function ErrorFallback() {
  const { locale, t } = useI18n()
  const { pathname } = useLocation()
  usePageTitle('Something went wrong')
  useEffect(() => {
    if (pathname.startsWith('/embed/')) notifyEmbedReady(false)
  }, [pathname])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return (
    <main className="centered">
      <div className="card" role="alert">
        <Logo />
        <h1>{t('Something went wrong')}</h1>
        <p>{t('Something went wrong with this attempt. Please try again.')}</p>
        <div className="form-actions">
          <button type="button" className="button button-primary" onClick={reloadPage}>
            {t('Reload')}
          </button>
          <a className="button" href={PATHS.home}>
            {t('Go to Hourmere')}
          </a>
        </div>
      </div>
    </main>
  )
}

/** Covers both page rendering errors and rejected route-level lazy imports. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { key, pathname, search } = useLocation()
  const query = new URLSearchParams(search)
  const language =
    pathname.startsWith('/embed/') && query.getAll('language').length === 1
      ? explicitLanguage(query.get('language'))
      : undefined
  const boundary = (
    <RouteErrorScope value={{ routeKey: key, fallback: <ErrorFallback /> }}>
      <ScopedRouteErrorBoundary>{children}</ScopedRouteErrorBoundary>
    </RouteErrorScope>
  )
  // The embed chunk can fail before its own language provider has loaded.
  return language ? (
    <EmbedLanguage key={language} language={language}>
      {boundary}
    </EmbedLanguage>
  ) : (
    boundary
  )
}
