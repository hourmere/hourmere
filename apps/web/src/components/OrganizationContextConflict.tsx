import { isOrganizationContextChanged } from '../api/errors.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { useSession } from '../session.tsx'
import { useConfirmLeave } from '../unsaved-changes.tsx'

/** Keeps recovery deliberate: reloading may discard the form's original-team draft. */
export function OrganizationContextConflict({ error }: { error: unknown }) {
  if (!isOrganizationContextChanged(error)) return null
  return <Conflict />
}

function Conflict() {
  const { t } = useI18n()
  const { reload } = useSession()
  const confirmLeave = useConfirmLeave()
  return (
    <div className="alert alert-error" role="alert">
      <p>{t('Your team context changed. Reload before making changes.')}</p>
      <button
        type="button"
        className="button button-small"
        onClick={() => {
          if (confirmLeave()) reload()
        }}
      >
        {t('Reload')}
      </button>
    </div>
  )
}
