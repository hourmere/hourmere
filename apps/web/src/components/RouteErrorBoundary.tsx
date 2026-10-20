import { explicitLanguage } from '@hourmere/core/language'
import type { ReactNode } from 'react'
import { useLocation } from 'react-router'
import { reloadPage } from '../browser.ts'
import { usePageTitle } from '../hooks.ts'
import { EmbedLanguage, useI18n } from '../i18n/runtime.tsx'
import { RouteErrorScope, ScopedRouteErrorBoundary } from './route-error-scope.tsx'

function ErrorFallback() {
  const { t } = useI18n()
  usePageTitle('Something went wrong')
  return (
    <main className="centered">
      <div className="card" role="alert">
        <h1>{t('Something went wrong')}</h1>
        <button type="button" className="button button-primary" onClick={reloadPage}>
          {t('Reload')}
        </button>
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
