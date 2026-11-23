import { type FormEvent, useEffect, useId, useState } from 'react'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { Field } from '../../components/forms.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { useSession } from '../../session.tsx'
import { type SsoMutation, unwrapSsoWrite } from './setup.ts'

const enforcementErrors = {
  sso_recovery_required:
    'A current owner must accept recovery enrollment before you can require SSO.',
  sso_test_required:
    'A team owner must pass a test of the current version of an enabled OIDC provider.',
  sso_domain_unverified: 'An enabled OIDC provider with a verified domain is required.',
  sso_disabled: 'Could not change the team’s SSO enforcement.',
} as const satisfies Record<string, MessageKey>

type PolicyLoad =
  | { status: 'loading' | 'error' | 'unavailable' | 'team-changed' }
  | { status: 'ready'; data: Schemas['SsoPolicy'] }

type Admission = 'invitation_only' | 'jit'

function isAdmission(value: string): value is Admission {
  return value === 'invitation_only' || value === 'jit'
}

const statusText = {
  loading: 'Loading SSO enforcement…',
  error: 'Could not load SSO enforcement.',
  unavailable: 'SSO enforcement is unavailable in this team.',
  'team-changed': 'Your space changed. Reload before making changes.',
} as const satisfies Record<string, MessageKey>

export function SsoEnforcement({
  organizationId,
  owner,
  busy,
  mutate,
  reload,
  addsTrust = true,
}: {
  /** False while the operator setting is off: enforcement and JIT can only be turned off. */
  addsTrust?: boolean
  organizationId: string
  owner: boolean
  busy: boolean
  mutate: SsoMutation
  reload: () => void
}) {
  const { t } = useI18n()
  const { confirmReload } = useSession()
  const heading = useId()
  const admissionId = useId()
  const [policy, setPolicy] = useState<PolicyLoad>({ status: 'loading' })
  const [selectedAdmission, setSelectedAdmission] = useState<Admission | null>(null)
  const [savedAdmission, setSavedAdmission] = useState(false)
  const [version, setVersion] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: version explicitly reloads the policy
  useEffect(() => {
    const controller = new AbortController()
    void unwrap(
      api.GET('/api/v1/team/sso/policy', {
        headers: { 'X-Expected-Organization-Id': organizationId },
        signal: controller.signal,
        cache: 'no-store',
      }),
    ).then(
      (data) => {
        if (controller.signal.aborted) return
        setPolicy({
          status: 'ready',
          data,
        })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        if (isOrganizationContextChanged(error)) setPolicy({ status: 'team-changed' })
        else if (
          error instanceof RequestError &&
          (error.status === 403 || error.code === 'sso_disabled')
        )
          setPolicy({ status: 'unavailable' })
        else setPolicy({ status: 'error' })
      },
    )
    return () => controller.abort()
  }, [organizationId, version])

  const data = policy.status === 'ready' ? policy.data : null
  const currentAdmission = data && isAdmission(data.admission) ? data.admission : null
  const admission = selectedAdmission ?? currentAdmission
  const requireSso = data?.requireSso === true
  const changeLabel = requireSso ? 'Stop requiring SSO' : 'Require SSO'

  function changePolicy(nextRequirement: boolean, nextAdmission: Admission) {
    if (!data) return Promise.resolve()
    return mutate(
      (signal, proofAttemptId) =>
        unwrapSsoWrite(
          api.PUT('/api/v1/team/sso/policy', {
            params: { header: { 'X-Expected-Organization-Id': organizationId } },
            body: {
              expectedRevision: data.policyRevision,
              admission: nextAdmission,
              requireSso: nextRequirement,
              proofAttemptId,
            },
            signal,
          }),
        ),
      (updated) => {
        if (nextRequirement !== requireSso) reload()
        else {
          setPolicy({ status: 'ready', data: updated })
          setSelectedAdmission(null)
          setSavedAdmission(true)
        }
      },
      nextRequirement === requireSso
        ? {
            sso_domain_unverified: 'Verify a team domain before enabling just-in-time admission.',
            sso_disabled: 'Could not save SSO settings.',
          }
        : enforcementErrors,
    )
  }

  function saveAdmission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!busy && currentAdmission && admission && admission !== currentAdmission) {
      setSavedAdmission(false)
      void changePolicy(requireSso, admission)
    }
  }

  return (
    <section className="panel sso-enforcement" aria-labelledby={heading}>
      <h2 id={heading}>{t('SSO enforcement')}</h2>
      {policy.status === 'ready' ? (
        <>
          <p>
            {t(
              requireSso
                ? 'This team requires single sign-on.'
                : 'Single sign-on is optional for this team.',
            )}
          </p>
          {currentAdmission && admission ? (
            <>
              {owner && (addsTrust || requireSso) && (
                <>
                  {!requireSso && (
                    <p className="hint">
                      {t(
                        'Before requiring SSO, have an owner test the OIDC draft, then enable that revision with a verified domain. A current owner must also accept recovery enrollment.',
                      )}
                    </p>
                  )}
                  <fieldset className="form-fieldset" disabled={busy}>
                    <ConfirmAction
                      label={changeLabel}
                      prompt={
                        requireSso
                          ? 'Stop requiring single sign-on for this team?'
                          : 'Require single sign-on for this team?'
                      }
                      confirmLabel={changeLabel}
                      busyLabel="Saving…"
                      failure="Could not save SSO settings."
                      onConfirm={() => changePolicy(!requireSso, currentAdmission)}
                    />
                  </fieldset>
                </>
              )}
              <form onSubmit={saveAdmission} hidden={!addsTrust && currentAdmission !== 'jit'}>
                <fieldset className="form-fieldset" disabled={busy}>
                  <Field
                    id={admissionId}
                    label={t('Admission policy')}
                    hint={t(
                      'Just-in-time admission lets eligible people join through SSO and requires a verified team domain.',
                    )}
                  >
                    {(control) => (
                      <select
                        {...control}
                        value={admission}
                        onChange={(event) => {
                          const value = event.currentTarget.value
                          if (isAdmission(value)) setSelectedAdmission(value)
                          setSavedAdmission(false)
                        }}
                      >
                        <option value="invitation_only">{t('Invitation only')}</option>
                        <option value="jit">{t('Just-in-time admission')}</option>
                      </select>
                    )}
                  </Field>
                  <button
                    type="submit"
                    className="button"
                    disabled={admission === currentAdmission}
                  >
                    {t('Save admission policy')}
                  </button>
                </fieldset>
              </form>
              {savedAdmission && <p role="status">{t('Admission policy saved.')}</p>}
            </>
          ) : (
            <p role="status">{t('The team’s admission policy is unavailable.')}</p>
          )}
        </>
      ) : (
        <>
          <p role="status">{t(statusText[policy.status])}</p>
          {policy.status === 'error' && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                setPolicy({ status: 'loading' })
                setVersion((previous) => previous + 1)
              }}
            >
              {t('Try again')}
            </button>
          )}
          {policy.status === 'team-changed' && (
            <button type="button" className="button" disabled={busy} onClick={confirmReload}>
              {t('Reload team')}
            </button>
          )}
        </>
      )}
    </section>
  )
}
