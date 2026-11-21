import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, NavLink, useMatch, useOutletContext } from 'react-router'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import type { AppShellContext } from '../../components/AppShell.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { PageSkeleton } from '../../components/PageSkeleton.tsx'
import { usePageTitle } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { PATHS } from '../../paths.ts'
import { useMe, useSession } from '../../session.tsx'
import { useTeamManagementAccess } from '../../team-management.tsx'
import { SsoDomainSetup } from './SsoDomainSetup.tsx'
import { SsoEnforcement } from './SsoEnforcement.tsx'
import { SsoFreshProof } from './SsoFreshProof.tsx'
import { SsoProviderSetup } from './SsoProviderSetup.tsx'
import {
  loadSsoProviders,
  type SsoDomain,
  type SsoMutation,
  type SsoProofChallenge,
  SsoProofRequired,
  type SsoProvider,
} from './setup.ts'

const unavailable: MessageKey = 'SSO settings are unavailable in this team.'
const loadError: MessageKey = 'Could not load SSO settings.'
const loading: MessageKey = 'Loading SSO settings…'

export function SsoSetupPage() {
  const { t } = useI18n()
  const me = useMe()
  const access = useTeamManagementAccess()
  const { ssoOidcEnabled } = useOutletContext<AppShellContext>()
  const showDomains = useMatch(PATHS.ssoDomainSettings) !== null
  const title = showDomains ? 'SSO domains' : 'Single sign-on'
  usePageTitle(title)
  const sessionTeam = !me.organization.personal && me.principal.kind === 'session'

  return (
    <>
      <PageHeader title={t(title)}>
        <Link className="button" to={PATHS.settings}>
          {t('Settings')}
        </Link>
      </PageHeader>
      {sessionTeam && access.status === 'loading' ? (
        <PageSkeleton label={loading} />
      ) : sessionTeam && access.status === 'error' ? (
        <SetupAlert message={loadError} action="Try again" onAction={access.reload} />
      ) : !sessionTeam || access.status !== 'ready' || access.role === null ? (
        <SetupAlert message={unavailable} />
      ) : (
        <>
          <nav className="form-actions" aria-label={t('Single sign-on')}>
            {ssoOidcEnabled && (
              <NavLink to={PATHS.sso} end className="button">
                {t('Identity providers')}
              </NavLink>
            )}
            <NavLink to={PATHS.ssoDomainSettings} className="button">
              {t('SSO domains')}
            </NavLink>
          </nav>
          <SsoInventory
            key={me.organization.id}
            organizationId={me.organization.id}
            owner={access.role === 'owner'}
            showDomains={showDomains}
          />
        </>
      )}
    </>
  )
}

type InventoryError = 'error' | 'unavailable' | 'team-changed' | 'stale'
type Inventory =
  | { status: 'loading' }
  | { status: 'ready'; providers: SsoProvider[] }
  | { status: InventoryError }

function inventoryError(error: unknown): InventoryError {
  if (isOrganizationContextChanged(error)) return 'team-changed'
  if (error instanceof RequestError) {
    if (error.status === 403 || error.code === 'sso_disabled') return 'unavailable'
    if (
      (error.status === 409 && error.code === 'sso_configuration_changed') ||
      (error.status === 404 && error.code === 'sso_not_found')
    )
      return 'stale'
  }
  return 'error'
}

