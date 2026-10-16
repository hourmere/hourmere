import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import {
  API_KEY_NAME_MAX_LENGTH,
  type ApiKey,
  type CreatedApiKey,
  createApiKey,
  deleteApiKey,
  listApiKeys,
} from '../api/auth.ts'
import { errorMessage } from '../api/errors.ts'
import { CopyButton } from '../components/CopyButton.tsx'
import { useLoad, usePageTitle } from '../hooks.ts'
import { useMe } from '../session.tsx'

const DAY = 24 * 60 * 60

// Better Auth accepts 1 to 365 days.
const EXPIRY_OPTIONS = [
  { value: '', label: 'Never' },
  { value: String(30 * DAY), label: 'In 30 days' },
  { value: String(90 * DAY), label: 'In 90 days' },
  { value: String(365 * DAY), label: 'In 1 year' },
] as const

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

function formatDate(iso: string, format = dateFormat) {
  const date = new Date(iso)
  return (
    <time dateTime={iso} title={dateTimeFormat.format(date)}>
      {format.format(date)}
    </time>
  )
}

/** The command that checks a key works: GET /api/v1/me answers with whom it acts as. */
const curlExample = (key: string) =>
  `curl -H "Authorization: Bearer ${key}" ${window.location.origin}/api/v1/me`

export function ApiKeysPage() {
  usePageTitle('API keys')
  const me = useMe()
  const [keys, reload] = useLoad(listApiKeys)
  const [created, setCreated] = useState<CreatedApiKey | null>(null)

  return (
    <>
      <h1>API keys</h1>
      <p className="lede">
        API keys let AI agents and scripts use Hourmere for you, through the same API as this app. A
        key can do anything you can do in {me.organization.name}, so treat it like a password.
      </p>

      {created ? (
        <NewKey
          apiKey={created}
          onDone={() => {
            setCreated(null)
          }}
        />
      ) : (
        <CreateKeyForm
          onCreated={(key) => {
            setCreated(key)
            reload()
          }}
        />
      )}

      <section aria-labelledby="keys-heading">
        <h2 id="keys-heading">Your keys</h2>
        {keys.status === 'loading' && <p role="status">Loading keys…</p>}
        {keys.status === 'error' && (
          <div className="alert alert-error" role="alert">
            <p>Could not load your keys. {keys.message}</p>
            <button type="button" className="button button-small" onClick={reload}>
              Try again
            </button>
          </div>
        )}
        {keys.status === 'ready' &&
          (keys.data.length === 0 ? (
            <p className="muted">You have no API keys yet.</p>
          ) : (
            <KeyTable keys={keys.data} onRevoked={reload} />
          ))}
      </section>

      <section aria-labelledby="usage-heading">
        <h2 id="usage-heading">Using a key</h2>
        <p>
          Send the key as a bearer token. For example, this shows which account and organization a
          key acts for:
        </p>
        <div className="code-block">
          <pre>
            <code>{curlExample('hm_…')}</code>
          </pre>
          <CopyButton text={curlExample('hm_…')} label="Copy command" />
        </div>
        <p>
          The API is described in its <a href="/api/v1/openapi.json">OpenAPI document</a>.
        </p>
      </section>
    </>
  )
}

function CreateKeyForm({ onCreated }: { onCreated: (key: CreatedApiKey) => void }) {
  const [name, setName] = useState('')
  const [expiresIn, setExpiresIn] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameHint = useId()

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      onCreated(await createApiKey(name.trim(), expiresIn ? Number(expiresIn) : null))
    } catch (err) {
      setError(`Could not create the key. ${errorMessage(err)}`)
      setCreating(false)
    }
  }

  return (
    <section aria-labelledby="create-heading" className="panel">
      <h2 id="create-heading">Create a key</h2>
      <form className="form-row" onSubmit={submit}>
        <div className="field">
          <label htmlFor="key-name">Name</label>
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
            Where the key will be used, e.g. “Claude Desktop”.
          </p>
        </div>
        <div className="field">
          <label htmlFor="key-expiry">Expires</label>
          <select id="key-expiry" value={expiresIn} onChange={(e) => setExpiresIn(e.target.value)}>
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="button button-primary" disabled={creating}>
          {creating ? 'Creating…' : 'Create key'}
        </button>
      </form>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** The new key's secret, shown this once: Better Auth stores only a hash of it. */
function NewKey({ apiKey, onDone }: { apiKey: CreatedApiKey; onDone: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])

  return (
    <section aria-labelledby="new-key-heading" className="panel panel-success">
      <h2 id="new-key-heading" ref={heading} tabIndex={-1}>
        Copy your new key “{apiKey.name}”
      </h2>
      <p>
        <strong>You won’t be able to see this key again.</strong> Store it somewhere safe, such as a
        password manager or your agent’s secret settings. If you lose it, revoke it and create a new
        one.
      </p>
      <div className="secret">
        <label htmlFor="new-key-value" className="visually-hidden">
          New API key
        </label>
        <input
          id="new-key-value"
          className="mono"
          readOnly
          value={apiKey.key}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
        />
        <CopyButton text={apiKey.key} label="Copy key" />
      </div>
      <p>Check that it works:</p>
      <div className="code-block">
        <pre>
          <code>{curlExample(apiKey.key)}</code>
        </pre>
        <CopyButton text={curlExample(apiKey.key)} label="Copy command" />
      </div>
      <button type="button" className="button button-primary" onClick={onDone}>
        I’ve saved my key
      </button>
    </section>
  )
}

function KeyTable({ keys, onRevoked }: { keys: ApiKey[]; onRevoked: () => void }) {
  const now = Date.now()
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Key</th>
          <th scope="col">Created</th>
          <th scope="col">Last used</th>
          <th scope="col">Expires</th>
          <th scope="col">
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => (
          <tr key={key.id}>
            <th scope="row" data-label="Name">
              {key.name || <span className="muted">Unnamed</span>}
              {!key.enabled && <span className="badge">Disabled</span>}
            </th>
            <td data-label="Key">
              <code>{key.start ? `${key.start}…` : '…'}</code>
            </td>
            <td data-label="Created">{formatDate(key.createdAt)}</td>
            <td data-label="Last used">
              {key.lastRequest ? (
                formatDate(key.lastRequest, dateTimeFormat)
              ) : (
                <span className="muted">Never</span>
              )}
            </td>
            <td data-label="Expires">
              {key.expiresAt === null ? (
                <span className="muted">Never</span>
              ) : (
                <>
                  {new Date(key.expiresAt).getTime() <= now && (
                    <span className="badge badge-danger">Expired</span>
                  )}
                  {formatDate(key.expiresAt)}
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
function RevokeButton({ apiKey, onRevoked }: { apiKey: ApiKey; onRevoked: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
      onRevoked()
    } catch (err) {
      setError(`Could not revoke the key. ${errorMessage(err)}`)
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
        aria-label={`Revoke ${label}`}
      >
        Revoke
      </button>
    )
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring form styling for two buttons
    <div className="confirm" role="group" aria-labelledby={promptId}>
      <p id={promptId}>
        Revoke “{label}”? Anything using it stops working at once. This cannot be undone.
      </p>
      <div className="confirm-buttons">
        <button
          type="button"
          className="button button-small button-danger"
          onClick={revoke}
          disabled={revoking}
        >
          {revoking ? 'Revoking…' : 'Revoke key'}
        </button>
        <button
          ref={cancel}
          type="button"
          className="button button-small"
          onClick={() => setConfirming(false)}
          disabled={revoking}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
