import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { api, type Schemas, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import type { EventType } from '../../api/resources.ts'
import { ConfirmAction } from '../../components/ConfirmAction.tsx'
import { CopyButton } from '../../components/CopyButton.tsx'
import { Field } from '../../components/forms.tsx'
import { useLoad, useMounted } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { randomHex } from '../../random.ts'
import { useMe, useSession } from '../../session.tsx'
import { ONE_TIME_LINK_EXPIRIES } from './one-time-link-options.ts'

type Link = Schemas['OneTimeBookingLink']

const STATE_LABELS: Record<Link['state'], MessageKey> = {
  active: 'Active',
  used: 'Used',
  expired: 'Expired',
  revoked: 'Revoked',
}

/** Deliberately project metadata: a creation response must never enter the list whole. */
export function oneTimeLinkMetadata(link: Link): Link {
  return {
    id: link.id,
    organizationId: link.organizationId,
    eventTypeId: link.eventTypeId,
    creatorUserId: link.creatorUserId,
    creatorDisplayName: link.creatorDisplayName,
    expiresAt: link.expiresAt,
    prefill: { name: link.prefill.name, email: link.prefill.email },
    state: link.state,
    bookingId: link.bookingId,
    usedAt: link.usedAt,
    revokedAt: link.revokedAt,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  }
}

/** Server prose is intentionally never reflected into this capability-handling surface. */
export function oneTimeLinkError(error: unknown): MessageKey {
  if (isOrganizationContextChanged(error))
    return 'Your team context changed. Reload before making changes.'
  if (error instanceof RequestError) {
    if (error.code === 'one_time_link_limit_reached')
      return 'Your space has reached its active one-time link limit. Revoke an unused link and try again.'
    if (error.code === 'event_type_inactive')
      return 'Enable and save this event type before creating a one-time link.'
    if (error.code === 'one_time_link_already_created')
      return 'This request already created a link, but its URL cannot be retrieved. Review the list and revoke it if needed, then start a new request.'
    if (error.code === 'invalid_one_time_link' || error.code === 'invalid_request')
      return 'Check the expiry and invitee details, then try again.'
    if (error.status === 403) return 'One-time links are unavailable with your current permissions.'
  }
  return 'Could not update one-time links. Try again.'
}

/** Opening is explicit, so merely editing an event does not fetch private link history. */
export function OneTimeLinks({ event, disabled }: { event: EventType; disabled: boolean }) {
  const { t } = useI18n()
  const me = useMe()
  const [expanded, setExpanded] = useState(false)
  const heading = useId()
  const content = useId()
  return (
    <section className="panel" aria-labelledby={heading}>
      <h2 id={heading}>{t('One-time links')}</h2>
      <p>
        {t(
          'Create a private link that can be used for one booking. Each new URL is shown only once.',
        )}
      </p>
      {!me.organization.personal && event.ownerUserId === null && (
        <p className="hint">
          {t('These links belong to the team and remain with it when their creator leaves.')}
        </p>
      )}
      {disabled ? (
        <p role="status">{t('Your team context changed. Reload before making changes.')}</p>
      ) : (
        <>
          <button
            type="button"
            className="button button-small"
            aria-expanded={expanded}
            aria-controls={content}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? t('Close one-time links') : t('Manage one-time links')}
          </button>
          {expanded && (
            <div id={content}>
              <OneTimeLinkManager key={`${me.organization.id}:${event.id}`} event={event} />
            </div>
          )}
        </>
      )}
    </section>
  )
}

