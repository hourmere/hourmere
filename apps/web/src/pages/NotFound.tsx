import { useEffect } from 'react'
import { Link, useLocation } from 'react-router'
import { Logo } from '../components/Logo.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { usePageTitle } from '../hooks.ts'
import { LanguageSwitcher, useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { PATHS } from '../paths.ts'
import { notifyEmbedReady } from '../public/embed-context.ts'

export function NotFoundPage() {
  const { t } = useI18n()
  const { pathname } = useLocation()
  useEffect(() => {
    if (pathname.startsWith('/embed/')) notifyEmbedReady(false)
  }, [pathname])

  usePageTitle('Page not found')
  return (
    <main className="centered">
      <div className="card">
        <header className="card-header">
          <Logo />
          <LanguageSwitcher />
        </header>
        <h1>{t('Page not found')}</h1>
        <p>{t('There is nothing at this address.')}</p>
        <p>
          <Link to={PATHS.home}>{t('Go to Hourmere')}</Link>
        </p>
      </div>
    </main>
  )
}

/** An address under /app that is no page, shown inside the app's frame. */
export function AppNotFoundPage() {
  const { t } = useI18n()

  usePageTitle('Page not found')
  return (
    <>
      <PageHeader title={t('Page not found')} lede={t('There is nothing at this address.')} />
      <p>
        <Link to={PATHS.home}>{t('Go to your event types')}</Link>
      </p>
    </>
  )
}

/** A record the page was asked for that does not exist (any more), e.g. a deleted one. */
export function MissingRecord({
  title,
  message,
  back,
}: {
  title: string
  message: UiText
  back: { to: string; label: string }
}) {
  const { ui } = useI18n()

  usePageTitle(title)
  return (
    <>
      <PageHeader title={ui(title)} lede={ui(message)} />
      <p>
        <Link to={back.to}>{ui(back.label)}</Link>
      </p>
    </>
  )
}
