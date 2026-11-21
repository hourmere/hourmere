import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { api, type Schemas, unwrap } from '../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../api/errors.ts'
import type { operations } from '../api/schema.d.ts'
import { BreakableText } from '../components/BreakableText.tsx'
import { CopyButton } from '../components/CopyButton.tsx'
import { Field } from '../components/forms.tsx'
import { PageSkeleton } from '../components/PageSkeleton.tsx'
import { useLoad } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { MessageKey } from '../i18n/translate.ts'
import { SsoFreshProof } from './sso/SsoFreshProof.tsx'
import { type SsoProofChallenge, SsoProofRequired, unwrapSsoWrite } from './sso/setup.ts'

type Approval = operations['approveScimTeamMapping']['requestBody']['content']['application/json']
type Intent =
  | Omit<Extract<Approval, { action: 'link' }>, 'proofAttemptId'>
  | Omit<Extract<Approval, { action: 'unlink' }>, 'proofAttemptId'>
type Mapping = Schemas['ScimTeamMappingList']['mappings'][number]
type StepUpProvider = { id: string; displayName: string }
const listPath = '/api/v1/scim/team-mappings'
const unavailable = 'SCIM team mappings are unavailable in this team.'
const invalidRequest = 'Check the team IDs, link generation, and Group external ID.'
const invalidSharedRequest = 'Check that the approval request is complete and includes this team.'
const requestLimit = 4096

function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function generation(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647
}

function selector(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.isWellFormed() &&
    !value.includes('\u0000') &&
    [...value].length >= 1 &&
    [...value].length <= 256
  )
}

function readIntent(raw: string, organizationId: string): Intent | null {
  if (raw.length > requestLimit) return null
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    return null
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const {
    intentId,
    parentOrganizationId,
    childOrganizationId,
    connectionId,
    action,
    externalId,
    linkGeneration,
    allowGroupRetirement,
    mappingId,
  } = input as Record<string, unknown>
  if (
    !uuid(intentId) ||
    !uuid(parentOrganizationId) ||
    !uuid(childOrganizationId) ||
    !uuid(connectionId) ||
    parentOrganizationId.toLowerCase() === childOrganizationId.toLowerCase() ||
    ![parentOrganizationId, childOrganizationId].some((id) => id.toLowerCase() === organizationId)
  )
    return null

  const scope = { intentId, parentOrganizationId, childOrganizationId, connectionId }
  const keys = Object.keys(input).length
  if (
    action === 'link' &&
    keys === 8 &&
    selector(externalId) &&
    generation(linkGeneration) &&
    allowGroupRetirement === true
  )
    return { ...scope, action, externalId, linkGeneration, allowGroupRetirement }
  if (action === 'unlink' && keys === 6 && uuid(mappingId)) return { ...scope, action, mappingId }
  return null
}

function mutationError(cause: unknown, finalizing: boolean): MessageKey {
  if (isOrganizationContextChanged(cause))
    return 'Your space changed. Reload before making changes.'
  if (cause instanceof RequestError) {
    switch (cause.code) {
      case 'scim_mapping_topology_conflict':
      case 'scim_mapping_generation_changed':
        return 'This link conflicts with current team mappings. Check the team details and prepare a new request.'
      case 'scim_mapping_privileged_member':
      case 'scim_mapping_roster_requires_departure':
        return 'The child team must resolve its managed memberships before detaching this mapping.'
    }
    if (cause.status === 403 || cause.status === 404)
      return finalizing
        ? 'Could not apply this request. Both owners must approve the same request before their verification expires.'
        : 'Could not record your approval. Verify your identity and try again.'
    if (cause.status === 429) return 'Too many requests. Wait a minute and try again.'
  }
  return 'Could not update SCIM team mappings. Check the mapping list before trying again.'
}

export function ScimTeamMappings({
  organizationId,
  role,
  stepUpProviders,
}: {
  organizationId: string
  role: string | null
  stepUpProviders: StepUpProvider[]
}) {
  const roles = role?.split(',').map((part) => part.trim()) ?? []
  if (!roles.some((part) => part === 'owner' || part === 'admin')) return null
  const owner = roles.includes('owner')
  return (
    <MappingPanel
      key={String(owner)}
      organizationId={organizationId}
      owner={owner}
      stepUpProviders={stepUpProviders}
    />
  )
}

