import './SpaceSwitcher.css'
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  getActiveOrganizationMember,
  listOrganizations,
  setActiveOrganization,
} from '../api/auth.ts'
import { api, unwrap } from '../api/client.ts'
import { useLoad } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import { literal, msg, type UiText } from '../i18n/translate.ts'
import { useMe, useSession } from '../session.tsx'
import { useConfirmLeave } from '../unsaved-changes.tsx'

// /organization/list has no personal marker. Remember only a personal ID confirmed by
// /me, as a display hint across the context remount; it never grants access.
let knownPersonal: { userId: string; organizationId: string } | null = null
let handoffFocus: { userId: string; organizationId: string } | null = null

export function SpaceSwitcher({ onError }: { onError: (error: UiText | null) => void }) {
  const { t } = useI18n()
  const me = useMe()
  const { accept, beginContextSwitch } = useSession()
  const confirmLeave = useConfirmLeave()
  const [organizations, reloadOrganizations] = useLoad(listOrganizations)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const firstFocus = useRef<'current' | 'first' | 'last'>('current')
  const switching = useRef<{ controller: AbortController; release: () => void } | null>(null)
  const menuId = useId()
  const contextId = useId()
  const triggerLabelId = useId()
  const userId = me.user.id
  const organizationId = me.organization.id
  const personalId = me.organization.personal
    ? organizationId
    : knownPersonal?.userId === userId
      ? knownPersonal.organizationId
      : null

  const loadRole = useCallback(
    async (signal: AbortSignal) => {
      if (me.organization.personal) return ['owner']
      const member = await getActiveOrganizationMember(signal)
      const roles = member.role.split(',').map((role) => role.trim())
      if (
        member.userId !== me.user.id ||
        member.organizationId !== me.organization.id ||
        !roles.length ||
        roles.some((role) => !['owner', 'admin', 'member'].includes(role))
      ) {
        throw new Error('Membership does not match the displayed context')
      }
      return [...new Set(roles)]
    },
    [me],
  )
  const [role, reloadRole] = useLoad(loadRole)
  const roleLabels: Record<string, string> = {
    owner: t('Owner'),
    admin: t('Admin'),
    member: t('Member'),
  }
  const currentName = me.organization.personal ? t('Personal') : me.organization.name
  const options = [
    { id: null, name: t('Personal'), current: me.organization.personal },
    ...(organizations.status === 'ready'
      ? organizations.data
          .filter((organization) => organization.id !== personalId)
          .map((organization) => ({
            id: organization.id,
            name: organization.name,
            current: organization.id === organizationId,
          }))
      : []),
  ]
  const selected = Math.max(
    0,
    options.findIndex((option) => option.current),
  )

  useEffect(() => {
    if (me.organization.personal) knownPersonal = { userId, organizationId }
    if (handoffFocus?.userId === userId && handoffFocus.organizationId === organizationId) {
      handoffFocus = null
      trigger.current?.focus()
    }
    return () => {
      switching.current?.controller.abort()
      switching.current?.release()
    }
  }, [userId, organizationId, me.organization.personal])

  // Focus moves into the menu only when opening it; a delayed list response must not
  // interrupt someone already navigating its items.
  // biome-ignore lint/correctness/useExhaustiveDependencies: options are read at the moment the menu opens
  useEffect(() => {
    if (!open) return
    const index =
      firstFocus.current === 'first'
        ? 0
        : firstFocus.current === 'last'
          ? options.length - 1
          : selected
    items.current[index]?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [open])

  function closeMenu(returnFocus = true) {
    setOpen(false)
    if (returnFocus) trigger.current?.focus()
  }

  function openMenu(position: 'current' | 'first' | 'last' = 'current') {
    if (busy || switching.current) return
    firstFocus.current = position
    if (organizations.status !== 'loading') reloadOrganizations()
    if (role.status !== 'loading') reloadRole()
    setOpen(true)
  }

  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = items.current.indexOf(document.activeElement as HTMLButtonElement | null)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      return
    }
    let next: number | undefined
    if (event.key === 'ArrowDown') next = (index + 1) % options.length
    if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = options.length - 1
    if (next !== undefined) {
      event.preventDefault()
      items.current[next]?.focus()
    }
  }

  async function choose(option: (typeof options)[number]) {
    if (busy || switching.current) return
    if (option.current) {
      closeMenu()
      return
    }
    // Ask before the write: cancelling must not change the server's active context.
    if (!confirmLeave()) {
      closeMenu()
      return
    }
    closeMenu()
    onError(null)
    setBusy(true)
    const controller = new AbortController()
    const release = beginContextSwitch()
    switching.current = { controller, release }
    try {
      await setActiveOrganization({ organizationId: option.id }, controller.signal)
      const confirmed = await unwrap(api.GET('/api/v1/me', { signal: controller.signal }))
      if (controller.signal.aborted) return
      if (
        confirmed.user.id !== userId ||
        (option.id === null
          ? !confirmed.organization.personal
          : confirmed.organization.id !== option.id)
      ) {
        throw new Error('The selected context could not be confirmed')
      }
      handoffFocus = { userId, organizationId: confirmed.organization.id }
      accept(confirmed)
    } catch {
      if (!controller.signal.aborted) {
        onError(
          msg('Could not switch spaces. You are still in {space}. Please try again.', {
            space: me.organization.personal ? msg('Personal') : literal(me.organization.name),
          }),
        )
      }
    } finally {
      release()
      if (!controller.signal.aborted) setBusy(false)
      if (switching.current?.controller === controller) switching.current = null
    }
  }

  return (
    <div className="space-switcher" ref={container}>
      <button
        type="button"
        className="button space-trigger"
        ref={trigger}
        aria-labelledby={`${triggerLabelId} ${contextId}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-disabled={busy}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            openMenu(event.key === 'ArrowUp' ? 'last' : 'first')
          }
        }}
      >
        <span className="visually-hidden" id={triggerLabelId}>
          {t('Switch space')}
        </span>
        <span className="space-context" id={contextId}>
          <span className="space-name" title={currentName}>
            {currentName}
          </span>
          <span className="space-role">
            {busy
              ? t('Switching space…')
              : role.status === 'ready'
                ? role.data.map((value) => roleLabels[value]).join(', ')
                : role.status === 'loading'
                  ? t('Checking role…')
                  : t('Role unavailable')}
          </span>
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="space-popup">
          <div
            className="space-menu"
            id={menuId}
            role="menu"
            aria-label={t('Spaces')}
            onKeyDown={menuKey}
          >
            {options.map((option, index) => (
              <button
                key={option.id ?? 'personal'}
                type="button"
                role="menuitemradio"
                aria-checked={option.current}
                tabIndex={-1}
                ref={(element) => {
                  items.current[index] = element
                }}
                onClick={() => void choose(option)}
              >
                <span className="space-name" title={option.name}>
                  {option.name}
                </span>
                {option.current && <span className="space-current">{t('Current space')}</span>}
              </button>
            ))}
          </div>
          {organizations.status === 'loading' && <p role="status">{t('Loading spaces…')}</p>}
          {organizations.status === 'error' && (
            <div className="space-load-error">
              <p role="alert">{t('Could not load teams. Please try again.')}</p>
              <button type="button" className="button button-small" onClick={reloadOrganizations}>
                {t('Try again')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
