import { useEffect, useId, useRef, useState } from 'react'
import { api } from '../../api/client.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { Field } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { useMe } from '../../session.tsx'
import { type SsoMutation, type SsoProvider, unwrapSsoWrite } from './setup.ts'

const denied = 'Only another team owner can retire an owner’s identity link.'

export function SsoLinkRetirement({
  provider,
  organizationId,
  busy,
  mutate,
}: {
  provider: SsoProvider
  organizationId: string
  busy: boolean
  mutate: SsoMutation
}) {
  const { t } = useI18n()
  const me = useMe()
  const field = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [selection, setSelection] = useState('')
  const [retired, setRetired] = useState<string[]>([])
  const myLinks = me.sso?.links
  const links =
    myLinks &&
    provider.links?.filter(
      ({ id }) => !myLinks.some((link) => link.id === id) && !retired.includes(id),
    )
  const selected = links?.find(({ id }) => id === selection)

  useEffect(() => {
    if (retired.length > 0) heading.current?.focus()
  }, [retired.length])

  function retire() {
    if (!selected) return Promise.resolve()
    return mutate(
      (signal, proofAttemptId) =>
        unwrapSsoWrite(
          api.DELETE('/api/v1/team/sso/providers/{providerId}/links/{linkId}', {
            params: {
              path: { providerId: provider.id, linkId: selected.id },
              header: { 'X-Expected-Organization-Id': organizationId },
            },
            body: { expectedLinkGeneration: selected.generation, proofAttemptId },
            signal,
          }),
        ),
      () => {
        setRetired((previous) => [...previous, selected.id])
        setSelection('')
      },
      {
        team_management_access_denied:
          'Could not retire this identity link. Only another team owner can retire an owner’s identity link.',
        sso_recovery_required:
          'The member needs a verified Hourmere login email before this link can be retired.',
      },
    )
  }

  return (
    <div className="sso-link-retirement">
      <h4 ref={heading} tabIndex={-1}>
        {t('Identity links')}
      </h4>
      {retired.length > 0 && <p role="status">{t('Identity link retired.')}</p>}
      {links === undefined ? (
        <p role="status">{t('Identity links are unavailable.')}</p>
      ) : (
        <>
          <p>{t(denied)}</p>
          <p>
            {t(
              'For your own link, use Your team sign-in in Settings. To link again after retirement, sign in with your usual method and choose the provider there.',
            )}
          </p>
          {links.length === 0 ? (
            <p>{t('There are no other identity links for this provider.')}</p>
          ) : (
            <>
              <p>
                {t(
                  'Verify the member’s request separately and match the exact link ID before retiring it.',
                )}
              </p>
              <fieldset className="form-fieldset" disabled={busy}>
                <Field id={field} label={t('Identity link')}>
                  {(control) => (
                    <select
                      {...control}
                      value={selected?.id ?? ''}
                      onChange={(event) => setSelection(event.currentTarget.value)}
                      data-private
                    >
                      <option value="">{t('Choose an identity link')}</option>
                      {links.map(({ id }) => (
                        <option key={id} value={id}>
                          {id}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                {selected && (
                  <ConfirmAction
                    key={`${selected.id}:${selected.generation}`}
                    label="Retire identity link"
                    prompt="Retire this identity link?"
                    confirmLabel="Retire identity link"
                    busyLabel="Saving…"
                    failure="Could not retire this identity link."
                    onConfirm={retire}
                  />
                )}
              </fieldset>
            </>
          )}
        </>
      )}
    </div>
  )
}