function MappingPanel({
  organizationId,
  owner,
  stepUpProviders,
}: {
  organizationId: string
  owner: boolean
  stepUpProviders: StepUpProvider[]
}) {
  const { t } = useI18n()
  const id = useId()
  const panelHeading = useRef<HTMLHeadingElement>(null)
  const reviewHeading = useRef<HTMLHeadingElement>(null)
  const childInput = useRef<HTMLInputElement>(null)
  const sharedInput = useRef<HTMLTextAreaElement>(null)
  const request = useRef<AbortController | null>(null)
  const [editor, setEditor] = useState<'link' | 'paste' | null>(null)
  const [intent, setIntent] = useState<Intent | null>(null)
  const [challenge, setChallenge] = useState<SsoProofChallenge | null>(null)
  const [busy, setBusy] = useState(false)
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)
  const [status, setStatus] = useState<MessageKey | null>(null)
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        return await unwrap(
          api.GET(listPath, {
            headers: { 'X-Expected-Organization-Id': organizationId },
            cache: 'no-store',
            signal,
          }),
        )
      } catch (e) {
        if (e instanceof RequestError && (e.status === 403 || e.status === 404)) return null
        throw e
      }
    },
    [organizationId],
  )
  const [inventory, reload] = useLoad(load)

  useLayoutEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (intent && !challenge) reviewHeading.current?.focus()
  }, [intent, challenge])
  useEffect(() => {
    if (editor === 'link') childInput.current?.focus()
    if (editor === 'paste') sharedInput.current?.focus()
  }, [editor])

  function reset() {
    setEditor(null)
    setIntent(null)
    setChallenge(null)
    setApproved(false)
    setError(null)
    setStatus(null)
  }

  function begin(mode: 'link' | 'paste') {
    reset()
    setEditor(mode)
  }

  function close() {
    reset()
    panelHeading.current?.focus()
  }

  function review(next: Intent) {
    reset()
    setIntent(next)
  }

  function prepareLink(event: FormEvent<HTMLFormElement>, connectionId: string) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const childOrganizationId = String(form.get('childOrganizationId') ?? '')
      .trim()
      .toLowerCase()
    const linkGeneration = Number(form.get('linkGeneration'))
    const externalId = form.get('externalId')
    if (
      !uuid(childOrganizationId) ||
      childOrganizationId === organizationId ||
      !generation(linkGeneration) ||
      !selector(externalId)
    ) {
      setError(invalidRequest)
      return
    }
    review({
      action: 'link',
      intentId: crypto.randomUUID(),
      parentOrganizationId: organizationId,
      childOrganizationId,
      connectionId,
      linkGeneration,
      externalId,
      allowGroupRetirement: true,
    })
  }

  function prepareUnlink({
    id: mappingId,
    parentOrganizationId,
    childOrganizationId,
    connectionId,
  }: Mapping) {
    review({
      action: 'unlink',
      intentId: crypto.randomUUID(),
      parentOrganizationId,
      childOrganizationId,
      connectionId,
      mappingId,
    })
  }

  function reviewShared(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const shared = readIntent(String(form.get('approvalRequest') ?? ''), organizationId)
    if (shared) review(shared)
    else setError(invalidSharedRequest)
  }

  async function write(operation: 'approve' | 'finalize', proofAttemptId?: string) {
    if (!intent || request.current) return
    const controller = new AbortController()
    request.current = controller
    const { signal } = controller
    const headers = { 'X-Expected-Organization-Id': organizationId }
    const finalizing = operation === 'finalize'
    setBusy(true)
    setError(null)
    try {
      if (!finalizing) {
        await unwrapSsoWrite(
          api.POST('/api/v1/scim/team-mappings/consent', {
            body: { ...intent, ...(proofAttemptId && { proofAttemptId }) },
            headers,
            signal,
          }),
        )
        if (signal.aborted) return
        setChallenge(null)
        setApproved(true)
        setStatus(
          'Your approval is recorded. Either approving owner can apply the request once both have approved.',
        )
      } else {
        const body = { intentId: intent.intentId }
        if (intent.action === 'link') {
          await unwrap(api.POST(listPath, { body, headers, signal }))
        } else {
          await unwrap(
            api.DELETE('/api/v1/scim/team-mappings/{id}', {
              body,
              params: { path: { id: intent.mappingId } },
              headers,
              signal,
            }),
          )
        }
        if (signal.aborted) return
        reset()
        setStatus(
          intent.action === 'link' ? 'SCIM team mapping linked.' : 'SCIM team mapping detached.',
        )
        reload()
      }
    } catch (cause) {
      if (signal.aborted) return
      if (!finalizing && cause instanceof SsoProofRequired) setChallenge(cause.challenge)
      else {
        setChallenge(null)
        setError(mutationError(cause, finalizing))
      }
    } finally {
      request.current = null
      if (!signal.aborted) setBusy(false)
    }
  }

  const data = inventory.status === 'ready' ? inventory.data : null
  const canApprove = owner && data?.linkGeneration != null
  const connectionId = data?.connectionId
  return (
    <section className="panel stack" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} ref={panelHeading} tabIndex={-1}>
        {t('SCIM team mappings')}
      </h2>
      {inventory.status === 'loading' && <PageSkeleton label="Loading SCIM team mappings…" />}
      {inventory.status === 'error' && (
        <div className="alert alert-error" role="alert">
          <p>{t('Could not load SCIM team mappings.')}</p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {inventory.status === 'ready' && !data && <p role="status">{t(unavailable)}</p>}
      {data && (
        <>
          {data.mappings.length === 0 ? (
            <p>{t('No SCIM team mappings yet.')}</p>
          ) : (
            <ul className="card-list plain-list">
              {data.mappings.map((mapping) => (
                <li key={mapping.id} className="panel stack">
                  <dl className="details">
                    <dt>{t('SCIM mapping ID')}</dt>
                    <dd>
                      <BreakableText>{mapping.id}</BreakableText>
                    </dd>
                    <dt>{t('Parent team ID')}</dt>
                    <dd>
                      <BreakableText>{mapping.parentOrganizationId}</BreakableText>
                    </dd>
                    <dt>{t('Child team ID')}</dt>
                    <dd>
                      <BreakableText>{mapping.childOrganizationId}</BreakableText>
                    </dd>
                    <dt>{t('Group external ID')}</dt>
                    <dd data-private>
                      <BreakableText>{mapping.externalId}</BreakableText>
                    </dd>
                    <dt>{t('Status')}</dt>
                    <dd>
                      {t(
                        mapping.state === 'suspended'
                          ? 'Directory authority suspended'
                          : 'Awaiting directory Group',
                      )}
                    </dd>
                  </dl>
                  {canApprove && !intent && !editor && (
                    <div>
                      <button
                        type="button"
                        className="button button-wrap"
                        onClick={() => prepareUnlink(mapping)}
                      >
                        {t('Prepare unlink request')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canApprove && !intent && !editor && (
            <>
              <dl className="details">
                <dt>{t('This team’s ID')}</dt>
                <dd>
                  <BreakableText>{organizationId}</BreakableText>
                </dd>
                <dt>{t('This team’s link generation')}</dt>
                <dd>{data.linkGeneration}</dd>
              </dl>
              <p className="hint">
                {t(
                  'To link this team as a child, share its ID and link generation with the parent team’s owner.',
                )}
              </p>
              <div className="form-actions">
                {connectionId && (
                  <button
                    type="button"
                    className="button button-wrap"
                    onClick={() => begin('link')}
                  >
                    {t('Prepare link request')}
                  </button>
                )}
                <button type="button" className="button button-wrap" onClick={() => begin('paste')}>
                  {t('Open shared approval request')}
                </button>
              </div>
            </>
          )}
          {status && <p role="status">{t(status)}</p>}
          {error && (
            <p className="alert alert-error" role="alert">
              {t(error)}
            </p>
          )}
          {canApprove && editor === 'link' && connectionId && (
            <form className="stack" onSubmit={(event) => prepareLink(event, connectionId)}>
              <Field id={`${id}-child`} label={t('Child team ID')}>
                {(control) => (
                  <input
                    {...control}
                    ref={childInput}
                    name="childOrganizationId"
                    maxLength={36}
                    autoComplete="off"
                    required
                  />
                )}
              </Field>
              <Field id={`${id}-generation`} label={t('Child team link generation')}>
                {(control) => (
                  <input
                    {...control}
                    name="linkGeneration"
                    type="number"
                    min={0}
                    max={2147483647}
                    step={1}
                    required
                  />
                )}
              </Field>
              <Field
                id={`${id}-external`}
                label={t('Group external ID')}
                hint={t('Enter the exact external ID supplied by the identity provider.')}
              >
                {(control) => (
                  <input
                    {...control}
                    name="externalId"
                    maxLength={512}
                    autoComplete="off"
                    required
                  />
                )}
              </Field>
              <div className="form-actions">
                <button type="submit" className="button button-primary">
                  {t('Review request')}
                </button>
                <button type="button" className="button" onClick={close}>
                  {t('Cancel')}
                </button>
              </div>
            </form>
          )}
          {canApprove && editor === 'paste' && (
            <form className="stack" onSubmit={reviewShared}>
              <Field id={`${id}-paste`} label={t('Shared approval request')}>
                {(control) => (
                  <textarea
                    {...control}
                    ref={sharedInput}
                    name="approvalRequest"
                    rows={5}
                    maxLength={requestLimit}
                    autoComplete="off"
                    spellCheck={false}
                    data-private
                    required
                  />
                )}
              </Field>
              <div className="form-actions">
                <button type="submit" className="button button-primary">
                  {t('Review request')}
                </button>
                <button type="button" className="button" onClick={close}>
                  {t('Cancel')}
                </button>
              </div>
            </form>
          )}
          {canApprove && intent && (
            <div className="stack">
              <h3 ref={reviewHeading} tabIndex={-1}>
                {t(
                  intent.action === 'link'
                    ? 'Review SCIM link request'
                    : 'Review SCIM unlink request',
                )}
              </h3>
              <dl className="details">
                <dt>{t('Parent team ID')}</dt>
                <dd>
                  <BreakableText>{intent.parentOrganizationId}</BreakableText>
                </dd>
                <dt>{t('Child team ID')}</dt>
                <dd>
                  <BreakableText>{intent.childOrganizationId}</BreakableText>
                </dd>
                <dt>{t('Directory connection ID')}</dt>
                <dd>
                  <BreakableText>{intent.connectionId}</BreakableText>
                </dd>
                {intent.action === 'link' ? (
                  <>
                    <dt>{t('Group external ID')}</dt>
                    <dd data-private>
                      <BreakableText>{intent.externalId}</BreakableText>
                    </dd>
                    <dt>{t('Child team link generation')}</dt>
                    <dd>{intent.linkGeneration}</dd>
                  </>
                ) : (
                  <>
                    <dt>{t('SCIM mapping ID')}</dt>
                    <dd>
                      <BreakableText>{intent.mappingId}</BreakableText>
                    </dd>
                  </>
                )}
              </dl>
              <p>
                {t(
                  intent.action === 'link'
                    ? 'Linking allows this directory to manage the child team’s name and directory-managed members, retire the Group, and remove memberships it manages.'
                    : 'Detaching ends directory authority for this mapping and removes any memberships it manages.',
                )}
              </p>
              {challenge ? (
                <SsoFreshProof
                  key={challenge.attemptId}
                  organizationId={organizationId}
                  challenge={challenge}
                  stepUpProviders={stepUpProviders}
                  busy={busy}
                  title="Confirm your identity to approve this SCIM mapping request."
                  onRetry={() => void write('approve', challenge.attemptId)}
                  onCancel={() => setChallenge(null)}
                />
              ) : (
                <>
                  <Field
                    id={`${id}-share`}
                    label={t('Shareable approval request')}
                    hint={t(
                      'Send this exact request privately to the other team’s owner. Each owner approves from their own team.',
                    )}
                  >
                    {(control) => (
                      <textarea
                        {...control}
                        rows={4}
                        readOnly
                        value={JSON.stringify(intent)}
                        data-private
                      />
                    )}
                  </Field>
                  <div className="form-actions">
                    <CopyButton text={JSON.stringify(intent)} label="Copy approval request" />
                    {!approved && (
                      <button
                        type="button"
                        className="button button-primary button-wrap"
                        disabled={busy}
                        onClick={() => void write('approve')}
                      >
                        {t('Approve for this team')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={
                        approved ? 'button button-primary button-wrap' : 'button button-wrap'
                      }
                      disabled={busy}
                      onClick={() => void write('finalize')}
                    >
                      {t(intent.action === 'link' ? 'Apply link' : 'Apply unlink')}
                    </button>
                    <button type="button" className="button" disabled={busy} onClick={close}>
                      {t('Close')}
                    </button>
                  </div>
                </>
              )}
              {busy && <p role="status">{t('Working…')}</p>}
            </div>
          )}
        </>
      )}
    </section>
  )
}