function OneTimeLinkManager({ event }: { event: EventType }) {
  const { t, locale } = useI18n()
  const me = useMe()
  const { confirmReload } = useSession()
  const [organizationId] = useState(me.organization.id)
  const headers = { 'X-Expected-Organization-Id': organizationId }
  const mounted = useMounted()
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        return await unwrap(
          api.GET('/api/v1/event-types/{eventTypeId}/one-time-links', {
            params: { path: { eventTypeId: event.id }, query: { limit: 25 } },
            signal,
          }),
        )
      } catch {
        // useLoad normally translates server messages; here keep a fixed, neutral message.
        throw new RequestError(503, undefined, '')
      }
    },
    [event.id],
  )
  const [links, reload] = useLoad(load)
  const [extra, setExtra] = useState<Link[]>([])
  const [nextAfter, setNextAfter] = useState<string | null | undefined>(undefined)
  const [recent, setRecent] = useState<Link[]>([])
  const [expiry, setExpiry] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [createdUrl, setCreatedUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [paging, setPaging] = useState(false)
  const [contextChanged, setContextChanged] = useState(false)
  const [unrecoverable, setUnrecoverable] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)
  const [status, setStatus] = useState<MessageKey | null>(null)
  const createButton = useRef<HTMLButtonElement>(null)
  const listHeading = useRef<HTMLHeadingElement>(null)
  const attempt = useRef<{
    fingerprint: string
    key: string
    body: { expiresAt?: string; prefill?: { name?: string; email?: string } }
  } | null>(null)
  const loaded = links.status === 'ready' ? links.data.data : []
  const visible = [
    ...recent,
    ...loaded.filter((link) => !recent.some((item) => item.id === link.id)),
    ...extra.filter((link) => !recent.some((item) => item.id === link.id)),
  ]
  const cursor =
    nextAfter === undefined && links.status === 'ready' ? links.data.nextAfter : nextAfter

  function failure(err: unknown) {
    setError(oneTimeLinkError(err))
    if (err instanceof RequestError && err.code === 'one_time_link_already_created') {
      setUnrecoverable(true)
      setExtra([])
      setNextAfter(undefined)
      reload()
    }
    if (isOrganizationContextChanged(err)) {
      setCreatedUrl(null)
      setContextChanged(true)
    }
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy || contextChanged) return
    setError(null)
    setStatus(null)
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Check the expiry and invitee details, then try again.')
      return
    }
    const fingerprint = JSON.stringify([expiry, name.trim(), email.trim()])
    if (attempt.current?.fingerprint !== fingerprint) {
      const prefill = {
        ...(name.trim() && { name: name.trim() }),
        ...(email.trim() && { email: email.trim() }),
      }
      attempt.current = {
        fingerprint,
        key: randomHex(16),
        body: {
          ...(expiry && {
            expiresAt: new Date(Date.now() + Number(expiry) * 3_600_000).toISOString(),
          }),
          ...(Object.keys(prefill).length > 0 && { prefill }),
        },
      }
    }
    setBusy(true)
    try {
      const created = await unwrap(
        api.POST('/api/v1/event-types/{eventTypeId}/one-time-links', {
          params: { path: { eventTypeId: event.id } },
          body: attempt.current.body,
          headers: { ...headers, 'Idempotency-Key': attempt.current.key },
        }),
      )
      if (!mounted.current) return
      setRecent((items) => [oneTimeLinkMetadata(created), ...items])
      setCreatedUrl(created.url)
      attempt.current = null
      setName('')
      setEmail('')
    } catch (err) {
      if (mounted.current) failure(err)
    }
    if (mounted.current) setBusy(false)
  }

  async function more() {
    if (!cursor || paging) return
    setPaging(true)
    setError(null)
    try {
      const page = await unwrap(
        api.GET('/api/v1/event-types/{eventTypeId}/one-time-links', {
          params: { path: { eventTypeId: event.id }, query: { limit: 25, after: cursor } },
        }),
      )
      if (!mounted.current) return
      setExtra((items) => [...items, ...page.data.map(oneTimeLinkMetadata)])
      setNextAfter(page.nextAfter)
    } catch (err) {
      if (mounted.current) failure(err)
    }
    if (mounted.current) setPaging(false)
  }

  async function revoke(id: string) {
    setError(null)
    try {
      const link = await unwrap(
        api.DELETE('/api/v1/event-types/{eventTypeId}/one-time-links/{id}', {
          params: { path: { eventTypeId: event.id, id } },
          headers,
        }),
      )
      if (!mounted.current) return
      if (link) {
        setRecent((items) => [oneTimeLinkMetadata(link), ...items.filter((item) => item.id !== id)])
        setStatus(
          link.state === 'used'
            ? 'This link was already used. Its booking is unchanged.'
            : link.state === 'revoked'
              ? 'Link revoked.'
              : 'This link is no longer active.',
        )
      } else {
        setRecent((items) => items.filter((item) => item.id !== id))
        setExtra([])
        setNextAfter(undefined)
        reload()
      }
      listHeading.current?.focus()
    } catch (err) {
      if (mounted.current) failure(err)
    }
  }

  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    )

  return (
    <>
      {contextChanged && (
        <button type="button" className="button button-small" onClick={confirmReload}>
          {t('Reload')}
        </button>
      )}
      <form className="one-time-link-form" onSubmit={create} noValidate>
        <fieldset disabled={busy || contextChanged}>
          <legend>{t('Create a one-time link')}</legend>
          <Field
            id="one-time-expiry"
            label={t('Link expiry')}
            optional
            hint={t('A day is exactly 24 hours, including daylight-saving changes.')}
          >
            {(props) => (
              <select {...props} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {ONE_TIME_LINK_EXPIRIES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.label)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="form-grid">
            <Field id="one-time-name" label={t('Prefilled invitee name')} optional>
              {(props) => (
                <input
                  {...props}
                  value={name}
                  maxLength={200}
                  autoComplete="off"
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <Field id="one-time-email" label={t('Prefilled invitee email')} optional>
              {(props) => (
                <input
                  {...props}
                  type="email"
                  value={email}
                  maxLength={254}
                  autoComplete="off"
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
          </div>
          <p className="hint">
            {t('Invitees can edit these details. Prefill does not restrict who can book.')}
          </p>
          <button
            ref={createButton}
            type="submit"
            className="button button-primary"
            disabled={!event.isActive || unrecoverable}
          >
            {busy ? t('Creating…') : t('Create one-time link')}
          </button>
          {!event.isActive && (
            <p>{t('Enable and save this event type before creating a one-time link.')}</p>
          )}
        </fieldset>
      </form>
      {error && (
        <p className="alert alert-error" role="alert">
          {t(error)}
        </p>
      )}
      {unrecoverable && !contextChanged && (
        <p>
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              attempt.current = null
              setUnrecoverable(false)
              setError(null)
            }}
          >
            {t('Start a new request')}
          </button>
        </p>
      )}
      <p role="status">{status && t(status)}</p>
      <h3 ref={listHeading} tabIndex={-1}>
        {t('Existing one-time links')}
      </h3>
      <p className="hint">
        {t(
          'URLs cannot be retrieved from this list. Revoke an unused link if you no longer need it.',
        )}
      </p>
      {links.status === 'loading' && <p role="status">{t('Loading…')}</p>}
      {links.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>{t('Could not load one-time links. Your access may have changed.')}</p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {links.status === 'ready' && visible.length === 0 && (
        <p className="empty">
          {t('No one-time links yet. Create one above to share this event privately.')}
        </p>
      )}
      <ul className="card-list one-time-links-list">
        {visible.map((link) => (
          <li key={link.id} className="card-item">
            <div className="card-main">
              <h4 className="card-title">
                {link.prefill.name || link.prefill.email || t('One-time link')}
                <span className={`badge${link.state === 'active' ? ' badge-success' : ''}`}>
                  {t(STATE_LABELS[link.state])}
                </span>
              </h4>
              {link.prefill.name && link.prefill.email && <p>{link.prefill.email}</p>}
              <dl className="details">
                <dt>{t('Link ID')}</dt>
                <dd>
                  <code>{link.id}</code>
                </dd>
                <dt>{t('Event type')}</dt>
                <dd>{event.title}</dd>
                <dt>{t('Created')}</dt>
                <dd>
                  <time dateTime={link.createdAt}>{formatDate(link.createdAt)}</time>
                </dd>
                <dt>{t('Created by')}</dt>
                <dd>{link.creatorDisplayName || t('Unknown member')}</dd>
                <dt>{t('Link expiry')}</dt>
                <dd>
                  {link.expiresAt ? (
                    <time dateTime={link.expiresAt}>{formatDate(link.expiresAt)}</time>
                  ) : (
                    t('Never')
                  )}
                </dd>
                {link.usedAt && (
                  <>
                    <dt>{t('Used at')}</dt>
                    <dd>
                      <time dateTime={link.usedAt}>{formatDate(link.usedAt)}</time>
                    </dd>
                  </>
                )}
                {link.bookingId && (
                  <>
                    <dt>{t('Booking reference')}</dt>
                    <dd>
                      <code>{link.bookingId}</code>
                    </dd>
                  </>
                )}
              </dl>
            </div>
            {link.state === 'active' && !contextChanged && (
              <ConfirmAction
                label={t('Revoke link')}
                accessibleLabel={t('Revoke one-time link {0}', { '0': link.id })}
                prompt={t('Revoke this one-time link? It will stop accepting new bookings.')}
                confirmLabel={t('Revoke link')}
                busyLabel={t('Revoking…')}
                failure={t('Could not update one-time links. Try again.')}
                onConfirm={() => revoke(link.id)}
              />
            )}
          </li>
        ))}
      </ul>
      {cursor && (
        <p>
          <button type="button" className="button button-small" onClick={more} disabled={paging}>
            {paging ? t('Loading…') : t('Load more')}
          </button>
        </p>
      )}
      {createdUrl !== null && !contextChanged && (
        <OneTimeLinkCreated
          url={createdUrl}
          onDone={() => {
            setCreatedUrl(null)
            createButton.current?.focus()
          }}
        />
      )}
    </>
  )
}

function OneTimeLinkCreated({ url, onDone }: { url: string; onDone: () => void }) {
  const { t } = useI18n()
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const title = useId()
  const description = useId()
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (typeof element.showModal === 'function' && typeof element.close === 'function')
      element.showModal()
    else element.setAttribute('open', '')
    input.current?.focus()
    input.current?.select()
  }, [])
  function finish() {
    // Leave the native modal first: its background remains inert until close().
    const element = dialog.current
    if (element && typeof element.close === 'function') element.close()
    onDone()
  }
  return (
    <dialog
      ref={dialog}
      className="one-time-link-dialog"
      aria-modal="true"
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={(e) => {
        e.preventDefault()
        finish()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          finish()
        }
        if (e.key !== 'Tab') return
        const controls = dialog.current?.querySelectorAll<HTMLElement>('input, button')
        const first = controls?.[0]
        const last = controls?.[controls.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }}
    >
      <h2 id={title}>{t('Copy your one-time link')}</h2>
      <p id={description} role="status">
        {t(
          'Link created. Copy and save it privately now. After you close this dialog, the URL cannot be shown again.',
        )}
      </p>
      <Field id="created-one-time-url" label={t('One-time booking URL')}>
        {(props) => (
          <input
            {...props}
            ref={input}
            readOnly
            value={url}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      <div className="form-actions">
        <CopyButton text={url} label="Copy one-time link" />
        <button type="button" className="button button-primary" onClick={finish}>
          {t('Close and forget URL')}
        </button>
      </div>
    </dialog>
  )
}
