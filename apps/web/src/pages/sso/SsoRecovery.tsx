import { type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import type { AppShellContext } from '../../components/AppShell.tsx'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { PATHS } from '../../paths.ts'
import { useMe, useSession } from '../../session.tsx'
import { useTeamManagementAccess } from '../../team-management.tsx'
import { SsoFreshProof } from './SsoFreshProof.tsx'
import { ProviderForm } from './SsoProviderSetup.tsx'
import './sso-setup.css'
import {
  loadSsoProviders,
  type SsoMutation,
  type SsoProofChallenge,
  SsoProofRequired,
  type SsoProvider,
  ssoAuthorizationUrl,
  unwrapSsoWrite,
} from './setup.ts'

const loading = 'Loading SSO recovery…'
const unavailable = 'SSO recovery is unavailable in this team.'
const loadError = 'Could not load SSO recovery.'
const changed = 'These SSO settings changed. Reload before trying again.'

export function SsoRecoveryPage() {
  const { t } = useI18n()
  const me = useMe()
  const { ssoOidcEnabled } = useOutletContext<AppShellContext>()
  const access = useTeamManagementAccess()
  const team = !me.organization.personal && me.principal.kind === 'session'
  usePageTitle('SSO recovery')

  return (
    <>
      <PageHeader title={t('SSO recovery')}>
        <Link className="button" to={PATHS.settings}>
          {t('Settings')}
        </Link>
      </PageHeader>
      {team && access.status === 'loading' ? (
        <PageSkeleton label={loading} />
      ) : team && access.status === 'error' ? (
        <RecoveryNotice message={loadError} action="Try again" onAction={access.reload} />
      ) : team && access.status === 'ready' && access.role === 'owner' ? (
        <RecoveryFlow
          key={`${me.user.id}:${me.organization.id}`}
          organizationId={me.organization.id}
          oidcEnabled={ssoOidcEnabled === true}
        />
      ) : (
        <RecoveryNotice message={unavailable} />
      )}
    </>
  )
}

function RecoveryNotice({
  message,
  action,
  onAction,
}: {
  message: MessageKey
  action?: MessageKey
  onAction?: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="alert alert-error notice">
      <p role="alert">{t(message)}</p>
      {action && (
        <button type="button" className="button" onClick={onAction}>
          {t(action)}
        </button>
      )}
    </div>
  )
}

type Policy = Schemas['SsoPolicy']
type LoadFailure = 'error' | 'unavailable' | 'team-changed' | 'stale'
type Readiness =
  | { status: 'loading' | LoadFailure }
  | { status: 'ready'; revision: number }
  | { status: 'not-enforced' }

function failure(error: unknown): LoadFailure {
  if (isOrganizationContextChanged(error)) return 'team-changed'
  if (error instanceof RequestError) {
    if (error.code === 'sso_configuration_changed') return 'stale'
    if (error.status === 403 || error.code === 'sso_disabled') return 'unavailable'
  }
  return 'error'
}

function loadPolicy(organizationId: string, signal: AbortSignal) {
  return unwrap(
    api.GET('/api/v1/team/sso/policy', {
      headers: { 'X-Expected-Organization-Id': organizationId },
      signal,
      cache: 'no-store',
    }),
  )
}

function recoveryReadiness(policy: Policy): Readiness {
  if (policy.requireSso === false) return { status: 'not-enforced' }
  return policy.requireSso === true &&
    Number.isSafeInteger(policy.policyRevision) &&
    policy.policyRevision >= 1 &&
    policy.policyRevision <= 2_147_483_646
    ? { status: 'ready', revision: policy.policyRevision }
    : { status: 'unavailable' }
}

type Inventory = { policy: Policy; providers: SsoProvider[]; expiresAt: number }
type ProviderTest = { url: string; providerId: string; revision: number }

function RecoveryFlow({
  organizationId,
  oidcEnabled,
}: {
  organizationId: string
  oidcEnabled: boolean
}) {
  const { locale, t } = useI18n()
  const { confirmReload } = useSession()
  const heading = useId()
  const [readiness, setReadiness] = useState<Readiness>({ status: 'loading' })
  const [version, setVersion] = useState(0)
  const [proof, setProof] = useState<SsoProofChallenge | null>(null)
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [busy, setBusy] = useState(false)
  const [started, setStarted] = useState(false)
  const [notice, setNotice] = useState<MessageKey | null>(null)
  const [writeError, setWriteError] = useState<MessageKey | null>(null)
  const [providerTest, setProviderTest] = useState<ProviderTest | null>(null)
  const request = useRef<AbortController | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const repairHeading = useRef<HTMLHeadingElement>(null)
  const testLink = useRef<HTMLAnchorElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: version retries the policy read
  useEffect(() => {
    const controller = new AbortController()
    void loadPolicy(organizationId, controller.signal).then(
      (policy) => {
        if (!controller.signal.aborted) setReadiness(recoveryReadiness(policy))
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setReadiness({ status: failure(cause) })
      },
    )
    return () => controller.abort()
  }, [organizationId, version])

  useLayoutEffect(() => {
    function reset() {
      request.current?.abort()
      request.current = null
      setProof(null)
      setInventory(null)
      setProviderTest(null)
      setBusy(false)
    }
    window.addEventListener('pagehide', reset)
    return () => {
      window.removeEventListener('pagehide', reset)
      request.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!inventory) return
    repairHeading.current?.focus()
    const timeout = window.setTimeout(
      () => {
        setInventory(null)
        setWriteError('Recovery verification expired. Verify by email again to continue.')
      },
      Math.min(2_147_483_647, Math.max(0, inventory.expiresAt - Date.now())),
    )
    return () => window.clearTimeout(timeout)
  }, [inventory])

  useEffect(() => {
    if (providerTest) testLink.current?.focus()
  }, [providerTest])

  function resetRead() {
    setReadiness({ status: 'loading' })
    setWriteError(null)
    setVersion((previous) => previous + 1)
  }

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setNotice(null)
    setWriteError(null)
    try {
      await action(controller.signal)
    } finally {
      if (request.current === controller) {
        request.current = null
        setBusy(false)
      }
    }
  }

  async function loadInventory(signal: AbortSignal, expiresAt: number) {
    const [policy, providers] = await Promise.all([
      loadPolicy(organizationId, signal),
      oidcEnabled ? loadSsoProviders(organizationId, signal) : [],
    ])
    signal.throwIfAborted()
    const current = recoveryReadiness(policy)
    setReadiness(current)
    setInventory(current.status === 'ready' ? { policy, providers, expiresAt } : null)
    setProviderTest((test) =>
      test &&
      providers.some(
        (provider) =>
          provider.id === test.providerId &&
          provider.revision === test.revision &&
          provider.testStatus === 'not_tested',
      )
        ? test
        : null,
    )
  }

  function start(challenge?: SsoProofChallenge) {
    if (readiness.status !== 'ready') return Promise.resolve()
    const { revision } = readiness
    return run(async (signal) => {
      let verified = false
      try {
        await unwrapSsoWrite(
          api.POST('/api/v1/team/sso/recovery/use', {
            params: { header: { 'X-Expected-Organization-Id': organizationId } },
            body: { expectedRevision: revision, proofAttemptId: challenge?.attemptId },
            signal,
          }),
        )
        signal.throwIfAborted()
        if (!challenge) throw new Error('Recovery did not return a mailbox challenge')
        verified = true
        setProof(null)
        setStarted(true)
        await loadInventory(signal, Date.parse(challenge.expiresAt))
      } catch (cause) {
        if (signal.aborted) return
        if (
          cause instanceof SsoProofRequired &&
          cause.challenge.proofMethods.length === 1 &&
          cause.challenge.proofMethods[0] === 'mailbox'
        ) {
          setProof(cause.challenge)
          return
        }
        setProof(null)
        const status = failure(cause)
        if (status === 'error')
          setWriteError(verified ? loadError : 'Could not start SSO recovery. Try again.')
        else setReadiness({ status })
      }
    })
  }

  function refreshTestResult() {
    if (!inventory || Date.now() >= inventory.expiresAt) return
    void run(async (signal) => {
      try {
        await loadInventory(signal, inventory.expiresAt)
      } catch (cause) {
        if (signal.aborted) return
        if (failure(cause) === 'error') setWriteError(loadError)
        else {
          setInventory(null)
          setReadiness({ status: failure(cause) })
        }
      }
    })
  }

  // The browser grant spends once. Never fall back to ordinary IdP step-up or
  // retry a repair on the same grant after a failed or ambiguous response.
  const spend: SsoMutation = (write, onSuccess, messages) => {
    if (!inventory || Date.now() >= inventory.expiresAt) return Promise.resolve()
    return run(async (signal) => {
      setInventory(null)
      try {
        const result = await write(signal)
        signal.throwIfAborted()
        onSuccess(result)
      } catch (cause) {
        if (signal.aborted) return
        const status = failure(cause)
        const code = cause instanceof RequestError ? cause.code : undefined
        if (status === 'team-changed' || code === 'team_management_access_denied') {
          setReadiness({ status })
          return
        }
        const message = code && messages && Object.hasOwn(messages, code) ? messages[code] : null
        setWriteError(
          message ?? 'Could not complete this recovery action. Verify again before retrying.',
        )
      }
    })
  }

  if (readiness.status === 'loading') return <PageSkeleton label={loading} />
  if (readiness.status === 'unavailable') return <RecoveryNotice message={unavailable} />
  if (readiness.status === 'team-changed')
    return (
      <RecoveryNotice
        message="Your space changed. Reload before making changes."
        action="Reload team"
        onAction={confirmReload}
      />
    )
  if (readiness.status === 'stale')
    return <RecoveryNotice message={changed} action="Reload settings" onAction={resetRead} />
  if (readiness.status === 'error')
    return <RecoveryNotice message={loadError} action="Try again" onAction={resetRead} />
  if (readiness.status === 'not-enforced')
    return (
      <p className="notice" role="status">
        {t(notice ?? 'Single sign-on is optional for this team.')}
      </p>
    )

  return (
    <>
      {proof && (
        <SsoFreshProof
          key={proof.attemptId}
          organizationId={organizationId}
          challenge={proof}
          stepUpProviders={[]}
          busy={busy}
          onRetry={() => void start(proof)}
          onCancel={() => {
            setProof(null)
            // Wait until the opener is enabled again.
            requestAnimationFrame(() => opener.current?.focus())
          }}
        />
      )}
      {writeError && <RecoveryNotice message={writeError} />}
      {notice && (
        <p className="notice" role="status">
          {t(notice)}
        </p>
      )}
      {providerTest && !proof && (
        <section className="panel stack sso-enforcement" aria-label={t('Test provider')}>
          <div className="form-actions">
            <a
              className="button"
              ref={testLink}
              href={providerTest.url}
              target="_blank"
              rel="noopener noreferrer"
              data-private
            >
              {t('Continue to identity provider')}
              {locale === 'zh-CN' ? '' : ' '}
              {t('(opens in a new tab)')}
            </a>
            {inventory && (
              <button type="button" className="button" disabled={busy} onClick={refreshTestResult}>
                {t('Check provider test result')}
              </button>
            )}
          </div>
          <p>{t('Finish the provider test in the new tab, then return here to continue.')}</p>
        </section>
      )}
      {!inventory && (
        <section className="panel stack sso-enforcement" aria-labelledby={heading} inert={!!proof}>
          <h2 id={heading}>{t('Recover access to your team')}</h2>
          <p>
            {t(
              'Recovery owners can verify by email to inspect SSO settings, repair a provider or stop requiring SSO. Each change needs a new verification.',
            )}
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={(event) => {
                opener.current = event.currentTarget
                void start()
              }}
            >
              {t(started ? 'Verify again to continue recovery' : 'Start recovery')}
            </button>
          </div>
        </section>
      )}
      {inventory && (
        <RecoveryRepair
          organizationId={organizationId}
          inventory={inventory}
          oidcEnabled={oidcEnabled}
          busy={busy}
          heading={repairHeading}
          spend={spend}
          onTest={setProviderTest}
          onSave={() => setNotice('Provider saved. Verify again to test the current revision.')}
          onActivation={() => setNotice('The current provider revision is enabled.')}
          onStop={(policy) => {
            setReadiness(recoveryReadiness(policy))
            setNotice('Single sign-on is now optional for this team.')
          }}
        />
      )}
    </>
  )
}

