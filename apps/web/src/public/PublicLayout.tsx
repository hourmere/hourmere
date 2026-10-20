import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.ts'
import { LegalLinks } from '../components/LegalLinks.tsx'
import { Logo } from '../components/Logo.tsx'
import { usePageTitle } from '../hooks.ts'
import { LanguageSwitcher, useI18n } from '../i18n/runtime.tsx'
import { useEmbedded } from './embed-context.ts'
import './public.css'

const HostedSignupUrl = createContext('https://hourmere.com')

/** A quiet, ordinary link: no booking details or management capability leave the page. */
export function CreateBookingLink() {
  const { t } = useI18n()
  const href = useContext(HostedSignupUrl)
  return (
    <p className="public-signup">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {t('Create your own booking link')}
      </a>
    </p>
  )
}

/**
 * The frame of the public pages (booking pages and invitee links): no app navigation, the
 * page itself and a small footer. These pages load nothing of the signed-in app.
 */
export function PublicLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { t } = useI18n()
  const [beforeBrand, afterBrand] = t('Powered by {0}').split('{0}')
  const [hostedSignupUrl, setHostedSignupUrl] = useState('https://hourmere.com')
  const [policyUrls, setPolicyUrls] = useState<{
    privacyPolicyUrl?: string
    termsUrl?: string
  }>({})
  useEffect(() => {
    const controller = new AbortController()
    api.GET('/api/v1/instance', { signal: controller.signal }).then(
      ({ data }) => {
        if (!controller.signal.aborted && data) {
          if (data.hostedSignupUrl) setHostedSignupUrl(data.hostedSignupUrl)
          setPolicyUrls({ privacyPolicyUrl: data.privacyPolicyUrl, termsUrl: data.termsUrl })
        }
      },
      () => {}, // Attribution remains usable when instance discovery is unavailable.
    )
    return () => controller.abort()
  }, [])

  const embedded = useEmbedded()
  return (
    <HostedSignupUrl value={hostedSignupUrl}>
      <div className={`public${embedded ? ' public-embedded' : ''}`}>
        <header className="public-language">
          <LanguageSwitcher />
        </header>
        <main id="main" className={`public-main user-content${wide ? ' public-main-wide' : ''}`}>
          {children}
        </main>
        <footer className="public-footer">
          <a href={hostedSignupUrl} target="_blank" rel="noopener noreferrer">
            {beforeBrand}
            <Logo size={18} />
            {afterBrand}
          </a>
          <LegalLinks {...policyUrls} />
        </footer>
      </div>
    </HostedSignupUrl>
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
