import { useI18n } from '../i18n/runtime.tsx'

export function EmailDeliveryHint() {
  const { t } = useI18n()
  return (
    <p className="muted">
      {t('Didn’t get the email? Check spam or junk and add the sender to your contacts.')}
    </p>
  )
}
