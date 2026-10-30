import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import { inviteMember, type QueuedInvitation } from '../api/auth.ts'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../api/errors.ts'
import { OrganizationContextConflict } from '../components/OrganizationContextConflict.tsx'
import { useI18n } from '../i18n/runtime.tsx'
import { type MessageKey, msg, type UiText } from '../i18n/translate.ts'
import { useUnsavedChanges } from '../unsaved-changes.tsx'
import { InvitationRow } from './team-invitations/InvitationRow.tsx'

const PAGE_SIZE = 20
const EXISTING_INVITATION_PAGE_LIMIT = 5
/** A remount discards observations and drafts belonging to the previous team. */
export function TeamInvitations({ organizationId }: { organizationId: string }) {
  return <InvitationManagement key={organizationId} organizationId={organizationId} />
}

function InvitationManagement({ organizationId }: { organizationId: string }) {
  const [revision, setRevision] = useState(0)
  const [existingInvitation, setExistingInvitation] = useState<QueuedInvitation | null>(null)
  return (
    <>
      <InviteMember
        organizationId={organizationId}
        onQueued={(invitation) => {
          setExistingInvitation(invitation.existing ? invitation : null)
          setRevision((value) => value + 1)
        }}
      />
      <PendingInvitations
        key={revision}
        organizationId={organizationId}
        existingInvitation={existingInvitation}
      />
    </>
  )
}

function invitationError(error: unknown): UiText {
  if (!(error instanceof RequestError)) return errorMessage(error)
  const messages: Record<string, MessageKey> = {
    INVITATION_ALREADY_PENDING:
      'An invitation is already pending for this address. Review the pending invitations.',
    USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION:
      'An invitation is already pending for this address. Review the pending invitations.',
    INVITATION_RECIPIENT_ALREADY_MEMBER: 'This address already belongs to a team member.',
    INVITATION_PENDING_LIMIT:
      'This team has reached its pending invitation limit. Resolve pending invitations before inviting more people.',
    INVALID_INVITATION_REQUEST: 'Enter a valid email address.',
    INVALID_EMAIL: 'Enter a valid email address.',
    INVITATION_DELIVERY_UNAVAILABLE:
      'The invitation was saved, but delivery could not be queued. Retry with the same email address.',
    INVITATION_REQUEST_FAILED: 'The invitation request could not be queued. Try again later.',
    INVITATION_CONFLICT:
      'A newer invitation exists for this address. Review the pending invitations.',
    INVITATION_INELIGIBLE: 'This invitation is no longer pending. Reload before trying again.',
    INVITATION_DELIVERY_BUSY: 'Invitation delivery is in progress. Try again shortly.',
    INVITATION_GENERATION_LIMIT: 'This invitation has reached its resend limit.',
  }
  if (error.status === 403) return msg('You do not have permission to invite members.')
  if (error.status === 429)
    return msg('Invitation requests are temporarily limited. Try again later.')
  const key = error.code && Object.hasOwn(messages, error.code) ? messages[error.code] : undefined
  return key ? msg(key) : errorMessage(error)
}

