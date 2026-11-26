import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { api, unwrap } from '../../api/client.ts'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { OrganizationContextConflict } from '../../components/OrganizationContextConflict.tsx'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { useSession } from '../../session.tsx'
import { useUnsavedChanges } from '../../unsaved-changes.tsx'
import {
  isWebhookEvent,
  WebhookConfirm,
  type WebhookConfirmation,
  WebhookCreateForm,
  type WebhookDraft,
  WebhookEditor,
  type WebhookEndpoint,
  type WebhookEvent,
  WebhookList,
  WebhookSecret,
} from './WebhookViews.tsx'
import {
  changeWebhook,
  readWebhooks,
  type WebhookAction,
  webhookContextError,
} from './webhook-requests.ts'

type List =
  | { status: 'loading' | 'error' | 'unconfirmed' | 'denied' }
  | { status: 'ready'; endpoints: WebhookEndpoint[] }
  | { status: 'conflict'; error: unknown }

type Form =
  | { type: 'create'; draft: WebhookDraft }
  | { type: 'edit'; id: string; events: WebhookEvent[] }

type Notice = { key: MessageKey; error?: true }
type ReturnCheck = { result: Promise<WebhookEndpoint[] | null>; controller: AbortController }

const newDraft = (): WebhookDraft => ({ url: '', events: [], isActive: true })
const readInstance = (signal: AbortSignal) =>
  unwrap(api.GET('/api/v1/instance', { signal, cache: 'no-store' }))
const hidden = () => document.visibilityState === 'hidden'

