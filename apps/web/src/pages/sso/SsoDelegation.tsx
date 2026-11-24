import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router'
import { api, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import type { AppShellContext } from '../../components/AppShell.tsx'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { Field } from '../../components/forms.tsx'
import { browserTimeZone, zoned } from '../../format.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { PATHS } from '../../paths.ts'
import { useMe, useSession } from '../../session.tsx'
import { SsoFreshProof } from './SsoFreshProof.tsx'
import {
  oidcStepUpProviders,
  type SsoProofChallenge,
  SsoProofRequired,
  unwrapSsoWrite,
} from './setup.ts'
import './sso-setup.css'

interface DelegationCredential {
  id: string
  label: string
  ssoDelegation: { id: string; expiresAt: string } | undefined
}

interface Props {
  kind: 'api_key' | 'oauth_grant'
  credentials: DelegationCredential[]
  reload: () => void
}

type Change =
  | { kind: 'bind'; credentialId: string; expectedTrustGeneration?: number }
  | { kind: 'revoke'; credentialId: string; bindingId: string }

const contextChanged = 'Your space changed. Reload before making changes.'
const policyUnknown = 'Could not verify this team’s SSO policy.'
const unavailable = 'SSO delegation is unavailable for this credential.'
const saveError = 'Could not change SSO delegation. Try again.'

export function SsoDelegation(props: Props) {
  const me = useMe()
  const shell = useOutletContext<AppShellContext | null>()
  // With the setting off, binding is refused: only an existing delegation can be revoked.
  const stored = shell?.ssoOidcEnabled !== true && shell?.ssoStored === true
  const credentials = stored
    ? props.credentials.filter(({ ssoDelegation }) => ssoDelegation !== undefined)
    : props.credentials
  if (
    (shell?.ssoOidcEnabled !== true && !stored) ||
    me.organization.personal ||
    me.principal.kind !== 'session' ||
    credentials.length === 0
  )
    return null
  return (
    <DelegationForm
      key={`${me.user.id}:${me.organization.id}`}
      {...props}
      credentials={credentials}
    />
  )
}

function DelegationForm({ kind, credentials, reload }: Props) {
  const { t, formatLocale } = useI18n()
  const { organization, sso } = useMe()
  const { confirmReload } = useSession()
  const heading = useRef<HTMLHeadingElement>(null)
  const active = useRef<AbortController | null>(null)
  const id = useId()
  const [selected, setSelected] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)
  const [saved, setSaved] = useState<{
    message: MessageKey
    inventory: DelegationCredential[]
    credentialId: string
    binding: DelegationCredential['ssoDelegation']
  } | null>(null)
  const [pending, setPending] = useState<{
    challenge: SsoProofChallenge
    change: Change
  } | null>(null)
  const credential = credentials.find((entry) => entry.id === selected) ?? credentials[0]
  const binding =
    saved?.inventory === credentials && saved.credentialId === credential?.id
      ? saved.binding
      : credential?.ssoDelegation
  const stepUpProviders = oidcStepUpProviders(sso)

  useLayoutEffect(() => {
    function interrupt() {
      active.current?.abort()
      active.current = null
      setPending(null)
      setWorking(false)
    }
    window.addEventListener('pagehide', interrupt)
    return () => {
      active.current?.abort()
      window.removeEventListener('pagehide', interrupt)
    }
  }, [])

  async function write(change: Change, proofAttemptId?: string) {
    if (active.current || !credential) return
    const controller = new AbortController()
    active.current = controller
    const { signal } = controller
    const header = { 'X-Expected-Organization-Id': organization.id }
    setWorking(true)
    setError(null)
    setSaved(null)

    try {
      let result: DelegationCredential['ssoDelegation']
      if (change.kind === 'bind') {
        let generation = change.expectedTrustGeneration
        if (generation === undefined) {
          const policy = await unwrap(
            api.GET('/api/v1/team/sso/policy', { headers: header, signal, cache: 'no-store' }),
          )
          generation = policy?.trustGeneration
          if (!Number.isSafeInteger(generation) || generation < 1) throw new Error(policyUnknown)
          change = { ...change, expectedTrustGeneration: generation }
        }
        if (signal.aborted) return
        result = await unwrapSsoWrite(
          api.POST('/api/v1/team/sso/delegations', {
            params: { header },
            body: {
              credentialKind: kind,
              credentialId: change.credentialId,
              expectedTrustGeneration: generation,
              proofAttemptId,
            },
            signal,
          }),
        )
      } else {
        await unwrap(
          api.DELETE('/api/v1/team/sso/delegations/{bindingId}', {
            params: { header, path: { bindingId: change.bindingId } },
            signal,
          }),
        )
      }
      if (signal.aborted) return
      setPending(null)
      setSaved({
        message: change.kind === 'bind' ? 'SSO delegation bound.' : 'SSO delegation revoked.',
        inventory: credentials,
        credentialId: change.credentialId,
        binding: result,
      })
      reload()
      heading.current?.focus()
    } catch (cause) {
      if (signal.aborted) return
      if (cause instanceof SsoProofRequired) {
        setPending({ challenge: cause.challenge, change })
        return
      }
      setPending(null)
      setError(
        isOrganizationContextChanged(cause)
          ? contextChanged
          : change.kind === 'bind' && change.expectedTrustGeneration === undefined
            ? policyUnknown
            : delegationError(cause),
      )
      heading.current?.focus()
    } finally {
      if (active.current === controller) {
        active.current = null
        setWorking(false)
      }
    }
  }

  if (!credential) return null
  const expiresAt = binding?.expiresAt
  return (
    <section className="panel stack sso-delegation" aria-labelledby={`${id}-heading`}>
      <h2 ref={heading} tabIndex={-1} id={`${id}-heading`}>
        {t('SSO delegation')}
      </h2>
      {error && (
        <p className="alert alert-error" role="alert">
          {t(error)}
        </p>
      )}
      {saved && <p role="status">{t(saved.message)}</p>}
      {pending && (
        <SsoFreshProof
          key={pending.challenge.attemptId}
          organizationId={organization.id}
          challenge={pending.challenge}
          stepUpProviders={stepUpProviders}
          busy={working}
          onRetry={() => void write(pending.change, pending.challenge.attemptId)}
          onCancel={() => {
            setPending(null)
            heading.current?.focus()
          }}
        />
      )}
      {error === contextChanged ? (
        <div>
          <button type="button" className="button" onClick={confirmReload}>
            {t('Reload team')}
          </button>
        </div>
      ) : (
        <fieldset className="form-fieldset stack" disabled={working || !!pending} inert={!!pending}>
          <Field
            id={`${id}-credential`}
            label={t('Credential')}
            hint={t(
              'Delegation changes apply to credentials in {team}. Switch teams to manage a credential from another team.',
              { team: organization.name },
            )}
          >
            {(control) => (
              <select
                {...control}
                value={credential.id}
                onChange={(event) => {
                  setSelected(event.currentTarget.value)
                  setError(null)
                }}
              >
                {credentials.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {binding ? (
            <div className="stack">
              {expiresAt && Number.isFinite(Date.parse(expiresAt)) && (
                <p>
                  <time dateTime={expiresAt}>
                    {t('SSO delegation expires {when}.', {
                      when: zoned(browserTimeZone(), formatLocale).dateTime(expiresAt),
                    })}
                  </time>
                </p>
              )}
              <div>
                <ConfirmAction
                  key={binding.id}
                  label="Revoke SSO delegation"
                  prompt="Revoke this SSO delegation?"
                  confirmLabel="Revoke SSO delegation"
                  busyLabel="Revoking…"
                  failure={saveError}
                  onConfirm={() =>
                    write({ kind: 'revoke', credentialId: credential.id, bindingId: binding.id })
                  }
                />
              </div>
            </div>
          ) : !sso ? (
            <p role="status">{t('Could not verify your team sign-in settings.')}</p>
          ) : stepUpProviders.length === 0 ? (
            <div className="stack">
              <p>{t('Link a team sign-in method in Settings before binding a delegation.')}</p>
              <div>
                <Link className="button" to={PATHS.settings}>
                  {t('Settings')}
                </Link>
              </div>
            </div>
          ) : (
            <div>
              <button
                type="button"
                className="button"
                onClick={() => void write({ kind: 'bind', credentialId: credential.id })}
              >
                {t('Bind SSO delegation')}
              </button>
            </div>
          )}
        </fieldset>
      )}
    </section>
  )
}

function delegationError(cause: unknown): MessageKey {
  if (!(cause instanceof RequestError)) return saveError
  if (cause.code === 'sso_configuration_changed')
    return 'The team’s SSO settings changed. Start again.'
  if (cause.code === 'sso_not_found')
    return 'This credential or its delegation is unavailable. Check the active team and try again.'
  return cause.status === 403 || cause.code === 'sso_disabled' ? unavailable : saveError
}
