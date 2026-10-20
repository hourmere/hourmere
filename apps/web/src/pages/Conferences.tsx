import { useEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { errorMessage } from '../api/errors.ts'
import { goTo } from '../browser.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { ConfirmAction } from '../components/ConfirmAction.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { PageHeader } from '../components/PageHeader.tsx'
import { PageSkeleton } from '../components/PageSkeleton.tsx'
import { useLoad, useMounted, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { msg, type UiText } from '../i18n/translate.ts'
import { leavesPage } from '../unsaved-changes.tsx'

type Connection = Schemas['ConferenceConnection']
const load = (signal: AbortSignal) => unwrap(api.GET('/api/v1/conference-connections', { signal }))
const outcomes = {
  connected: 'Zoom account connected.',
  busy: 'Zoom account operations are busy. Try again shortly.',
  denied: 'Zoom was not connected because you cancelled authorization.',
  invalid_state: 'This Zoom connection attempt expired or was already used. Start again.',
  disabled: 'Zoom connections are not configured on this instance.',
  provider_unavailable:
    'Zoom could not be reached. Check the connection status before trying again.',
  needs_reauth: 'Reconnect this Zoom account before refreshing it.',
  permissions_missing:
    'Zoom did not return exactly the requested permissions. Check the app configuration and reconnect.',
  mode_conflict:
    'Identity-only authorization cannot replace meeting permissions. Reconnect this Zoom account with its existing meeting permissions.',
  identity_mismatch: 'Choose the same Zoom account when reconnecting this connection.',
  account_in_use: 'This Zoom identity is already connected to another Hourmere account.',
  connection_limit: 'This account has reached its limit of five connected Zoom identities.',
  session_required: 'Sign in again to manage conference accounts.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
} as const
const statusLabels = {
  active: 'Connected',
  refreshing: 'Refreshing connection',
  needs_reauth: 'Reconnection required',
  disconnected: 'Disconnected',
} as const
function outcome(search: URLSearchParams): UiText | null {
  const value = search.get('zoom')
  return value && Object.hasOwn(outcomes, value)
    ? msg(outcomes[value as keyof typeof outcomes])
    : null
}

export function ConferencesPage() {
  const { t, text, ui, formatLocale } = useI18n()
  usePageTitle('Conference accounts')
  const [state, reload] = useLoad(load),
    [search, setSearch] = useSearchParams()
  const [notice, setNotice] = useState<UiText | null>(() => outcome(search))
  const [error, setError] = useState<UiText | null>(null),
    [pending, setPending] = useState<string | null>(null)
  const mounted = useMounted(),
    request = useRef<AbortController | null>(null),
    location = useLocation(),
    currentLocation = useRef(location)
  currentLocation.current = location
  useEffect(() => {
    const cancel = () => request.current?.abort()
    const clicked = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (anchor instanceof HTMLAnchorElement && leavesPage(event, anchor, currentLocation.current))
        cancel()
    }
    document.addEventListener('click', clicked, true)
    window.addEventListener('popstate', cancel)
    window.addEventListener('beforeunload', cancel)
    return () => {
      cancel()
      document.removeEventListener('click', clicked, true)
      window.removeEventListener('popstate', cancel)
      window.removeEventListener('beforeunload', cancel)
    }
  }, [])
  useEffect(() => {
    if (search.has('zoom')) {
      const next = new URLSearchParams(search)
      next.delete('zoom')
      setSearch(next, { replace: true })
    }
  }, [search, setSearch])
  async function connect(id?: string, meetings = false) {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const startedAt = window.location.pathname + window.location.search
    setPending(id ?? (meetings ? 'meetings' : 'connect'))
    setError(null)
    setNotice(null)
    try {
      const { authorizationUrl } = await unwrap(
        meetings
          ? id
            ? api.POST('/api/v1/conference-connections/{id}/authorize-meetings', {
                params: { path: { id } },
                body: {},
                signal: controller.signal,
              })
            : api.POST('/api/v1/conference-connections/zoom/authorize-meetings', {
                body: {},
                signal: controller.signal,
              })
          : id
            ? api.POST('/api/v1/conference-connections/{id}/reconnect', {
                params: { path: { id } },
                body: {},
                signal: controller.signal,
              })
            : api.POST('/api/v1/conference-connections/zoom/authorize', {
                body: {},
                signal: controller.signal,
              }),
      )
      if (
        !mounted.current ||
        controller.signal.aborted ||
        window.location.pathname + window.location.search !== startedAt
      )
        return
      const target = new URL(authorizationUrl)
      if (
        target.origin !== 'https://zoom.us' ||
        target.pathname !== '/oauth/authorize' ||
        target.username ||
        target.password ||
        target.hash
      )
        throw new Error('Invalid Zoom authorization endpoint')
      goTo(target.href)
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) setError(errorMessage(err))
    } finally {
      if (mounted.current) setPending(null)
    }
  }
  async function refresh(id: string) {
    setPending(id)
    setError(null)
    setNotice(null)
    try {
      await unwrap(
        api.POST('/api/v1/conference-connections/{id}/refresh', {
          params: { path: { id } },
          body: {},
        }),
      )
      if (mounted.current) setNotice(msg('Zoom account refreshed.'))
    } catch (err) {
      if (mounted.current) setError(errorMessage(err))
    } finally {
      if (mounted.current) {
        setPending(null)
        reload()
      }
    }
  }
  async function disconnect(id: string) {
    await unwrap(
      api.DELETE('/api/v1/conference-connections/{id}', { params: { path: { id } }, body: {} }),
    )
    if (mounted.current) {
      setNotice(msg('Local Zoom access disconnected.'))
      reload()
    }
  }
  const date = (value: string) =>
    new Intl.DateTimeFormat(formatLocale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      calendar: 'gregory',
    }).format(new Date(value))
  const connectActions =
    state.status === 'ready' && state.data.zoomEnabled ? (
      <div className="form-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={pending !== null || state.data.data.length >= state.data.maximumConnections}
          onClick={() => void connect()}
        >
          {t(pending === 'connect' ? 'Connecting to Zoom…' : 'Connect Zoom')}
        </button>
        {state.data.zoomMeetingsEnabled && (
          <button
            type="button"
            className="button"
            disabled={pending !== null || state.data.data.length >= state.data.maximumConnections}
            onClick={() => void connect(undefined, true)}
          >
            {t(pending === 'meetings' ? 'Connecting to Zoom…' : 'Authorize Zoom meetings')}
          </button>
        )}
      </div>
    ) : undefined
  return (
    <>
      <PageHeader
        title={t('Conference accounts')}
        lede={t(
          'Connect your own Zoom account separately from sign-in and calendars. Identity access and automatic meeting permissions are separate choices.',
        )}
      />
      {state.status === 'ready' && state.data.zoomEnabled && (
        <p className="muted">
          {text(
            state.data.zoomMeetingsEnabled
              ? 'Connect Zoom requests only basic account identity. Authorize Zoom meetings also requests create, read, update and delete meeting access. You choose your own connection when configuring automatic meetings.'
              : 'Connect Zoom requests only basic account identity.',
          )}
        </p>
      )}
      {notice && (
        <p className="alert alert-success" role="status">
          {ui(notice)}
        </p>
      )}
      {error && (
        <p className="alert alert-error" role="alert">
          {ui(error)}
        </p>
      )}
      {state.status === 'loading' && <PageSkeleton label="Loading conference accounts…" />}
      {state.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>{ui(state.message)}</p>
          <button type="button" className="button" onClick={reload}>
            {t('Retry')}
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <>
          {!state.data.zoomEnabled && (
            <p className="alert alert-info" role="status">
              {t('Zoom connections are not configured on this instance.')}
            </p>
          )}
          {state.data.data.length > 0 && connectActions}
          {state.data.zoomEnabled && !state.data.zoomMeetingsEnabled && (
            <p className="muted">
              {t(
                'New automatic Zoom authorization is disabled on this instance. Existing connections reconnect with their saved permissions.',
              )}
            </p>
          )}
          {state.data.zoomEnabled && (
            <p className="muted">
              {t(
                'Connect up to five Zoom identities at once. Disconnecting frees a place and keeps the connection ID for a future reconnection.',
              )}
            </p>
          )}
          {state.data.pendingAttempts > 0 && (
            <p role="status">
              {t(
                'A Zoom authorization attempt is pending. It expires after ten minutes. Starting again replaces the oldest pending attempt when the limit is reached.',
              )}
            </p>
          )}
          {state.data.data.length === 0 && (
            <EmptyState title={t('No Zoom accounts connected.')} action={connectActions}>
              <p>
                {t(
                  state.data.zoomEnabled
                    ? 'Connect a Zoom account to get started.'
                    : 'Ask your administrator to enable Zoom connections.',
                )}
              </p>
            </EmptyState>
          )}
          <div className="card-list">
            {state.data.data.map((connection: Connection) => (
              <article
                className="panel stack conference-account"
                key={connection.id}
                aria-labelledby={`conference-${connection.id}`}
              >
                <h2 id={`conference-${connection.id}`}>
                  {connection.displayName ||
                    (connection.accountEmail ? (
                      <BreakableText>{connection.accountEmail}</BreakableText>
                    ) : (
                      t('Zoom account')
                    ))}
                </h2>
                {connection.accountEmail && connection.displayName && (
                  <p>
                    <BreakableText>{connection.accountEmail}</BreakableText>
                  </p>
                )}
                <p>{t(statusLabels[connection.status])}</p>
                <p>{t(connection.mode === 'meetings' ? 'Meeting permissions' : 'Identity only')}</p>
                <p className="muted">
                  {t('Connection updated')}:{' '}
                  <time dateTime={connection.updatedAt}>{date(connection.updatedAt)}</time>
                </p>
                {connection.lastError && (
                  <p className="alert alert-info" role="status">
                    {ui(
                      msg(
                        outcomes[
                          Object.hasOwn(outcomes, connection.lastError)
                            ? (connection.lastError as keyof typeof outcomes)
                            : 'needs_reauth'
                        ],
                      ),
                    )}
                  </p>
                )}
                <div className="card-actions">
                  {connection.mode === 'identity' && state.data.zoomMeetingsEnabled && (
                    <button
                      type="button"
                      className="button button-small"
                      disabled={!state.data.zoomEnabled || pending !== null}
                      onClick={() => void connect(connection.id, true)}
                    >
                      {t('Authorize Zoom meetings')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="button button-small"
                    disabled={!state.data.zoomEnabled || pending !== null}
                    onClick={() => void connect(connection.id)}
                  >
                    {t(pending === connection.id ? 'Working…' : 'Reconnect Zoom')}
                  </button>
                  <button
                    type="button"
                    className="button button-small"
                    disabled={
                      !state.data.zoomEnabled ||
                      pending !== null ||
                      (connection.status !== 'active' && connection.status !== 'refreshing')
                    }
                    onClick={() => void refresh(connection.id)}
                  >
                    {t('Refresh Zoom account')}
                  </button>
                  {connection.status !== 'disconnected' && (
                    <ConfirmAction
                      label="Disconnect Zoom"
                      prompt="Disconnect local Zoom access? Pending authorization attempts will also be cancelled. Remove the app separately in Zoom to revoke its grant."
                      confirmLabel="Disconnect Zoom"
                      busyLabel="Disconnecting…"
                      failure="Could not disconnect Zoom."
                      onConfirm={() => disconnect(connection.id)}
                    />
                  )}
                </div>
              </article>
            ))}
          </div>
          {(state.data.zoomEnabled || state.data.data.length > 0) && (
            <p className="muted">
              {t(
                'Disconnecting removes local credentials. The retained account record keeps its identity and does not revoke the app in Zoom. Deleting your Hourmere account also removes the stored identity details.',
              )}
            </p>
          )}
        </>
      )}
    </>
  )
}
