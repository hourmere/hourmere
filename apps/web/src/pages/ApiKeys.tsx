import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import {
  API_KEY_NAME_MAX_LENGTH,
  type ApiKey,
  type CreatedApiKey,
  createApiKey,
  deleteApiKey,
  listApiKeys,
  listOrganizations,
} from '../api/auth.ts'
import { errorMessage, RequestError } from '../api/errors.ts'
import { CopyButton } from '../components/CopyButton.tsx'
import { useLoad, usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { msg, type UiText } from '../i18n/translate.ts'
import { type Me, useMe, useSession } from '../session.tsx'

const DAY = 24 * 60 * 60

// Better Auth accepts 1 to 365 days.
const EXPIRY_OPTIONS = [
  { value: '', label: 'Never' },
  { value: String(30 * DAY), label: 'In 30 days' },
  { value: String(90 * DAY), label: 'In 90 days' },
  { value: String(365 * DAY), label: 'In 1 year' },
] as const

function formatDate(iso: string, locale: string, withTime = false) {
  const date = new Date(iso)
  const full = new Intl.DateTimeFormat(locale, {
    calendar: 'gregory',
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const format = withTime
    ? full
    : new Intl.DateTimeFormat(locale, { calendar: 'gregory', dateStyle: 'medium' })
  return (
    <time dateTime={iso} title={full.format(date)}>
      {format.format(date)}
    </time>
  )
}

/** The keys, and the names of the organizations they act in (by id). */
async function loadKeys(signal: AbortSignal) {
  const [keys, organizations] = await Promise.all([listApiKeys(signal), listOrganizations(signal)])
  return { keys, organizations: new Map(organizations.map((o) => [o.id, o.name])) }
}

/** The command that checks a key works: GET /api/v1/me answers with whom it acts as. */
const curlExample = (key: string) =>
  `curl -H "Authorization: Bearer ${key}" ${window.location.origin}/api/v1/me`

export function ApiKeysPage() {
  const { t, ui } = useI18n()

  usePageTitle('API keys')
  const me = useMe()
  const [keys, reload] = useLoad(loadKeys)
  const [created, setCreated] = useState<CreatedApiKey | null>(null)
  const [status, setStatus] = useState<UiText>('')
  const keysHeading = useRef<HTMLHeadingElement>(null)

  return (
    <>
      <h1>{t('API keys')}</h1>
      <p className="lede">
        {t(
          'API keys let AI agents and scripts use Hourmere for you, through the same API as this app. Each key acts in one organization and can do anything you can do there, so treat it like a password.',
        )}
      </p>

      {created ? (
        <NewKey
          apiKey={created}
          onDone={() => {
            setCreated(null)
            // The panel (and the focused button) goes away; the new key is in the list.
            keysHeading.current?.focus()
          }}
        />
      ) : (
        <CreateKeyForm
          organization={me.organization}
          onCreated={(key) => {
            setStatus('')
            setCreated(key)
            reload()
          }}
        />
      )}

      <section aria-labelledby="keys-heading">
        <h2 id="keys-heading" ref={keysHeading} tabIndex={-1}>
          {t('Your keys')}
        </h2>
        <p className="copy-status" role="status">
          {ui(status)}
        </p>
        {keys.status === 'loading' && <p role="status">{t('Loading keys…')}</p>}
        {keys.status === 'error' && (
          <div className="alert alert-error" role="alert">
            <p>
              {t('Could not load your keys.')} {ui(keys.message)}
            </p>
            <button type="button" className="button button-small" onClick={reload}>
              {t('Try again')}
            </button>
          </div>
        )}
        {keys.status === 'ready' &&
          (keys.data.keys.length === 0 ? (
            <p className="muted">{t('You have no API keys yet.')}</p>
          ) : (
            <KeyTable
              keys={keys.data.keys}
              organizations={keys.data.organizations}
              onRevoked={(key) => {
                setStatus(msg('Revoked “{0}”.', { '0': key.name || key.start || 'the key' }))
                reload()
                // Its row (and the focused button) goes away.
                keysHeading.current?.focus()
              }}
            />
          ))}
      </section>

      <section aria-labelledby="usage-heading">
        <h2 id="usage-heading">{t('Using a key')}</h2>
        <p>
          {t(
            'Send the key as a bearer token. For example, this shows which account and organization a key acts for:',
          )}
        </p>
        <div className="code-block">
          <pre>
            <code>{curlExample('hm_…')}</code>
          </pre>
          <CopyButton text={curlExample('hm_…')} label={t('Copy command')} />
        </div>
        <p>
          {t('The API is described in its')}{' '}
          <a href="/api/v1/openapi.json">{t('OpenAPI document')}</a>.
        </p>
      </section>
    </>
  )
}

function CreateKeyForm({
  organization,
  onCreated,
}: {
  /** The organization the person is working in (GET /api/v1/me); new keys act in it. */
  organization: Me['organization']
  onCreated: (key: CreatedApiKey) => void
}) {
  const { t, ui } = useI18n()

  const [name, setName] = useState('')
  const [expiresIn, setExpiresIn] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<UiText | null>(null)
  const nameHint = useId()
  const { refresh, setNotice } = useSession()
  // This page's address, kept by the handlers below even if the person has left meanwhile.
  const { pathname } = useLocation()

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      onCreated(
        await createApiKey(name.trim(), expiresIn ? Number(expiresIn) : null, organization.id),
      )
    } catch (err) {
      // Null when the page starts over in another organization (and says why).
      const message = await createErrorMessage(err)
      setError(message)
      setCreating(false)
    }
  }

  /**
   * A 403 other than an unverified email means the organization was not one the person
   * belongs to (any more): they may have left it, or switched organizations in another tab.
   * Ask who they are now. If the organization changed, the page starts over in the new one
   * (this form goes away), so the explanation goes to the session's notice instead.
   */
  async function createErrorMessage(err: unknown): Promise<UiText | null> {
    if (!(err instanceof RequestError) || err.status !== 403 || err.code === 'EMAIL_NOT_VERIFIED') {
      return msg('Could not create the key. {0}', { '0': errorMessage(err) })
    }
    const now = await refresh()
    if (now && now.organization.id !== organization.id) {
      setNotice({
        message: msg(
          "You're no longer a member of {0}, so no key was created. Keys you create now act in {1}.",
          { '0': organization.name, '1': now.organization.name },
        ),
        path: pathname,
      })
      return null
    }
    return msg("Could not create the key: you can't create keys in {0}.", {
      '0': organization.name,
    })
  }

  return (
    <section aria-labelledby="create-heading" className="panel">
      <h2 id="create-heading">{t('Create a key')}</h2>
      <p>
        {t('The key will act in')} <strong>{organization.name}</strong>
        {organization.personal && t(', your personal organization')}.
      </p>
      <form className="form-row" onSubmit={submit}>
        <div className="field">
          <label htmlFor="key-name">{t('Name')}</label>
          <input
            id="key-name"
            required
            maxLength={API_KEY_NAME_MAX_LENGTH}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-describedby={nameHint}
            autoComplete="off"
          />
          <p id={nameHint} className="hint">
            {t('Where the key will be used, e.g. “Claude Desktop”.')}
          </p>
        </div>
        <div className="field">
          <label htmlFor="key-expiry">{t('Expires')}</label>
          <select id="key-expiry" value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)}>
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {ui(o.label)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="button button-primary" disabled={creating}>
          {creating ? t('Creating…') : t('Create key')}
        </button>
      </form>
      {error && (
        <p className="alert alert-error" role="alert">
          {ui(error)}
        </p>
      )}
    </section>
  )
}

