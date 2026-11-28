import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { SsoFreshProof } from '../sso/SsoFreshProof.tsx'
import { type SsoProofChallenge, SsoProofRequired } from '../sso/setup.ts'
import '../sso/sso-setup.css'

type Write<T> = (signal: AbortSignal, proofAttemptId?: string) => Promise<T>

function roleFailure(error: unknown): {
  message: MessageKey
  reload?: boolean
  reloadContext?: boolean
} {
  if (isOrganizationContextChanged(error))
    return {
      message: 'Your team context changed. Reload before making changes.',
      reload: true,
      reloadContext: true,
    }
  if (error instanceof RequestError) {
    if (error.code === 'role_in_use')
      return { message: 'Clear this role’s assignments before archiving it.' }
    if (error.code === 'custom_role_ambiguous_memberships')
      return {
        message:
          'Some memberships have an ambiguous fixed role. Resolve their roles before turning on custom roles.',
      }
    if (error.status === 409)
      return { message: 'The role or assignment changed. Reload before saving.', reload: true }
    if (error.status === 403)
      return { message: 'Your access to make this change could not be verified.', reload: true }
    if (error.status === 404) return { message: 'Custom roles are unavailable.', reload: true }
  }
  return { message: 'The change could not be saved. Try again.' }
}

export function useRoleWrite() {
  const active = useRef<AbortController | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const failureRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ReturnType<typeof roleFailure> | null>(null)
  const [pending, setPending] = useState<{
    challenge: SsoProofChallenge
    retry: (id: string) => Promise<void>
  } | null>(null)

  useLayoutEffect(() => {
    function reset() {
      active.current?.abort()
      active.current = null
      opener.current = null
      setBusy(false)
      setPending(null)
      setFailure(null)
    }
    window.addEventListener('pagehide', reset)
    return () => {
      active.current?.abort()
      window.removeEventListener('pagehide', reset)
    }
  }, [])

  useEffect(() => {
    if (failure) failureRef.current?.focus()
    else if (!pending && !busy && opener.current) opener.current.focus()
    if (!pending && !busy) opener.current = null
  }, [busy, failure, pending])

  function write<T>(attempt: Write<T>, onSuccess: (result: T) => void) {
    async function run(proofAttemptId?: string) {
      if (active.current) return
      const controller = new AbortController()
      active.current = controller
      setBusy(true)
      setFailure(null)
      try {
        const result = await attempt(controller.signal, proofAttemptId)
        if (controller.signal.aborted) return
        setPending(null)
        onSuccess(result)
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof SsoProofRequired) {
          setPending({ challenge: error.challenge, retry: run })
        } else {
          setPending(null)
          setFailure(roleFailure(error))
        }
      } finally {
        if (active.current === controller) {
          active.current = null
          setBusy(false)
        }
      }
    }

    if (pending || failure?.reload || active.current) return
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void run()
  }

  return {
    write,
    busy,
    pending,
    failure,
    failureRef,
    disabled: busy || pending !== null || failure?.reload === true,
    cancelProof: () => setPending(null),
    clearFailure: () => setFailure(null),
  }
}

export type RoleProofContext = {
  organizationId: string
  stepUpProviders: { id: string; displayName: string }[]
  reloadContext: () => void
}

export function RoleWriteFeedback({
  action,
  context,
  onReload,
  title = 'Confirm your identity before changing team roles.',
}: {
  action: ReturnType<typeof useRoleWrite>
  context: RoleProofContext
  onReload: () => void
  title?: MessageKey
}) {
  const { t } = useI18n()
  const { failure, pending } = action
  return (
    <>
      {failure && (
        <div ref={action.failureRef} tabIndex={-1} role="alert" className="alert alert-error">
          <p>{t(failure.message)}</p>
          {failure.reload && (
            <button
              type="button"
              className="button button-small"
              onClick={failure.reloadContext ? context.reloadContext : onReload}
            >
              {t('Reload team')}
            </button>
          )}
        </div>
      )}
      {pending && (
        <SsoFreshProof
          key={pending.challenge.attemptId}
          organizationId={context.organizationId}
          stepUpProviders={context.stepUpProviders}
          challenge={pending.challenge}
          busy={action.busy}
          title={title}
          onRetry={() => void pending.retry(pending.challenge.attemptId)}
          onCancel={action.cancelProof}
        />
      )}
    </>
  )
}
