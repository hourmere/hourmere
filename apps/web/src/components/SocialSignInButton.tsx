import type { SocialProvider } from '../api/auth.ts'
import googleButton from '../assets/identity/google-sign-in-light.svg?raw'
import microsoftSymbol from '../assets/identity/microsoft-symbol.svg'
import { useI18n } from '../i18n/runtime.tsx'
import './SocialSignInButton.css'

// This is Google's trusted, vendored SVG, never user content. Keep its geometry and
// colors untouched; move its two inline styles into CSP-compatible external CSS.
const googleMark = googleButton
  .replace('style="mask-type:alpha"', 'mask-type="alpha"')
  .replace(/style="background:conic-gradient\([^"]+"/, 'class="google-mark-gradient"')

export function SocialSignInButton({
  provider,
  disabled,
  opening,
  onClick,
}: {
  provider: SocialProvider
  disabled: boolean
  opening: boolean
  onClick: () => void
}) {
  const { t } = useI18n()
  const label = provider === 'google' ? t('Continue with Google') : t('Sign in with Microsoft')
  return (
    <button
      type="button"
      className={`social-sign-in social-sign-in-${provider}`}
      disabled={disabled}
      aria-busy={opening}
      aria-describedby={`${provider}-sign-in-explanation`}
      onClick={onClick}
    >
      <span className="social-sign-in-state" aria-hidden="true" />
      {provider === 'google' ? (
        <span className="social-sign-in-google-mark" aria-hidden="true">
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted local official SVG, see above */}
          <span dangerouslySetInnerHTML={{ __html: googleMark }} />
        </span>
      ) : (
        <img src={microsoftSymbol} width="21" height="21" alt="" aria-hidden="true" />
      )}
      <span className="social-sign-in-label">{label}</span>
    </button>
  )
}
