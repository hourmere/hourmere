import { Link } from 'react-router'
import { Logo } from '../components/Logo.tsx'
import { usePageTitle } from '../hooks.ts'
import { LanguageSwitcher, useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { PATHS } from '../paths.ts'

export function NotFoundPage() {
  const { t } = useI18n()

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
      <h1>{t('Page not found')}</h1>
      <p>{t('There is nothing at this address.')}</p>
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
      <h1>{ui(title)}</h1>
      <p>{ui(message)}</p>
      <p>
        <Link to={back.to}>{ui(back.label)}</Link>
      </p>
    </>
  )
}
