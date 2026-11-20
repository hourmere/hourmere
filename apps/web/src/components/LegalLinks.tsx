import { loadInstance } from '../api/resources.ts'
import { useLoad } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import './LegalLinks.css'

interface PolicyUrls {
  privacyPolicyUrl?: string
  termsUrl?: string
}

/** Policies belong to this instance's operator; unset URLs do not imply hosted policies. */
export function LegalLinks({ privacyPolicyUrl, termsUrl }: PolicyUrls) {
  const { t } = useI18n()
  if (!privacyPolicyUrl && !termsUrl) return null
  return (
    <div className="legal-links">
      {privacyPolicyUrl && (
        <a href={privacyPolicyUrl} target="_blank" rel="noopener noreferrer">
          {t('Privacy policy')}
        </a>
      )}
      {termsUrl && (
        <a href={termsUrl} target="_blank" rel="noopener noreferrer">
          {t('Terms of service')}
        </a>
      )}
    </div>
  )
}

/** For frames that do not otherwise need instance discovery. */
export function InstanceLegalLinks() {
  const [instance] = useLoad(loadInstance)
  return instance.status === 'ready' ? <LegalLinks {...instance.data} /> : null
}