/** The new key's secret, shown this once: Better Auth stores only a hash of it. */
function NewKey({ apiKey, onDone }: { apiKey: CreatedApiKey; onDone: () => void }) {
  const { t } = useI18n()

  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])

  return (
    <section aria-labelledby="new-key-heading" className="panel panel-success">
      <h2 id="new-key-heading" ref={heading} tabIndex={-1}>
        {t('Copy your new key “')}
        {apiKey.name}”
      </h2>
      <p>
        <strong>{t('You won’t be able to see this key again.')}</strong>{' '}
        {t(
          'Store it somewhere safe, such as a password manager or your agent’s secret settings. If you lose it, revoke it and create a new one.',
        )}
      </p>
      <div className="secret">
        <label htmlFor="new-key-value" className="visually-hidden">
          {t('New API key')}
        </label>
        <input
          id="new-key-value"
          className="mono"
          readOnly
          value={apiKey.key}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
        />
        <CopyButton text={apiKey.key} label={t('Copy key')} />
      </div>
      <p>{t('Check that it works:')}</p>
      <div className="code-block">
        <pre>
          <code>{curlExample(apiKey.key)}</code>
        </pre>
        <CopyButton text={curlExample(apiKey.key)} label={t('Copy command')} />
      </div>
      <button type="button" className="button button-primary" onClick={onDone}>
        {t('I’ve saved my key')}
      </button>
    </section>
  )
}

