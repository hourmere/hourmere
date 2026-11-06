import { type FormEvent, useCallback, useState } from 'react'
import { useLocation } from 'react-router'
import { api, unwrap } from '../api/client.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { CopyButton } from '../components/CopyButton.tsx'
import { useLoad, useMounted } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'

const loadInstance = (signal: AbortSignal) => unwrap(api.GET('/api/v1/instance', { signal }))

export function ProvisioningTokens({
  organizationId,
  role,
}: {
  organizationId: string
  role: string | null
}) {
  const [instance] = useLoad(loadInstance)
  const location = useLocation()
  if (
    instance.status !== 'ready' ||
    instance.data.scimProvisioningEnabled !== true ||
    !role?.split(',').some((value) => ['owner', 'admin'].includes(value.trim()))
  )
    return null
  // A navigation or organization change destroys the one-time secret and pending work.
  return (
    <TokenPanel key={`${organizationId}:${location.key}:${role}`} organizationId={organizationId} />
  )
}

function TokenPanel({ organizationId }: { organizationId: string }) {
  const { t } = useI18n()
  const mounted = useMounted()
  const load = useCallback(
    (signal: AbortSignal) =>
      unwrap(
        api.GET('/api/v1/organizations/{organizationId}/provisioning-tokens', {
          params: { path: { organizationId } },
          signal,
        }),
      ),
    [organizationId],
  )
  const [tokens, reload] = useLoad(load)
  const [name, setName] = useState('')
  const [secret, setSecret] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    id: string
    name: string
    action: 'rotate' | 'revoke'
  } | null>(null)

  async function create(event: FormEvent) {
    event.preventDefault()
    if (busy || !name.trim()) return
    setBusy(true)
    setFailed(false)
    setSecret(null)
    try {
      const result = await unwrap(
        api.POST('/api/v1/organizations/{organizationId}/provisioning-tokens', {
          params: {
            path: { organizationId },
            header: { 'x-expected-organization-id': organizationId },
          },
          body: { name: name.trim() },
        }),
      )
      if (!mounted.current) return
      setSecret(result.secret)
      setName('')
      reload()
    } catch {
      if (mounted.current) {
        setFailed(true)
        reload()
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function change() {
    if (!confirmation || busy) return
    setBusy(true)
    setFailed(false)
    setSecret(null)
    try {
      const params = {
        path: { organizationId, id: confirmation.id },
        header: { 'x-expected-organization-id': organizationId },
      }
      if (confirmation.action === 'rotate') {
        const result = await unwrap(
          api.POST('/api/v1/organizations/{organizationId}/provisioning-tokens/{id}/rotate', {
            params,
            body: { overlapSeconds: 3600 },
          }),
        )
        if (!mounted.current) return
        setSecret(result.secret)
      } else {
        await unwrap(
          api.DELETE('/api/v1/organizations/{organizationId}/provisioning-tokens/{id}', {
            params,
          }),
        )
        if (!mounted.current) return
      }
      setConfirmation(null)
      reload()
    } catch {
      if (mounted.current) {
        setFailed(true)
        reload()
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section className="panel stack" aria-labelledby="scim-heading">
      <h2 id="scim-heading">{t('SCIM provisioning tokens')}</h2>
      <p>
        {t(
          'Provisioning is not available yet. These tokens prepare your organization for a future SCIM connection.',
        )}
      </p>
      <p className="hint">
        {t('Tokens only authorize SCIM for this organization. Keep them private.')}
      </p>
      {failed && (
        <p role="alert">
          {t('Could not update provisioning tokens. Check the token list before trying again.')}
        </p>
      )}
      {secret && (
        <section className="alert alert-info stack" aria-label={t('New provisioning token')}>
          <p>
            {t(
              'Copy this token now. It will not be shown again after you dismiss it or leave this view.',
            )}
          </p>
          <code className="user-content">
            <BreakableText>{secret}</BreakableText>
          </code>
          <CopyButton text={secret} label="Copy token" />
          <button className="button" type="button" onClick={() => setSecret(null)}>
            {t('Dismiss token')}
          </button>
        </section>
      )}
      <form onSubmit={(event) => void create(event)} className="stack">
        <label htmlFor="scim-token-name">{t('Provisioning token name')}</label>
        <input
          id="scim-token-name"
          autoComplete="off"
          maxLength={100}
          required
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <div>
          <button className="button button-primary" type="submit" disabled={busy || !name.trim()}>
            {t('Create provisioning token')}
          </button>
        </div>
      </form>
      {tokens.status === 'loading' && <p role="status">{t('Loading provisioning tokens…')}</p>}
      {tokens.status === 'error' && (
        <div role="alert">
          <p>{t('Could not load provisioning tokens.')}</p>
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {tokens.status === 'ready' &&
        (tokens.data.tokens.length === 0 ? (
          <p>{t('No provisioning tokens.')}</p>
        ) : (
          <ul className="stack">
            {tokens.data.tokens.map((token) => (
              <li key={token.id}>
                <span className="user-content">
                  <BreakableText>{token.name}</BreakableText>
                </span>
                <p className="hint">
                  {token.revokedAt
                    ? t('Revoked')
                    : token.previousValidUntil
                      ? t('Previous token valid until: {date}', { date: token.previousValidUntil })
                      : t('Active')}
                </p>
                <p className="hint">
                  {token.lastUsedAt
                    ? t('Last used: {date}', { date: token.lastUsedAt })
                    : t('Never used')}
                </p>
                {!token.revokedAt && (
                  <div className="form-actions">
                    <button
                      type="button"
                      className="button button-small"
                      disabled={busy}
                      onClick={() =>
                        setConfirmation({ id: token.id, name: token.name, action: 'rotate' })
                      }
                    >
                      {t('Rotate token')}
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      disabled={busy}
                      onClick={() =>
                        setConfirmation({ id: token.id, name: token.name, action: 'revoke' })
                      }
                    >
                      {t('Revoke token')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ))}
      {confirmation && (
        <section className="alert alert-info stack" aria-label={t('Confirm token change')}>
          <p className="user-content">
            <BreakableText>{confirmation.name}</BreakableText>
          </p>
          <p>
            {confirmation.action === 'rotate'
              ? t(
                  'The old token will remain valid for one hour. Update your identity provider with the new token during this time. You cannot rotate again until the overlap ends.',
                )
              : t(
                  'Revoking this token stops access for both the current token and its previous version immediately. This cannot be undone.',
                )}
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => void change()}
            >
              {t('Confirm token change')}
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              {t('Cancel')}
            </button>
          </div>
        </section>
      )}
    </section>
  )
}