function InviteMember({
  organizationId,
  onQueued,
}: {
  organizationId: string
  onQueued: (invitation: QueuedInvitation) => void
}) {
  const { t, ui } = useI18n()
  const id = useId()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [notice, setNotice] = useState<UiText | null>(null)
  const request = useRef<AbortController | null>(null)
  const feedback = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  useUnsavedChanges(email !== '')
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (notice || error) feedback.current?.focus()
  }, [notice, error])
  const conflict = isOrganizationContextChanged(error)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (request.current || conflict) return
    setNotice(null)
    setError(null)
    if (!input.current?.validity.valid || !email.trim()) {
      setError(new RequestError(400, 'INVALID_INVITATION_REQUEST', ''))
      return
    }
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    try {
      const invitation = await inviteMember(email.trim(), organizationId, controller.signal)
      if (controller.signal.aborted) return
      setEmail('')
      if (!invitation.existing && invitation.delivery.state === 'queued') {
        setNotice(msg('Invitation queued for delivery.'))
      } else {
        setNotice(msg('An invitation already exists. Review its mail submission status below.'))
      }
      onQueued(invitation)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure)
    } finally {
      if (!controller.signal.aborted) {
        request.current = null
        setBusy(false)
      }
    }
  }

  return (
    <section className="panel" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>{t('Invite member')}</h2>
      <form className="stack" onSubmit={submit} noValidate aria-label={t('Invite member')}>
        <p className="hint">{t('Invitations always use the member role.')}</p>
        <p className="hint" id={`${id}-policy`}>
          {t(
            'On a restricted instance, an invitation permits sign-up only when the inviter is the instance’s earliest user or has a currently allowed email domain. The recipient must verify this exact address and accept the invitation separately to join.',
          )}
        </p>
        <div className="field">
          <label htmlFor={`${id}-email`}>{t('Email')}</label>
          <input
            ref={input}
            id={`${id}-email`}
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            disabled={busy}
            aria-describedby={`${id}-policy`}
            aria-invalid={
              error instanceof RequestError &&
              ['INVALID_INVITATION_REQUEST', 'INVALID_EMAIL'].includes(error.code ?? '')
                ? true
                : undefined
            }
            onChange={(event) => {
              setEmail(event.target.value)
              setNotice(null)
              if (!conflict) setError(null)
            }}
          />
        </div>
        <div ref={feedback} tabIndex={-1}>
          {conflict ? (
            <OrganizationContextConflict error={error} />
          ) : error ? (
            <div className="alert alert-error" role="alert">
              <p>{ui(invitationError(error))}</p>
              {error instanceof RequestError &&
                error.status === 429 &&
                error.retryAfterSeconds !== undefined && (
                  <p>{t('Try again in {0} seconds.', { '0': error.retryAfterSeconds })}</p>
                )}
            </div>
          ) : notice ? (
            <p role="status">{ui(notice)}</p>
          ) : null}
        </div>
        <div className="form-actions">
          <button type="submit" className="button button-primary" disabled={busy || conflict}>
            {busy ? t('Queueing invitation…') : t('Invite member')}
          </button>
        </div>
      </form>
    </section>
  )
}

type InvitationPage = { data: Schemas['TeamInvitationSummary'][]; nextCursor: string | null }
type PageState = { status: 'ready'; data: InvitationPage } | { status: 'error'; error: unknown }