const activationErrors = {
  sso_test_required: 'Pass a test of this provider’s current revision before enabling it.',
  sso_domain_unverified: 'Verify an associated domain before enabling this provider.',
} as const satisfies Record<string, MessageKey>

function RecoveryRepair({
  organizationId,
  inventory,
  oidcEnabled,
  busy,
  heading,
  spend,
  onSave,
  onTest,
  onActivation,
  onStop,
}: {
  organizationId: string
  inventory: Inventory
  oidcEnabled: boolean
  busy: boolean
  heading: RefObject<HTMLHeadingElement | null>
  spend: SsoMutation
  onSave: () => void
  onTest: (test: ProviderTest) => void
  onActivation: () => void
  onStop: (policy: Policy) => void
}) {
  const { t, locale } = useI18n()
  const id = useId()
  const [editing, setEditing] = useState<'new' | SsoProvider | null>(null)
  const editorOpener = useRef<HTMLButtonElement>(null)
  const providers = inventory.providers.filter(({ protocol }) => protocol === 'oidc')
  const domains = new Map<string, SsoProvider['domains'][number]>()
  for (const provider of providers) {
    for (const domain of provider.domains) {
      const previous = domains.get(domain.id)
      if (!previous || previous.generation < domain.generation) domains.set(domain.id, domain)
    }
  }
  const header = { 'X-Expected-Organization-Id': organizationId }
  const { admission, policyRevision } = inventory.policy

  function stopEnforcement() {
    if (admission !== 'invitation_only' && admission !== 'jit') return Promise.resolve()
    return spend(
      (signal) =>
        unwrap(
          api.PUT('/api/v1/team/sso/policy', {
            params: { header },
            body: { expectedRevision: policyRevision, admission, requireSso: false },
            signal,
          }),
        ),
      onStop,
    )
  }

  useEffect(() => {
    if (!editing) editorOpener.current?.focus()
  }, [editing])

  return (
    <section className="sso-providers stack" aria-labelledby={id}>
      <h2 id={id} ref={heading} tabIndex={-1}>
        {t('Repair identity providers')}
      </h2>
      {oidcEnabled && (
        <>
          <p>
            {t(
              'Save the repair, test the current revision and enable it. Verify by email again before each subsequent change.',
            )}
          </p>
          <div>
            <button
              type="button"
              className="button"
              disabled={busy || editing !== null}
              onClick={(event) => {
                editorOpener.current = event.currentTarget
                setEditing('new')
              }}
            >
              {t('Add provider')}
            </button>
          </div>
          {editing && (
            <ProviderForm
              organizationId={organizationId}
              domains={[...domains.values()]}
              busy={busy}
              mutate={spend}
              reload={onSave}
              provider={editing === 'new' ? null : editing}
              onClose={() => setEditing(null)}
            />
          )}
          {providers.length === 0 && <p className="empty">{t('No identity providers yet.')}</p>}
          {providers.map((provider) => {
            const params = { path: { providerId: provider.id }, header }
            const revision = provider.revision
            const canEnable =
              provider.testStatus === 'passed' &&
              provider.domains.some(({ status }) => status === 'verified')
            const domainCheckUnknown = provider.domains.some(
              ({ status }) => !['pending', 'verified', 'failed', 'expired'].includes(status),
            )
            const statusId = `${id}-status-${provider.id}`
            return (
              <section className="panel" key={provider.id} aria-labelledby={`${id}-${provider.id}`}>
                <h3 id={`${id}-${provider.id}`} className="user-content">
                  {provider.displayName}
                </h3>
                <p className="user-content">{provider.issuer}</p>
                <p>
                  {t('Revision {revision}', { revision })} ·{' '}
                  {t(provider.enabled ? 'Enabled' : 'Disabled')}
                </p>
                <p id={statusId}>
                  {t(
                    provider.testStatus === 'passed'
                      ? 'Current revision passed its test.'
                      : provider.testStatus === 'failed'
                        ? 'Current revision failed its test.'
                        : provider.testStatus === 'not_tested'
                          ? 'No test result for the current revision.'
                          : 'Provider test status is unavailable.',
                  )}
                  {provider.testStatus === 'passed' && !canEnable && (
                    <>
                      {locale === 'zh-CN' ? '' : ' '}
                      {t(
                        domainCheckUnknown
                          ? 'Verification unknown'
                          : activationErrors.sso_domain_unverified,
                      )}
                    </>
                  )}
                </p>
                <fieldset className="form-fieldset" disabled={busy || editing !== null}>
                  <div className="form-actions">
                    <button
                      type="button"
                      className="button button-small"
                      aria-label={t('Edit {name}', { name: provider.displayName })}
                      onClick={(event) => {
                        editorOpener.current = event.currentTarget
                        setEditing(provider)
                      }}
                    >
                      {t('Edit')}
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      aria-label={t('Test provider {name}', { name: provider.displayName })}
                      onClick={() =>
                        void spend(async (signal) => {
                          const { url } = await unwrap(
                            api.POST('/api/v1/team/sso/providers/{providerId}/test', {
                              params,
                              body: { expectedRevision: revision },
                              signal,
                            }),
                          )
                          return {
                            url: ssoAuthorizationUrl(url),
                            providerId: provider.id,
                            revision,
                          }
                        }, onTest)
                      }
                    >
                      {t('Test provider')}
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      aria-label={t('Enable provider {name}', { name: provider.displayName })}
                      aria-describedby={statusId}
                      disabled={!canEnable}
                      onClick={() =>
                        void spend(
                          (signal) =>
                            unwrap(
                              api.POST('/api/v1/team/sso/providers/{providerId}/activation', {
                                params,
                                body: { expectedRevision: revision, enabled: true },
                                signal,
                              }),
                            ),
                          onActivation,
                          activationErrors,
                        )
                      }
                    >
                      {t('Enable provider')}
                    </button>
                  </div>
                </fieldset>
              </section>
            )
          })}
        </>
      )}
      {(admission === 'invitation_only' || admission === 'jit') && (
        <fieldset className="form-fieldset" disabled={busy || editing !== null}>
          <ConfirmAction
            label="Stop requiring SSO"
            prompt="Stop requiring single sign-on for this team?"
            confirmLabel="Stop requiring SSO"
            busyLabel="Saving…"
            failure="Could not save SSO settings."
            onConfirm={stopEnforcement}
          />
        </fieldset>
      )}
    </section>
  )
}
