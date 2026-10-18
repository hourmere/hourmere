import { useCallback, useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { api, unwrap } from '../api/client.ts'
import { errorMessage, RequestError } from '../api/errors.ts'
import { goTo } from '../browser.ts'
import { Logo } from '../components/Logo.tsx'
import { useLoad, useMounted, usePageTitle } from '../hooks.ts'
import { LanguageSwitcher, useI18n } from '../i18n/runtime.tsx'
import type { UiText } from '../i18n/translate.ts'
import { msg } from '../i18n/translate.ts'
import { signInPath } from '../next-path.ts'
import { PageStatus, useSession } from '../session.tsx'

export function McpAuthorizePage() {
  const { t } = useI18n()

  usePageTitle('Connect an AI app')
  const { state } = useSession()
  const location = useLocation()
  if (state.status === 'loading') return <PageStatus>{t('Loading…')}</PageStatus>
  if (state.status === 'signed-out')
    return <Navigate to={signInPath(location.pathname + location.search)} replace />
  if (state.status !== 'signed-in')
    return <PageStatus>{t('Could not check your session. Please reload.')}</PageStatus>
  return (
    <Authorization
      key={location.pathname + location.search + state.me.user.id}
      email={state.me.user.email}
    />
  )
}

function Authorization({ email }: { email: string }) {
  const { t, ui } = useI18n()

  const location = useLocation(),
    navigate = useNavigate()
  const consent = location.pathname === '/oauth/consent'
  const [intentId] = useState(() => new URLSearchParams(location.hash.slice(1)).get('intent'))
  const oauthQuery = location.search.slice(1)
  // Correlation identifiers stay out of Referer/history once the page has captured them.
  useEffect(() => {
    if (location.hash) navigate(location.pathname + location.search, { replace: true })
  }, [location.hash, location.pathname, location.search, navigate])
  const loadInfo = useCallback(
    async (signal: AbortSignal) => {
      if (consent && !intentId)
        throw new RequestError(
          409,
          'oauth_request_expired',
          'This connection attempt was interrupted. Restart it from your AI app.',
          msg('This connection attempt was interrupted. Restart it from your AI app.'),
        )
      return unwrap(
        api.POST('/api/v1/mcp-oauth/request', {
          signal,
          body: { oauthQuery, ...(intentId ? { intentId } : {}) },
        }),
      )
    },
    [oauthQuery, intentId, consent],
  )
  const [info] = useLoad(loadInfo)
  const mounted = useMounted()
  const [organizationId, setOrganizationId] = useState('')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<UiText>('')
  async function submit(accept: boolean) {
    setBusy(true)
    setError('')
    try {
      const result =
        consent && intentId
          ? await unwrap(
              api.POST('/api/v1/mcp-oauth/consent', { body: { oauthQuery, intentId, accept } }),
            )
          : await unwrap(
              api.POST('/api/v1/mcp-oauth/select', { body: { oauthQuery, organizationId } }),
            )
      if (mounted.current) goTo(result.redirectUrl)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <main className="centered">
      <section className="card stack">
        <Logo size={32} />
        <LanguageSwitcher />
        <h1>{consent ? t('Approve connection') : t('Connect an AI app')}</h1>
        <p>
          {t('Signed in as')} <strong>{email}</strong>.
        </p>
        {info.status === 'loading' && <p role="status">{t('Checking the connection request…')}</p>}
        {info.status === 'error' && <p role="alert">{ui(info.message)}</p>}
        {info.status === 'ready' && (
          <>
            <p>
              <strong>{info.data.clientName}</strong> {t('wants to connect to Hourmere.')}
            </p>
            <p className="muted">
              {t('Client:')} {info.data.clientId}
            </p>
            <p className="muted">
              {t('Return address:')} {info.data.redirectUri}
            </p>
            {consent ? (
              <p>
                {t('Organization:')} <strong>{info.data.selectedOrganization?.name}</strong>
              </p>
            ) : (
              <div className="field">
                <label htmlFor="oauth-organization">{t('Organization to connect')}</label>
                <select
                  id="oauth-organization"
                  value={organizationId}
                  onChange={(e) => setOrganizationId(e.target.value)}
                >
                  <option value="">{t('Choose an organization')}</option>
                  {info.data.organizations.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.slug})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <p>
              {t(
                'This app can use MCP tools with your permissions in this organization: view event types and availability, and create, view, reschedule or cancel bookings. It receives booking details, including attendee information and answers. It cannot manage your account or API keys.',
              )}
            </p>
            {info.data.scopes.includes('offline_access') && (
              <p>
                {t(
                  'It can stay connected for up to 30 days without another sign-in. You can revoke access in Connected apps.',
                )}
              </p>
            )}
            <p>
              {t(
                'Only approve apps you trust. The app name and return address are supplied by the app.',
              )}
            </p>
            {error && <p role="alert">{ui(error)}</p>}
            <button
              type="button"
              className="button button-primary"
              disabled={
                busy ||
                (!consent && !organizationId) ||
                (consent && !info.data.selectedOrganization)
              }
              onClick={() => submit(true)}
            >
              {busy ? t('Continuing…') : consent ? t('Allow access') : t('Continue')}
            </button>
            {consent && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => submit(false)}
              >
                {t('Deny')}
              </button>
            )}
          </>
        )}
      </section>
    </main>
  )
}

const loadConnections = (signal: AbortSignal) =>
  unwrap(api.GET('/api/v1/mcp-oauth/connections', { signal }))
export function ConnectedAppsPage() {
  const { t, ui } = useI18n()

  usePageTitle('Connected apps')
  const [connections, reload] = useLoad(loadConnections)
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<UiText>('')
  async function revoke(id: string) {
    setBusy(id)
    setError('')
    try {
      await unwrap(api.DELETE('/api/v1/mcp-oauth/connections/{id}', { params: { path: { id } } }))
      reload()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <h1>{t('Connected apps')}</h1>
      <p>
        {t(
          'AI apps connected through MCP OAuth. Revoking access stops new requests immediately; completed bookings remain.',
        )}
      </p>
      {error && <p role="alert">{ui(error)}</p>}
      {connections.status === 'loading' && <p role="status">{t('Loading…')}</p>}
      {connections.status === 'error' && <p role="alert">{ui(connections.message)}</p>}
      {connections.status === 'ready' &&
        (connections.data.data.length ? (
          <ul className="stack">
            {connections.data.data.map((c) => (
              <li key={c.id} className="card">
                <h2>{c.clientName}</h2>
                <p>{c.organizationName}</p>
                <p className="muted">{c.clientId}</p>
                <button
                  type="button"
                  className="button"
                  disabled={busy !== null}
                  onClick={() => revoke(c.id)}
                >
                  {busy === c.id ? t('Revoking…') : t('Revoke access')}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('No connected apps.')}</p>
        ))}
    </>
  )
}
