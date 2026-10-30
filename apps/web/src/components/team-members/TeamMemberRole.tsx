import { useEffect, useId, useRef, useState } from 'react'
import type { ListedOrganizationMember, OrganizationMember } from '../../api/auth.ts'
import { errorMessage, isOrganizationContextChanged, RequestError } from '../../api/errors.ts'
import { changeTeamMemberRole, type ManageableTeamRole } from '../../api/team-roles.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { BreakableText } from '../BreakableText.tsx'
import './TeamMemberRole.css'

function knownRoles(role: string | null) {
  const roles = role?.split(',').map((value) => value.trim()) ?? []
  return roles.length && roles.every((value) => ['owner', 'admin', 'member'].includes(value))
    ? roles
    : []
}

type RoleButtonProps = {
  organizationId: string
  member: ListedOrganizationMember
  role: string | null
  currentUserId?: string
  disabled?: boolean
  onChanged: (member: OrganizationMember) => void
  onReload: () => void
  onReviewChange?: (open: boolean) => void
}

export function RoleManagementNotice() {
  const { t } = useI18n()
  return (
    <div className="hint team-role-limits">
      <p>{t('Only owners can manage admins. Ownership transfer is not available yet.')}</p>
      <p>{t('Owner roles cannot be changed here. The team must retain at least one owner.')}</p>
    </div>
  )
}

/** Exact known tokens support legacy memberships without exposing owner controls. */
export function TeamMemberRoleButton(props: RoleButtonProps) {
  const actor = knownRoles(props.role)
  const target = knownRoles(props.member.role)
  if (
    !props.currentUserId ||
    props.member.organizationId.toLowerCase() !== props.organizationId.toLowerCase() ||
    props.currentUserId.toLowerCase() === props.member.userId.toLowerCase() ||
    !actor.includes('owner') ||
    !target.length ||
    target.includes('owner')
  )
    return null
  return (
    <RoleChange
      key={`${props.organizationId}:${props.member.id}:${props.member.userId}:${props.currentUserId}:${props.role}`}
      {...props}
      nextRole={target.includes('admin') ? 'member' : 'admin'}
    />
  )
}

function requiresReload(error: unknown) {
  return (
    error instanceof RequestError &&
    (error.status === 401 ||
      error.status === 403 ||
      error.status === 409 ||
      error.code === 'MEMBER_NOT_FOUND' ||
      error.code === 'MEMBER_DOES_NOT_EXIST' ||
      error.code === 'ROLE_CHANGE_UNCONFIRMED' ||
      error.code === 'member_departure_owner_required')
  )
}

function RoleChangeError({ error, onReload }: { error: unknown; onReload: () => void }) {
  const { t, ui } = useI18n()
  const request = error instanceof RequestError ? error : undefined
  let message = ui(errorMessage(error))
  if (request?.code === 'member_departure_owner_required')
    message = t(
      'The team must retain at least one owner. Ownership transfer is not available here.',
    )
  else if (isOrganizationContextChanged(error))
    message = t('Your team context changed. Reload before making changes.')
  else if (request?.status === 403)
    message = t(
      'This role change was denied. Your permission or this member’s team membership may have changed. Reload to check.',
    )
  else if (
    request?.status === 404 &&
    (request.code === 'MEMBER_NOT_FOUND' || request.code === 'MEMBER_DOES_NOT_EXIST')
  )
    message = t('This person is no longer a member of this team. Reload the member list.')
  else if (request?.status === 409)
    message = t(
      'This role change conflicts with the current team state. Reload before trying again.',
    )
  else if (request?.code === 'ROLE_CHANGE_UNCONFIRMED')
    message = t(
      'Could not confirm the role change. Reload to check this person’s current role before trying again.',
    )
  return (
    <div role="alert" className="alert alert-error">
      <p>{message}</p>
      {requiresReload(error) && (
        <button type="button" className="button button-small" onClick={onReload}>
          {t('Reload team')}
        </button>
      )}
    </div>
  )
}