function waitForReturn(signal: AbortSignal, isAway: () => boolean) {
  if (!isAway() || signal.aborted) return
  return new Promise<void>((resolve) => {
    const done = () => {
      document.removeEventListener('visibilitychange', changed)
      window.removeEventListener('focus', changed)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const changed = () => {
      if (!isAway()) done()
    }
    document.addEventListener('visibilitychange', changed)
    window.addEventListener('focus', changed)
    signal.addEventListener('abort', done, { once: true })
  })
}

const uncertain: Record<WebhookAction['type'], MessageKey> = {
  create:
    'Creation could not be confirmed. Refresh the list and confirm the endpoint ID before rotating its secret.',
  rotate:
    'Rotation could not be confirmed. The previous secret may already have been replaced. Refresh the list before taking another action.',
  delete:
    'The webhook change could not be confirmed. Refresh the list before taking another action.',
  events:
    'The webhook change could not be confirmed. Refresh the list before taking another action.',
  active:
    'The webhook change could not be confirmed. Refresh the list before taking another action.',
}

export function WebhookSettings({
  organizationId,
  userId,
  personal,
  onAccessDenied,
  onSavingChange,
  headingRef,
}: {
  organizationId: string
  userId: string
  personal: boolean
  onAccessDenied: (code: string | undefined) => void
  onSavingChange?: (saving: boolean) => void
  headingRef?: RefObject<HTMLHeadingElement | null>
}) {
  const { t } = useI18n()
  const { refresh } = useSession()
  const refreshSession = useRef(refresh)
  useLayoutEffect(() => {
    refreshSession.current = refresh
  }, [refresh])
  const [list, setList] = useState<List>({ status: 'loading' })
  const [form, setForm] = useState<Form | null>(null)
  const [confirmation, setConfirmation] = useState<WebhookConfirmation | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [instance, reloadInstance] = useLoad(readInstance)
  const [rejectedInstance, setRejectedInstance] = useState<typeof instance | null>(null)
  const workflowsEnabled =
    instance === rejectedInstance
      ? false
      : instance.status === 'ready'
        ? instance.data?.workflowsEnabled
        : undefined

  const read = useRef<AbortController | null>(null)
  const write = useRef<AbortController | null>(null)
  const stopped = useRef(false)
  const returnCheck = useRef<ReturnCheck | null>(null)
  const needsSessionCheck = useRef(false)
  const blurred = useRef(false)
  const restoring = useRef(false)
  const background = useRef(0)
  const secretOpener = useRef<{ target: HTMLButtonElement | null } | null>(null)
  const listHeading = useRef<HTMLHeadingElement>(null)
  const formOpener = useRef<HTMLButtonElement | null>(null)
  const confirmOpener = useRef<HTMLButtonElement | null>(null)
  const pendingFocus = useRef<{ target: HTMLButtonElement | null } | null>(null)
  const isAway = useCallback(() => blurred.current || hidden(), [])

  useLayoutEffect(() => {
    onSavingChange?.(busy)
  }, [busy, onSavingChange])

  useLayoutEffect(() => {
    secretOpener.current =
      secret === null ? null : { target: form ? confirmOpener.current : formOpener.current }
  }, [form, secret])

  const selected =
    form?.type === 'edit' && list.status === 'ready'
      ? (list.endpoints.find(({ id }) => id === form.id) ?? null)
      : null
  const eventsChanged =
    selected &&
    form?.type === 'edit' &&
    selected.events.every(isWebhookEvent) &&
    (selected.events.length !== form.events.length ||
      form.events.some((event) => !selected.events.includes(event)))
  useUnsavedChanges(
    form?.type === 'create'
      ? Boolean(form.draft.url || form.draft.events.length || !form.draft.isActive)
      : Boolean(eventsChanged),
  )

  // Run after the destination control becomes visible again. Fall back to the list
  // heading when a stale or deleted endpoint took the original control with it.
  useLayoutEffect(() => {
    if (checking || !pendingFocus.current) return
    const target = pendingFocus.current.target
    pendingFocus.current = null
    if (target?.isConnected && !target.disabled && !target.closest('[hidden]')) target.focus()
    else (listHeading.current ?? headingRef?.current)?.focus()
  })

  const clearWorkspace = useCallback(() => {
    read.current?.abort()
    read.current = null
    write.current?.abort()
    write.current = null
    returnCheck.current?.controller.abort()
    returnCheck.current = null
    restoring.current = false
    setChecking(false)
    setBusy(false)
    setForm(null)
    setConfirmation(null)
    setSecret(null)
    setNotice(null)
    formOpener.current = null
    confirmOpener.current = null
    pendingFocus.current = { target: null }
  }, [])

  const boundary = useCallback(
    (error: unknown) => {
      if (isOrganizationContextChanged(error)) {
        stopped.current = true
        clearWorkspace()
        setList({ status: 'conflict', error: webhookContextError() })
        return true
      }
      if (error instanceof RequestError && (error.status === 401 || error.status === 403)) {
        stopped.current = true
        clearWorkspace()
        setList({ status: 'denied' })
        if (error.status === 403) onAccessDenied(error.code)
        return true
      }
      return false
    },
    [clearWorkspace, onAccessDenied],
  )

  const verifySession = useCallback(async () => {
    const current = await refreshSession.current({ fresh: true })
    if (!current) throw new Error('Webhook session could not be verified')
    if (
      current.principal.kind !== 'session' ||
      current.user.id !== userId ||
      current.organization.id !== organizationId ||
      current.organization.personal !== personal ||
      (personal && current.personalOrganizationId !== organizationId)
    ) {
      throw webhookContextError()
    }
  }, [organizationId, personal, userId])

  const recheck = useCallback(() => {
    if (returnCheck.current) return returnCheck.current.result
    if (stopped.current || isAway()) return Promise.resolve(null)
    const controller = new AbortController()
    const { signal } = controller
    setChecking(true)
    const result = (async () => {
      try {
        await verifySession()
        signal.throwIfAborted()
        // /me confirms the identity and active space. The bound list read checks live
        // webhook authority as well, including when a team member was just demoted.
        const endpoints = await readWebhooks(organizationId, signal)
        signal.throwIfAborted()
        needsSessionCheck.current = false
        if (restoring.current) {
          restoring.current = false
          setList({ status: 'ready', endpoints })
        }
        return endpoints
      } catch (error) {
        if (!signal.aborted && !stopped.current && !boundary(error)) {
          clearWorkspace()
          setList({ status: 'error' })
        }
        return null
      } finally {
        if (!signal.aborted) setChecking(false)
      }
    })()
    returnCheck.current = { result, controller }
    return result
  }, [boundary, clearWorkspace, isAway, organizationId, verifySession])

  const load = useCallback(async () => {
    if (stopped.current) return
    read.current?.abort()
    const controller = new AbortController()
    read.current = controller
    const { signal } = controller
    setList({ status: 'loading' })
    if (needsSessionCheck.current) {
      restoring.current = true
      await recheck()
      return
    }
    try {
      const endpoints = await readWebhooks(organizationId, signal)
      if (!signal.aborted) setList({ status: 'ready', endpoints })
    } catch (error) {
      if (!signal.aborted && !boundary(error)) setList({ status: 'error' })
    }
  }, [boundary, organizationId, recheck])

  useEffect(() => {
    void load()
    return () => read.current?.abort()
  }, [load])

  useLayoutEffect(() => {
    function away() {
      if (stopped.current) return
      background.current += 1
      needsSessionCheck.current = true
      returnCheck.current?.controller.abort()
      returnCheck.current = null
      setChecking(true)
      if (secretOpener.current) pendingFocus.current = secretOpener.current
      setSecret(null)
    }
    function visible() {
      if (hidden()) away()
      else if (needsSessionCheck.current) void recheck()
    }
    function blur() {
      blurred.current = true
      away()
    }
    function focus() {
      blurred.current = false
      if (hidden()) return
      if (!needsSessionCheck.current) away()
      void recheck()
    }
    function pagehide() {
      // Synchronously remove the one-time view before the browser can cache the DOM.
      flushSync(() => {
        away()
        clearWorkspace()
        if (!stopped.current) {
          restoring.current = true
          setList({ status: 'loading' })
        }
      })
    }
    function pageshow(event: PageTransitionEvent) {
      if (event.persisted) void recheck()
    }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('blur', blur)
    window.addEventListener('focus', focus)
    window.addEventListener('pagehide', pagehide)
    window.addEventListener('pageshow', pageshow)
    return () => {
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('blur', blur)
      window.removeEventListener('focus', focus)
      window.removeEventListener('pagehide', pagehide)
      window.removeEventListener('pageshow', pageshow)
      returnCheck.current?.controller.abort()
      returnCheck.current = null
      read.current?.abort()
      write.current?.abort()
    }
  }, [clearWorkspace, recheck])

  function closeForm() {
    setForm(null)
    setNotice(null)
    pendingFocus.current = { target: formOpener.current }
  }

  function closeConfirmation() {
    setConfirmation(null)
    pendingFocus.current = { target: confirmOpener.current }
  }

  function revealDismissed() {
    setSecret(null)
    pendingFocus.current = secretOpener.current
  }

  function writeError(error: unknown, action: WebhookAction) {
    if (boundary(error)) return
    const code = error instanceof RequestError ? error.code : undefined
    switch (code) {
      case 'webhook_not_found':
        clearWorkspace()
        setNotice({ key: 'This webhook endpoint is no longer available.', error: true })
        void load()
        break
      case 'workflows_disabled':
        setRejectedInstance(instance)
        reloadInstance()
        setNotice({ key: 'Workflow events are unavailable on this instance.', error: true })
        break
      case 'webhook_limit_reached':
        clearWorkspace()
        setNotice({
          key: 'This space can have up to ten webhook endpoints, including paused endpoints.',
          error: true,
        })
        void load()
        break
      case 'webhooks_disabled':
        if (confirmation) closeConfirmation()
        setNotice({
          key: 'Creating webhooks and rotating signing secrets are unavailable on this instance.',
          error: true,
        })
        break
      case 'invalid_webhook':
      case 'invalid_request':
        setNotice({ key: 'Check the webhook settings and try again.', error: true })
        break
      default:
        clearWorkspace()
        setNotice({ key: uncertain[action.type], error: true })
        setList({ status: 'unconfirmed' })
    }
  }

  async function save(action: WebhookAction) {
    if (
      write.current ||
      stopped.current ||
      needsSessionCheck.current ||
      checking ||
      isAway() ||
      list.status !== 'ready'
    )
      return
    const controller = new AbortController()
    write.current = controller
    const { signal } = controller
    const started = background.current
    setBusy(true)
    setNotice(null)
    try {
      const result = await changeWebhook(organizationId, action, signal)
      if (signal.aborted) return
      if (result.type === 'create' || result.type === 'rotate') {
        // A result may arrive while backgrounded, while /me is still pending, or
        // between two trips away. Only the latest verified return may reveal it.
        while (isAway() || background.current !== started || needsSessionCheck.current) {
          await waitForReturn(signal, isAway)
          if (signal.aborted) return
          const returned = background.current
          const verified = await recheck()
          if (signal.aborted || stopped.current) return
          if (background.current !== returned || isAway()) continue
          if (!verified) return
          break
        }
        if (result.type === 'create') {
          setList({
            status: 'ready',
            endpoints: [...list.endpoints, result.endpoint].sort((a, b) =>
              a.id.localeCompare(b.id),
            ),
          })
          setForm(null)
        }
        setConfirmation(null)
        setSecret(result.secret)
        setNotice({
          key:
            result.type === 'create'
              ? 'Webhook endpoint created.'
              : 'Webhook signing secret rotated.',
        })
      } else if (result.type === 'update') {
        setList({
          status: 'ready',
          endpoints: list.endpoints.map((endpoint) =>
            endpoint.id === result.endpoint.id ? result.endpoint : endpoint,
          ),
        })
        if (action.type === 'events') {
          setForm({
            type: 'edit',
            id: result.endpoint.id,
            events: result.endpoint.events.filter(isWebhookEvent),
          })
        }
        setNotice({ key: 'Webhook endpoint updated.' })
      } else {
        clearWorkspace()
        setNotice({ key: 'Webhook endpoint deleted.' })
        void load()
      }
    } catch (error) {
      if (!signal.aborted) writeError(error, action)
    } finally {
      if (!signal.aborted) {
        write.current = null
        setBusy(false)
      }
    }
  }

  return (
    <div className="webhook-settings stack">
      {!headingRef && (
        <h3 ref={listHeading} tabIndex={-1}>
          {t('Webhooks')}
        </h3>
      )}
      {checking && <p role="status">{t('Checking webhook access…')}</p>}
      <div hidden={checking}>
        {list.status === 'conflict' && <OrganizationContextConflict error={list.error} />}
        {list.status === 'denied' && <p role="alert">{t('Webhook endpoints are unavailable.')}</p>}
        {list.status === 'loading' && <p role="status">{t('Loading webhook endpoints…')}</p>}
        {list.status === 'error' && (
          <div className="alert alert-error" role="alert">
            <p>{t('Could not load webhook endpoints.')}</p>
            <button className="button" type="button" onClick={() => void load()}>
              {t('Try again')}
            </button>
          </div>
        )}
        {notice && (
          <p
            className={notice.error ? 'alert alert-error' : undefined}
            role={notice.error ? 'alert' : 'status'}
          >
            {t(notice.key)}
          </p>
        )}
        {list.status === 'unconfirmed' && (
          <button className="button" type="button" onClick={() => void load()}>
            {t('Refresh webhook endpoints')}
          </button>
        )}
        {busy && <p role="status">{t('Saving webhook settings…')}</p>}
        {list.status === 'ready' && (
          <div hidden={form !== null || secret !== null}>
            <WebhookList
              endpoints={list.endpoints}
              busy={busy}
              onCreate={(opener) => {
                formOpener.current = opener
                setNotice(null)
                setForm({ type: 'create', draft: newDraft() })
              }}
              onEdit={(id, opener) => {
                const endpoint = list.endpoints.find((candidate) => candidate.id === id)
                if (!endpoint) return
                formOpener.current = opener
                setNotice(null)
                setForm({ type: 'edit', id, events: endpoint.events.filter(isWebhookEvent) })
              }}
            />
          </div>
        )}
        {form?.type === 'create' && (
          <WebhookCreateForm
            draft={form.draft}
            busy={busy}
            workflowsEnabled={workflowsEnabled}
            onChange={(draft) => setForm({ type: 'create', draft })}
            onSave={() => void save({ type: 'create', draft: form.draft })}
            onCancel={closeForm}
          />
        )}
        {form?.type === 'edit' && selected && (
          <div hidden={confirmation !== null || secret !== null}>
            <WebhookEditor
              endpoint={selected}
              events={form.events}
              onEventsChange={(events) => setForm({ ...form, events })}
              onSaveEvents={() =>
                void save({ type: 'events', id: selected.id, events: form.events })
              }
              onSetActive={(isActive) => void save({ type: 'active', id: selected.id, isActive })}
              onConfirm={(action, opener) => {
                setNotice(null)
                confirmOpener.current = opener
                setConfirmation(action)
              }}
              onClose={closeForm}
              workflowsEnabled={workflowsEnabled}
              busy={busy}
            />
          </div>
        )}
        {confirmation && selected && (
          <WebhookConfirm
            action={confirmation}
            endpoint={selected}
            busy={busy}
            onCancel={closeConfirmation}
            onConfirm={() => void save({ type: confirmation, id: selected.id })}
          />
        )}
        {secret !== null && <WebhookSecret secret={secret} onDismiss={revealDismissed} />}
      </div>
    </div>
  )
}