function PendingInvitations({
  organizationId,
  existingInvitation,
}: {
  organizationId: string
  existingInvitation: QueuedInvitation | null
}) {
  const { t, ui } = useI18n()
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const [version, setVersion] = useState(0)
  const [filter, setFilter] = useState<'pending' | 'expired' | 'all'>('pending')
  const observed = useRef(new Map<string, Schemas['TeamInvitationSummary']>())
  const rowKeys = useRef(new Map<string, string>())
  const filterId = useId()
  const seekExistingInvitation = useRef(Boolean(existingInvitation))
  const [existingInvitationMissing, setExistingInvitationMissing] = useState(false)
  const cursor = cursors[cursors.length - 1]
  const load = useCallback(
    async (signal: AbortSignal) => {
      const data = await unwrap(
        api.GET('/api/v1/team/invitations', {
          headers: { 'X-Expected-Organization-Id': organizationId },
          params: {
            query: {
              ...(filter !== 'all' && { status: filter }),
              limit: PAGE_SIZE,
              ...(cursor && { cursor }),
            },
          },
          signal,
        }),
      )
      const seen = new Set(data.data.map(({ id }) => id))
      const retained = await Promise.all(
        [...observed.current.keys()]
          .filter((id) => !seen.has(id))
          .map((invitationId) =>
            unwrap(
              api.GET('/api/v1/team/invitations/{invitationId}', {
                params: {
                  path: { invitationId },
                  header: { 'x-expected-organization-id': organizationId },
                },
                signal,
              }),
            ),
          ),
      )
      signal.throwIfAborted()
      for (const summary of [...data.data, ...retained]) {
        if (observed.current.has(summary.id)) observed.current.set(summary.id, summary)
      }
      return { ...data, data: [...data.data, ...retained] }
    },
    [cursor, filter, organizationId],
  )
  const [result, setResult] = useState<{ load: typeof load; state: PageState }>()
  // biome-ignore lint/correctness/useExhaustiveDependencies: version requests a fresh page after failure
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return
        if (seekExistingInvitation.current && existingInvitation) {
          const found = data.data.some(({ id }) => id === existingInvitation.id)
          // Pending invitations are capped at 100; seek once without trapping manual paging.
          if (!found && data.nextCursor && cursors.length < EXISTING_INVITATION_PAGE_LIMIT) {
            setCursors((value) => [...value, data.nextCursor ?? undefined])
            return
          }
          seekExistingInvitation.current = false
          setExistingInvitationMissing(!found)
        }
        setResult({
          load,
          state: { status: 'ready', data },
        })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setResult({ load, state: { status: 'error', error } })
      },
    )
    return () => controller.abort()
  }, [load, version, existingInvitation, cursors.length])
  const state = result?.load === load ? result.state : undefined
  const conflict = state?.status === 'error' && isOrganizationContextChanged(state.error)
  return (
    <section className="panel" aria-labelledby="pending-invitations-heading">
      <h2 id="pending-invitations-heading">{t('Pending invitations')}</h2>
      <p className="hint">{t('Mail server acceptance does not confirm receipt in the inbox.')}</p>
      <div className="field">
        <label htmlFor={filterId}>{t('Filter invitations')}</label>
        <select
          id={filterId}
          value={filter}
          onChange={(event) => {
            observed.current.clear()
            seekExistingInvitation.current = false
            setExistingInvitationMissing(false)
            setCursors([undefined])
            setFilter(event.target.value as typeof filter)
          }}
        >
          <option value="pending">{t('Pending')}</option>
          <option value="expired">{t('Expired')}</option>
          <option value="all">{t('All statuses')}</option>
        </select>
      </div>
      {existingInvitationMissing && (
        <p role="status">{t('The invitation changed. Reload before trying again.')}</p>
      )}
      {!state && <p role="status">{t('Loading pending invitations…')}</p>}
      {state?.status === 'error' &&
        (conflict ? (
          <OrganizationContextConflict error={state.error} />
        ) : (
          <div className="alert alert-error" role="alert">
            <p>
              {t(
                state.error instanceof RequestError && state.error.status === 403
                  ? 'You do not have permission to view pending invitations.'
                  : 'Could not load pending invitations.',
              )}
            </p>
            {!(state.error instanceof RequestError && state.error.status === 403) && (
              <p>{ui(errorMessage(state.error))}</p>
            )}
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                setResult(undefined)
                setVersion((value) => value + 1)
              }}
            >
              {t('Try again')}
            </button>
          </div>
        ))}
      {state?.status === 'ready' && (
        <>
          {state.data.data.length === 0 && <p>{t('No pending invitations on this page.')}</p>}
          <ul className="stack">
            {state.data.data.map((invitation) => (
              <InvitationRow
                key={rowKeys.current.get(invitation.id) ?? invitation.id}
                invitation={invitation}
                organizationId={organizationId}
                onObserved={(summary) => {
                  if (summary.id !== invitation.id) {
                    observed.current.delete(invitation.id)
                    rowKeys.current.set(
                      summary.id,
                      rowKeys.current.get(invitation.id) ?? invitation.id,
                    )
                    rowKeys.current.set(invitation.id, `retired:${invitation.id}`)
                  }
                  observed.current.set(summary.id, summary)
                  setResult((current) =>
                    current?.state.status === 'ready'
                      ? {
                          ...current,
                          state: {
                            status: 'ready',
                            data: {
                              ...current.state.data,
                              data: current.state.data.data.flatMap((row) =>
                                row.id === invitation.id
                                  ? [summary]
                                  : row.id === summary.id
                                    ? []
                                    : [row],
                              ),
                            },
                          },
                        }
                      : current,
                  )
                  setVersion((value) => value + 1)
                }}
              />
            ))}
          </ul>
        </>
      )}
      <div className="form-actions">
        {cursors.length > 1 && (
          <button
            type="button"
            className="button button-small"
            disabled={!state || conflict}
            onClick={() => {
              observed.current.clear()
              setCursors((value) => value.slice(0, -1))
            }}
          >
            {t('Previous invitations page')}
          </button>
        )}
        {state?.status === 'ready' && state.data.nextCursor && (
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              observed.current.clear()
              setCursors((value) => [...value, state.data.nextCursor ?? undefined])
            }}
          >
            {t('Next invitations page')}
          </button>
        )}
      </div>
    </section>
  )
}