function RoleChange({
  organizationId,
  member,
  nextRole,
  disabled = false,
  onChanged,
  onReload,
  onReviewChange,
}: RoleButtonProps & { nextRole: ManageableTeamRole }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [savedRole, setSavedRole] = useState<ManageableTeamRole | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const feedback = useRef<HTMLDivElement>(null)
  const active = useRef<AbortController | null>(null)
  const restoreFocus = useRef(false)
  const observedRole = useRef(member.role)
  observedRole.current = member.role
  const reviewId = useId()
  const headingId = useId()
  const name = member.user.name.trim() || t('Unnamed team member')
  const oldRole = nextRole === 'admin' ? t('Member') : t('Admin')
  const newRole = nextRole === 'admin' ? t('Admin') : t('Member')

  useEffect(() => {
    return () => active.current?.abort()
  }, [])
  useEffect(() => {
    active.current?.abort()
    active.current = null
    setOpen(false)
    setPending(false)
    setError(null)
    setSavedRole((previous) => (previous === member.role ? previous : null))
  }, [member.role])
  useEffect(() => {
    onReviewChange?.(open)
    return () => onReviewChange?.(false)
  }, [open, onReviewChange])
  useEffect(() => {
    if (open) heading.current?.focus()
  }, [open])
  useEffect(() => {
    if (!open && !disabled && restoreFocus.current) {
      restoreFocus.current = false
      button.current?.focus()
    }
  }, [open, disabled])
  useEffect(() => {
    if (error) feedback.current?.focus()
  }, [error])

  function close() {
    if (pending) return
    restoreFocus.current = true
    setOpen(false)
    setError((previous: unknown) => (requiresReload(previous) ? previous : null))
  }

  async function confirm() {
    if (pending || active.current || requiresReload(error)) return
    const controller = new AbortController()
    const openingRole = member.role
    active.current = controller
    setPending(true)
    setError(null)
    heading.current?.focus()
    const current = () =>
      active.current === controller &&
      !controller.signal.aborted &&
      observedRole.current === openingRole
    try {
      const updated = await changeTeamMemberRole(
        organizationId,
        member.id,
        nextRole,
        controller.signal,
      )
      if (!current()) return
      active.current = null
      restoreFocus.current = true
      setPending(false)
      setOpen(false)
      setSavedRole(updated.role as ManageableTeamRole)
      onChanged(updated)
    } catch (err) {
      if (!current()) return
      active.current = null
      setPending(false)
      setError(err)
    }
  }

  return (
    <div className="team-member-role">
      <button
        ref={button}
        type="button"
        className="button button-small"
        disabled={disabled || open}
        aria-expanded={open}
        aria-controls={open ? reviewId : undefined}
        aria-label={t(nextRole === 'admin' ? 'Make admin: {0}' : 'Make member: {0}', { '0': name })}
        onClick={() => {
          setError((previous: unknown) => (requiresReload(previous) ? previous : null))
          setSavedRole(null)
          setOpen(true)
        }}
      >
        {t(nextRole === 'admin' ? 'Make admin' : 'Make member')}
      </button>
      {savedRole && (
        <p role="status">
          {t('{name} is now {role}.', {
            name,
            role: savedRole === 'admin' ? t('Admin') : t('Member'),
          })}
        </p>
      )}
      {open && (
        <section
          id={reviewId}
          className="team-member-role-review"
          aria-labelledby={headingId}
          aria-busy={pending}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close()
            }
          }}
        >
          <h3 id={headingId} ref={heading} tabIndex={-1}>
            {t('Change team role')}
          </h3>
          <p className="user-content">
            <BreakableText>
              {t('Change {name} from {oldRole} to {newRole}?', { name, oldRole, newRole })}
            </BreakableText>
          </p>
          <p>
            {t(
              nextRole === 'admin'
                ? 'They will gain admin permissions.'
                : 'They will lose admin permissions and keep member access.',
            )}
          </p>
          <p>
            {t(
              'Admins can invite and remove ordinary members, manage team events, and view team bookings and cancel them before they start.',
            )}
          </p>
          <p>
            {t(
              'Members can view team members and manage their own availability, calendars and hosted bookings.',
            )}
          </p>
          <div ref={feedback} tabIndex={-1}>
            {error != null && <RoleChangeError error={error} onReload={onReload} />}
          </div>
          <div className="team-member-role-controls">
            <button
              type="button"
              className="button button-small"
              disabled={pending}
              onClick={close}
            >
              {t('Cancel')}
            </button>
            <button
              type="button"
              className="button button-small button-primary"
              disabled={pending || requiresReload(error)}
              onClick={() => void confirm()}
            >
              {t(pending ? 'Changing role…' : 'Confirm role change')}
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
