import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ListedOrganizationMember } from '../../api/auth.ts'
import {
  type CustomRoleAssignment,
  type CustomTeamRole,
  changeCustomRoleAssignment,
  loadCustomRoleAssignment,
} from '../../api/custom-roles.ts'
import { RequestError } from '../../api/errors.ts'
import { Field } from '../../components/forms.tsx'
import { UserContentMessage } from '../../components/UserContent.tsx'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { PermissionList } from './PermissionList.tsx'
import { type RoleProofContext, RoleWriteFeedback, useRoleWrite } from './role-write.tsx'

export function CustomRoleAssignmentButton({
  context,
  member,
  roles,
  disabled,
  onReviewChange,
  onReload,
}: {
  context: RoleProofContext
  member: ListedOrganizationMember
  roles: CustomTeamRole[]
  disabled: boolean
  onReviewChange: (open: boolean) => void
  onReload: () => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [version, setVersion] = useState(0)
  const [changed, setChanged] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const id = useId()
  const memberName = member.user.name.trim() || t('Unnamed team member')

  useEffect(() => {
    onReviewChange(open)
    return () => onReviewChange(false)
  }, [open, onReviewChange])

  useEffect(() => {
    if (!open && !disabled && restoreFocus.current) {
      restoreFocus.current = false
      opener.current?.focus()
    }
  }, [open, disabled])

  function close() {
    restoreFocus.current = true
    setOpen(false)
  }

  return (
    <div className="stack">
      <div className="form-actions">
        <button
          ref={opener}
          type="button"
          className="button button-small"
          disabled={disabled || open}
          aria-label={t('Change custom role for {name}', { name: memberName })}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => {
            setChanged(false)
            setOpen(true)
          }}
        >
          {t('Change custom role')}
        </button>
      </div>
      {changed && <p role="status">{t('Custom role assignment saved.')}</p>}
      {open && (
        <AssignmentReview
          key={version}
          id={id}
          context={context}
          member={member}
          roles={roles}
          onReload={() => {
            setVersion((value) => value + 1)
            onReload()
          }}
          onClose={close}
          onSaved={() => {
            setChanged(true)
            close()
          }}
        />
      )}
    </div>
  )
}

function AssignmentReview({
  id,
  context,
  member,
  roles,
  onClose,
  onSaved,
  onReload,
}: {
  id: string
  context: RoleProofContext
  member: ListedOrganizationMember
  roles: CustomTeamRole[]
  onClose: () => void
  onSaved: () => void
  onReload: () => void
}) {
  const { t } = useI18n()
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const assignment = await loadCustomRoleAssignment(context.organizationId, member.id, signal)
        if (assignment.memberId !== member.id) throw new Error('Membership did not match.')
        return assignment
      } catch (error) {
        if (error instanceof RequestError && error.status === 403) return null
        throw error
      }
    },
    [context.organizationId, member.id],
  )
  const [current, reload] = useLoad(load)
  const heading = useRef<HTMLHeadingElement>(null)
  const memberName = member.user.name.trim() || t('Unnamed team member')

  useEffect(() => heading.current?.focus(), [])

  return (
    <section className="panel stack" id={id} aria-labelledby={`${id}-title`}>
      <h3 ref={heading} id={`${id}-title`} tabIndex={-1}>
        <UserContentMessage message="Change custom role for {name}" values={{ name: memberName }} />
      </h3>
      {current.status === 'loading' && <p role="status">{t('Loading the current assignment…')}</p>}
      {current.status === 'ready' && !current.data && (
        <p role="alert">{t('Your access to this assignment could not be verified.')}</p>
      )}
      {current.status === 'error' && (
        <div role="alert" className="alert alert-error">
          <p>{t('Could not load the current assignment.')}</p>
          <button type="button" className="button" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {current.status === 'ready' && current.data ? (
        <AssignmentForm
          context={context}
          assignment={current.data}
          roles={roles}
          onClose={onClose}
          onSaved={onSaved}
          onReload={onReload}
        />
      ) : (
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose}>
            {t('Cancel')}
          </button>
        </div>
      )}
    </section>
  )
}

function AssignmentForm({
  context,
  assignment,
  roles,
  onClose,
  onSaved,
  onReload,
}: {
  context: RoleProofContext
  assignment: CustomRoleAssignment
  roles: CustomTeamRole[]
  onClose: () => void
  onSaved: () => void
  onReload: () => void
}) {
  const { t } = useI18n()
  const selectId = useId()
  const [nextId, setNextId] = useState(assignment.roleId ?? '')
  const action = useRoleWrite()
  const currentRole = roles.find(({ id }) => id === assignment.roleId)
  const currentStale = assignment.roleId !== null && currentRole?.revision !== assignment.revision
  const nextRole = roles.find(({ id }) => id === nextId)
  const previousIds = currentRole?.permissionIds ?? []
  const nextIds = nextRole?.permissionIds ?? []
  const added = nextIds.filter((id) => !previousIds.includes(id))
  const removed = previousIds.filter((id) => !nextIds.includes(id))
  const changed = nextId !== (assignment.roleId ?? '')
  return (
    <>
      <RoleWriteFeedback action={action} context={context} onReload={onReload} />
      <form
        className="stack"
        inert={action.pending !== null}
        onSubmit={(event) => {
          event.preventDefault()
          if (!changed || currentStale || (nextId && !nextRole)) return
          action.write(async (signal, proofAttemptId) => {
            const result = await changeCustomRoleAssignment(
              context.organizationId,
              assignment,
              nextRole ?? null,
              signal,
              proofAttemptId,
            )
            if (
              !('memberId' in result) ||
              result.memberId !== assignment.memberId ||
              result.roleId !== (nextRole?.id ?? null)
            )
              throw new Error('The assignment was not confirmed.')
          }, onSaved)
        }}
      >
        {currentStale ? (
          <div role="alert" className="alert alert-error">
            <p>{t('The role or assignment changed. Reload before saving.')}</p>
            <button type="button" className="button" onClick={onReload}>
              {t('Reload team')}
            </button>
          </div>
        ) : (
          <>
            <Field id={selectId} label={t('Custom role for this member')}>
              {(props) => (
                <select
                  {...props}
                  dir="auto"
                  value={nextId}
                  disabled={action.disabled}
                  onChange={(event) => setNextId(event.currentTarget.value)}
                >
                  <option value="">{t('Fixed Member only')}</option>
                  {roles.map((role) => (
                    <option value={role.id} key={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {changed && (
              <div className="stack" aria-live="polite">
                <p>{t('The member keeps base Member access.')}</p>
                <h4>{t('Additional actions gained')}</h4>
                <PermissionList ids={added} />
                <h4>{t('Additional actions lost')}</h4>
                <PermissionList ids={removed} />
                <p>
                  {t(
                    'Affected members must verify in their browser, replace their API keys and reconnect their MCP apps to use additional access.',
                  )}
                </p>
              </div>
            )}
          </>
        )}
        <div className="form-actions">
          <button type="button" className="button" onClick={onClose} disabled={action.busy}>
            {t('Cancel')}
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={action.disabled || currentStale || !changed || Boolean(nextId && !nextRole)}
          >
            {t('Save custom role assignment')}
          </button>
        </div>
      </form>
    </>
  )
}