/** The name of the organization a key acts in. */
function organizationOf(
  apiKey: ApiKey,
  organizations: ReadonlyMap<string, string>,
  t: ReturnType<typeof useI18n>['t'],
) {
  const id = apiKey.metadata?.organizationId
  // Keys made before the server stored an organization on every key act in the personal one.
  if (typeof id !== 'string') return <span className="muted">{t('Personal organization')}</span>
  // A key stops working when its owner leaves the organization.
  return (
    organizations.get(id) ?? <span className="muted">{t('An organization you have left')}</span>
  )
}

function KeyTable({
  keys,
  organizations,
  onRevoked,
}: {
  keys: ApiKey[]
  /** Organization names by id. */
  organizations: ReadonlyMap<string, string>
  onRevoked: (key: ApiKey) => void
}) {
  const { t, locale: displayLocale } = useI18n()

  const now = Date.now()
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">{t('Name')}</th>
          <th scope="col">{t('Key')}</th>
          <th scope="col">{t('Organization')}</th>
          <th scope="col">{t('Created')}</th>
          <th scope="col">{t('Last used')}</th>
          <th scope="col">{t('Expires')}</th>
          <th scope="col">
            <span className="visually-hidden">{t('Actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => (
          <tr key={key.id}>
            <th scope="row" data-label={t('Name')}>
              {key.name || <span className="muted">{t('Unnamed')}</span>}
              {!key.enabled && <span className="badge">{t('Disabled')}</span>}
            </th>
            <td data-label={t('Key')}>
              <code>{key.start ? `${key.start}…` : '…'}</code>
            </td>
            <td data-label={t('Organization')}>{organizationOf(key, organizations, t)}</td>
            <td data-label={t('Created')}>{formatDate(key.createdAt, displayLocale)}</td>
            <td data-label={t('Last used')}>
              {key.lastRequest ? (
                formatDate(key.lastRequest, displayLocale, true)
              ) : (
                <span className="muted">{t('Never')}</span>
              )}
            </td>
            <td data-label={t('Expires')}>
              {key.expiresAt === null ? (
                <span className="muted">{t('Never')}</span>
              ) : (
                <>
                  {new Date(key.expiresAt).getTime() <= now && (
                    <span className="badge badge-danger">{t('Expired')}</span>
                  )}
                  {formatDate(key.expiresAt, displayLocale)}
                </>
              )}
            </td>
            <td className="actions">
              <RevokeButton apiKey={key} onRevoked={onRevoked} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Revoking asks for confirmation in place: the button turns into Revoke / Cancel. */
function RevokeButton({ apiKey, onRevoked }: { apiKey: ApiKey; onRevoked: (key: ApiKey) => void }) {
  const { t, ui } = useI18n()

  const [confirming, setConfirming] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [error, setError] = useState<UiText | null>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const start = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  const label = apiKey.name || apiKey.start || 'this key'
  const promptId = useId()

  // Focus follows the swap: to Cancel when asked, back to Revoke when cancelled.
  useEffect(() => {
    if (confirming) cancel.current?.focus()
    else if (wasConfirming.current) start.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  async function revoke() {
    setRevoking(true)
    setError(null)
    try {
      await deleteApiKey(apiKey.id)
      onRevoked(apiKey)
    } catch (err) {
      setError(msg('Could not revoke the key. {0}', { '0': errorMessage(err) }))
      setRevoking(false)
    }
  }

  if (!confirming) {
    return (
      <button
        ref={start}
        type="button"
        className="button button-small"
        onClick={() => setConfirming(true)}
        aria-label={t('Revoke {0}', { '0': label })}
      >
        {t('Revoke')}
      </button>
    )
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring form styling for two buttons
    <div
      className="confirm"
      role="group"
      aria-labelledby={promptId}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !revoking) {
          e.stopPropagation()
          setConfirming(false)
        }
      }}
    >
      <p id={promptId}>
        {t('Revoke “')}
        {label}
        {t('”? Anything using it stops working at once. This cannot be undone.')}
      </p>
      <div className="confirm-buttons">
        <button
          type="button"
          className="button button-small button-danger"
          onClick={revoke}
          disabled={revoking}
        >
          {revoking ? t('Revoking…') : t('Revoke key')}
        </button>
        <button
          ref={cancel}
          type="button"
          className="button button-small"
          onClick={() => setConfirming(false)}
          disabled={revoking}
        >
          {t('Cancel')}
        </button>
      </div>
      {error && (
        <p className="alert alert-error" role="alert">
          {ui(error)}
        </p>
      )}
    </div>
  )
}
