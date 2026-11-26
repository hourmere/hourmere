import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n/runtime.tsx'
import { useMe } from '../../session.tsx'
import { useTeamManagementAccess } from '../../team-management.tsx'
import { useConfirmLeave } from '../../unsaved-changes.tsx'
import { WebhookSettings } from './WebhookSettings.tsx'

export function WebhookIntegration() {
  const { t } = useI18n()
  const me = useMe()
  const access = useTeamManagementAccess()
  const confirmLeave = useConfirmLeave()
  const { id: organizationId, personal } = me.organization
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [denied, setDenied] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const revoke = access.revoke
  const unavailable = useCallback(
    (code: string | undefined) => {
      setDenied(true)
      if (!personal && (code === 'team_management_access_denied' || code === 'insufficient_role'))
        revoke()
    },
    [personal, revoke],
  )

  const session = me.principal.kind === 'session'
  const allowed =
    !denied &&
    session &&
    (personal
      ? me.personalOrganizationId === organizationId
      : access.status === 'ready' && access.role !== null)

  useLayoutEffect(() => {
    if (open && !allowed) {
      setOpen(false)
      setSaving(false)
      heading.current?.focus()
    }
  }, [allowed, open])

  if (!allowed) {
    return (
      <div className="stack">
        <h3 ref={heading} tabIndex={-1}>
          {t('Webhooks')}
        </h3>
        {session && !personal && access.status === 'loading' ? (
          <p role="status">{t('Checking webhook access…')}</p>
        ) : (
          <div className="alert alert-error" role="alert">
            <p>{t('Webhook endpoints are unavailable.')}</p>
            {session && !personal && access.status === 'error' && (
              <button className="button" type="button" onClick={access.reload}>
                {t('Try again')}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <button
        className="button"
        type="button"
        disabled={saving}
        aria-expanded={open}
        aria-controls={open ? 'webhook-settings' : undefined}
        onClick={() => {
          if (!open || confirmLeave()) setOpen(!open)
        }}
      >
        {t('Webhooks')}
      </button>
      {open && (
        <section id="webhook-settings" className="stack" aria-labelledby="webhook-settings-heading">
          <h3 id="webhook-settings-heading" ref={heading} tabIndex={-1}>
            {t('Webhooks')}
          </h3>
          <WebhookSettings
            organizationId={organizationId}
            userId={me.user.id}
            personal={personal}
            headingRef={heading}
            onAccessDenied={unavailable}
            onSavingChange={setSaving}
          />
        </section>
      )}
    </div>
  )
}