function SsoInventory({
  organizationId,
  owner,
  showDomains,
}: {
  organizationId: string
  owner: boolean
  showDomains: boolean
}) {
  const { t } = useI18n()
  const me = useMe()
  const { confirmReload } = useSession()
  const [inventory, setInventory] = useState<Inventory>({ status: 'loading' })
  const [version, setVersion] = useState(0)
  // The provider inventory is the only read that returns domain summaries. Keep safe
  // summaries of this visit's writes so a new domain can be verified and associated.
  const [remembered, setRemembered] = useState(() => new Map<string, SsoDomain>())
  const [writeError, setWriteError] = useState<MessageKey | null>(null)
  const activeWrite = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<{
    challenge: SsoProofChallenge
    retry: (attemptId: string) => Promise<void>
  } | null>(null)
  const proofOpener = useRef<HTMLElement | null>(null)

  function reload() {
    setWriteError(null)
    setInventory({ status: 'loading' })
    setVersion((value) => value + 1)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: version explicitly reloads the inventory
  useEffect(() => {
    const controller = new AbortController()
    void loadSsoProviders(organizationId, controller.signal).then(
      (providers) => {
        if (controller.signal.aborted) return
        setRemembered((previous) => {
          const remaining = new Map(previous)
          for (const provider of providers) {
            for (const domain of provider.domains) {
              const local = remaining.get(domain.id)
              if (local && local.generation <= domain.generation) remaining.delete(domain.id)
            }
          }
          return remaining
        })
        setInventory({ status: 'ready', providers })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setInventory({ status: inventoryError(error) })
      },
    )
    return () => controller.abort()
  }, [organizationId, version])

  // Proof belongs to this team and settings pane. Keep the retry inputs in memory
  // only, and discard them when leaving the pane or restoring a page snapshot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: showDomains changes the settings pane
  useLayoutEffect(() => {
    function reset() {
      activeWrite.current?.abort()
      activeWrite.current = null
      proofOpener.current = null
      setPending(null)
      setBusy(false)
      setWriteError(null)
    }
    reset()
    window.addEventListener('pagehide', reset)
    return () => {
      activeWrite.current?.abort()
      window.removeEventListener('pagehide', reset)
    }
  }, [showDomains, owner])

  useEffect(() => {
    if (!busy && !pending && proofOpener.current) {
      proofOpener.current.focus()
      proofOpener.current = null
    }
  }, [busy, pending])

  const mutate: SsoMutation = (write, onSuccess, messages) => {
    async function run(proofAttemptId?: string) {
      if (activeWrite.current || inventory.status !== 'ready') return
      const controller = new AbortController()
      activeWrite.current = controller
      setBusy(true)
      setWriteError(null)
      try {
        const result = await write(controller.signal, proofAttemptId)
        if (controller.signal.aborted) return
        setPending(null)
        onSuccess(result)
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof SsoProofRequired) {
          setPending({ challenge: error.challenge, retry: run })
          return
        }
        setPending(null)
        const code = error instanceof RequestError ? error.code : undefined
        const status = inventoryError(error)
        if (status === 'unavailable' && code !== 'sso_disabled') setInventory({ status })
        else if (code && messages && Object.hasOwn(messages, code))
          setWriteError(messages[code] ?? null)
        else if (status !== 'error') setInventory({ status })
        else if (code === 'sso_domain_unverified')
          setWriteError(
            'Could not verify this domain. Check the TXT record or generate a new challenge.',
          )
        else setWriteError('Could not save SSO settings.')
      } finally {
        if (activeWrite.current === controller) {
          activeWrite.current = null
          setBusy(false)
        }
      }
    }
    if (pending || activeWrite.current) return Promise.resolve()
    if (document.activeElement instanceof HTMLElement) proofOpener.current = document.activeElement
    return run()
  }

  if (inventory.status === 'loading') return <PageSkeleton label={loading} />
  if (inventory.status === 'unavailable') return <SetupAlert message={unavailable} />
  if (inventory.status === 'team-changed')
    return (
      <SetupAlert
        message="Your space changed. Reload before making changes."
        action="Reload team"
        onAction={confirmReload}
      />
    )
  if (inventory.status === 'stale')
    return (
      <SetupAlert
        message="These SSO settings changed. Reload before trying again."
        action="Reload settings"
        onAction={() => {
          setRemembered(new Map())
          reload()
        }}
      />
    )
  if (inventory.status !== 'ready')
    return <SetupAlert message={loadError} action="Try again" onAction={reload} />

  const visibleDomains = new Map<string, SsoDomain>()
  for (const provider of inventory.providers) {
    for (const domain of provider.domains) {
      const existing = visibleDomains.get(domain.id)
      if (!existing || existing.generation <= domain.generation)
        visibleDomains.set(domain.id, domain)
    }
  }
  for (const domain of remembered.values()) {
    if (domain.status === 'retired') visibleDomains.delete(domain.id)
    else visibleDomains.set(domain.id, domain)
  }
  const providers = inventory.providers.map((provider) => ({
    ...provider,
    domains: provider.domains.flatMap(({ id }) => visibleDomains.get(id) ?? []),
  }))
  const ownedLinks = new Set(me.sso?.links.map(({ providerId }) => providerId))
  const stepUpProviders = providers.filter(
    ({ id, enabled, protocol }) => enabled && protocol === 'oidc' && ownedLinks.has(id),
  )
  const paneProps = {
    organizationId,
    domains: [...visibleDomains.values()],
    busy: busy || pending !== null,
    mutate,
  }

  return (
    <>
      {writeError && (
        <p className="alert alert-error" role="alert">
          {t(writeError)}
        </p>
      )}
      {pending && (
        <SsoFreshProof
          key={pending.challenge.attemptId}
          challenge={pending.challenge}
          organizationId={organizationId}
          stepUpProviders={stepUpProviders}
          busy={busy}
          onRetry={() => void pending.retry(pending.challenge.attemptId)}
          onCancel={() => setPending(null)}
        />
      )}
      <div className="sso-setup-pane" inert={pending !== null}>
        {showDomains ? (
          <SsoDomainSetup
            {...paneProps}
            rememberDomain={(domain) =>
              setRemembered((previous) => new Map(previous).set(domain.id, domain))
            }
          />
        ) : (
          <>
            <SsoProviderSetup {...paneProps} providers={providers} owner={owner} reload={reload} />
            <SsoEnforcement
              organizationId={organizationId}
              owner={owner}
              busy={paneProps.busy}
              mutate={mutate}
              reload={reload}
            />
          </>
        )}
      </div>
    </>
  )
}

function SetupAlert({
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
