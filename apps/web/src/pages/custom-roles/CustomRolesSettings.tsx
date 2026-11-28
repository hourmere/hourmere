import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  type CustomTeamRole,
  changeCustomRole,
  changePermissionsMode,
  loadCustomRoles,
  loadPermissionsMode,
} from '../../api/custom-roles.ts'
import { RequestError } from '../../api/errors.ts'
import { BreakableText } from '../../components/BreakableText.tsx'
import { Field } from '../../components/forms.tsx'
import { useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import { useUnsavedChanges } from '../../unsaved-changes.tsx'
import { permissionAreas, permissionLabels, phaseOnePermissions } from './permissions.ts'
import { type RoleProofContext, RoleWriteFeedback, useRoleWrite } from './role-write.tsx'

type View = {
  mode: Awaited<ReturnType<typeof loadPermissionsMode>>
  roles: CustomTeamRole[]
}
type RoleEdit = { kind: 'create' } | { kind: 'publish' | 'archive'; role: CustomTeamRole }

export function useCustomRolesSettings(teamId: string, available: boolean) {
  const load = useCallback(
    async (signal: AbortSignal): Promise<View | null> => {
      if (!available) return null
      try {
        const mode = await loadPermissionsMode(teamId, signal)
        return { mode, roles: mode.enabled ? await loadCustomRoles(teamId, signal) : [] }
      } catch (cause) {
        if (cause instanceof RequestError && cause.code === 'custom_roles_disabled') return null
        throw cause
      }
    },
    [teamId, available],
  )
  const [view, reload] = useLoad(load)
  return { view, reload }
}

export function CustomRolesSettings({
  context,
  settings,
}: {
  context: RoleProofContext
  settings: ReturnType<typeof useCustomRolesSettings>
}) {
  const { t } = useI18n()
  const { view, reload } = settings
  if (view.status === 'ready' && !view.data) return null
  return (
    <section className="panel stack" aria-labelledby="custom-roles-heading">
      <h2 id="custom-roles-heading">{t('Roles and permissions')}</h2>
      {view.status === 'loading' && <p role="status">{t('Loading custom roles…')}</p>}
      {view.status === 'error' && (
        <div role="alert" className="alert alert-error">
          <p>{t('Could not load custom roles.')}</p>
          <button type="button" className="button button-small" onClick={reload}>
            {t('Try again')}
          </button>
        </div>
      )}
      {view.status === 'ready' && view.data && (
        <RoleSettings context={context} data={view.data} reload={reload} />
      )}
    </section>
  )
}

function RoleSettings({
  context,
  data,
  reload,
}: {
  context: RoleProofContext
  data: View
  reload: () => void
}) {
  const { t } = useI18n()
  const [confirmMode, setConfirmMode] = useState(false)
  const [refreshing, setRefreshing] = useState<View | null>(null)
  const [edit, setEdit] = useState<RoleEdit | null>(null)
  const [status, setStatus] = useState<MessageKey | null>(null)
  const action = useRoleWrite()
  const modeButton = useRef<HTMLButtonElement>(null)
  const modeReview = useId()
  const modeCancel = useRef<HTMLButtonElement>(null)
  const editOpener = useRef<HTMLButtonElement | null>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const { mode, roles } = data
  const loading = data === refreshing
  const currentData = !loading

  function refresh() {
    setRefreshing(data)
    reload()
  }

  function open(edit: RoleEdit, button: HTMLButtonElement) {
    editOpener.current = button
    setEdit(edit)
    setStatus(null)
  }

  function closeEdit(outcome?: MessageKey) {
    setEdit(null)
    if (outcome) {
      setStatus(outcome)
      refresh()
    }
  }

  useEffect(() => {
    if (confirmMode) modeCancel.current?.focus()
    else if (status) statusRef.current?.focus()
  }, [confirmMode, status])

  useEffect(() => {
    if (edit) return
    const opener = editOpener.current
    if (!opener) return
    editOpener.current = null
    if (!status) opener.focus()
  }, [edit, status])

  const blocking = !currentData || action.disabled || edit !== null
  const editing = mode.enabled && currentData ? edit : null

  return (
    <>
      <dl className="details">
        <dt>{t('Member')}</dt>
        <dd>
          {t(
            'Shared team roster and event types, plus personal settings and assigned-host actions.',
          )}
        </dd>
        <dt>{t('Admin')}</dt>
        <dd>
          {t(
            'Member access plus team settings, invitations, eligible member removal, scheduling and team integrations.',
          )}
        </dd>
        <dt>{t('Owner')}</dt>
        <dd>
          {t(
            'Admin access plus fixed role changes, ownership transfer, audit retention and custom role management.',
          )}
        </dd>
      </dl>
      <p className="hint">
        {t(
          'Fixed roles are read-only here. Custom roles keep base Member access. They cannot grant member management, private booking data or team exports.',
        )}
      </p>
      <p>
        {t(
          mode.enabled
            ? 'Custom roles are on for this team.'
            : 'Custom roles are off for this team.',
        )}
      </p>
      <button
        type="button"
        className="button"
        ref={modeButton}
        disabled={blocking || confirmMode}
        aria-expanded={confirmMode}
        aria-controls={confirmMode ? modeReview : undefined}
        onClick={() => {
          setStatus(null)
          setConfirmMode(true)
        }}
      >
        {t(mode.enabled ? 'Turn off custom roles' : 'Turn on custom roles')}
      </button>
      {confirmMode && (
        <>
          <RoleWriteFeedback
            action={action}
            context={context}
            onReload={() => {
              action.clearFailure()
              setConfirmMode(false)
              refresh()
            }}
          />
          <div id={modeReview} className="confirm stack" inert={action.pending !== null}>
            <p>
              {t(
                mode.enabled
                  ? 'Turning off custom roles pauses their additional access and keeps the saved roles and assignments.'
                  : 'Turning on custom roles lets owners publish roles and assign them to eligible Members.',
              )}
            </p>
            <p aria-live="polite">
              {t('Members assigned a custom role who must renew after activation: {count}', {
                count: mode.renewals.length,
              })}
            </p>
            {mode.renewals.length > 0 && (
              <ul>
                {mode.renewals.map((membership) => (
                  <li key={membership.memberId} className="user-content">
                    <bdi>
                      <BreakableText>
                        {membership.name.trim() || t('Unnamed team member')}
                      </BreakableText>
                    </bdi>
                  </li>
                ))}
              </ul>
            )}
            <div className="form-actions">
              <button
                type="button"
                ref={modeCancel}
                className="button"
                disabled={action.busy}
                onClick={() => {
                  setConfirmMode(false)
                  // The opener becomes focusable after this render.
                  requestAnimationFrame(() => modeButton.current?.focus())
                }}
              >
                {t('Cancel')}
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={action.disabled || !currentData}
                onClick={() =>
                  action.write(
                    (signal, proofAttemptId) =>
                      changePermissionsMode(
                        context.organizationId,
                        !mode.enabled,
                        mode.policyVersion,
                        signal,
                        proofAttemptId,
                      ),
                    () => {
                      setConfirmMode(false)
                      setStatus(
                        mode.enabled ? 'Custom roles turned off.' : 'Custom roles turned on.',
                      )
                      refresh()
                    },
                  )
                }
              >
                {t(
                  mode.enabled
                    ? 'Confirm turning off custom roles'
                    : 'Confirm turning on custom roles',
                )}
              </button>
            </div>
          </div>
        </>
      )}
      {status && (
        <p role="status" tabIndex={-1} ref={statusRef}>
          {t(status)}
        </p>
      )}
      {mode.enabled && (
        <>
          <h3>{t('Custom roles')}</h3>
          <button
            type="button"
            className="button button-primary"
            disabled={blocking || confirmMode}
            onClick={(event) => open({ kind: 'create' }, event.currentTarget)}
          >
            {t('Create custom role')}
          </button>
          {roles.length === 0 ? (
            <p>{t('No custom roles have been published.')}</p>
          ) : (
            <ul className="stack">
              {roles.map((role) => (
                <li key={role.id}>
                  <p className="user-content">
                    <bdi>
                      <BreakableText>{role.name}</BreakableText>
                    </bdi>
                    {' · '}
                    <span>{t('Revision {revision}', { revision: role.revision })}</span>
                  </p>
                  <div className="form-actions">
                    <button
                      type="button"
                      className="button button-small"
                      aria-label={t('Edit custom role {name}', { name: role.name })}
                      disabled={blocking || confirmMode}
                      onClick={(event) => open({ kind: 'publish', role }, event.currentTarget)}
                    >
                      {t('Edit custom role')}
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      aria-label={t('Archive custom role {name}', { name: role.name })}
                      disabled={blocking || confirmMode}
                      onClick={(event) => open({ kind: 'archive', role }, event.currentTarget)}
                    >
                      {t('Archive custom role')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {editing && (
        <RoleEditor
          key={
            editing.kind === 'create'
              ? 'create'
              : `${editing.kind}:${editing.role.id}:${editing.role.revision}`
          }
          context={context}
          edit={editing}
          onClose={closeEdit}
          onReload={() => {
            closeEdit()
            refresh()
          }}
        />
      )}
      {loading && <p role="status">{t('Loading custom roles…')}</p>}
    </>
  )
}

function RoleEditor({
  context,
  edit,
  onClose,
  onReload,
}: {
  context: RoleProofContext
  edit: RoleEdit
  onClose: (status?: MessageKey) => void
  onReload: () => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState(edit.kind === 'create' ? '' : edit.role.name)
  const initial = edit.kind === 'create' ? [] : phaseOnePermissions(edit.role.permissionIds)
  const [ids, setIds] = useState(initial)
  const action = useRoleWrite()
  const titleId = useId()
  const nameId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const isArchive = edit.kind === 'archive'
  const changed =
    !isArchive &&
    (name !== (edit.kind === 'create' ? '' : edit.role.name) ||
      ids.length !== initial.length ||
      ids.some((id) => !initial.includes(id)))
  useUnsavedChanges(changed)
  useEffect(() => heading.current?.focus(), [])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const definition = { name: name.trim(), permissionIds: ids }
    const change =
      edit.kind === 'create'
        ? { kind: edit.kind, definition }
        : {
            kind: edit.kind,
            roleId: edit.role.id,
            expectedRevision: edit.role.revision,
            definition,
          }
    action.write(
      (signal, proofAttemptId) =>
        changeCustomRole(context.organizationId, change, signal, proofAttemptId),
      () => onClose(isArchive ? 'Custom role archived.' : 'Custom role published.'),
    )
  }

  return (
    <section className="panel stack" aria-labelledby={titleId}>
      <h3 id={titleId} tabIndex={-1} ref={heading}>
        {t(
          isArchive
            ? 'Archive custom role'
            : edit.kind === 'create'
              ? 'Create custom role'
              : 'Edit custom role',
        )}
      </h3>
      <RoleWriteFeedback action={action} context={context} onReload={onReload} />
      <form className="stack" onSubmit={submit} inert={action.pending !== null}>
        {isArchive ? (
          <>
            <p className="user-content">
              <bdi>
                <BreakableText>{edit.role.name}</BreakableText>
              </bdi>
            </p>
            <p>
              {t(
                'Archiving removes the role from future assignments and keeps its revision history.',
              )}
            </p>
          </>
        ) : (
          <>
            <Field id={nameId} label={t('Custom role name')}>
              {(props) => (
                <input
                  {...props}
                  value={name}
                  dir="auto"
                  required
                  maxLength={100}
                  disabled={action.disabled}
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              )}
            </Field>
            <p className="hint">
              {t(
                'Each preset adds only the actions shown. Base Member access continues in every area.',
              )}
            </p>
            {permissionAreas.map((area) => (
              <PermissionArea
                key={area.label}
                area={area}
                selected={ids}
                disabled={action.disabled}
                onChange={(next) =>
                  setIds((current) => [
                    ...current.filter((id) => !area.permissions.includes(id)),
                    ...next,
                  ])
                }
              />
            ))}
            {edit.kind === 'publish' && (
              <p>
                {t(
                  'Publishing updates every member assigned this role. Affected members must renew to use additional access.',
                )}
              </p>
            )}
          </>
        )}
        <div className="form-actions">
          <button type="button" className="button" disabled={action.busy} onClick={() => onClose()}>
            {t('Cancel')}
          </button>
          <button
            type="submit"
            className={`button ${isArchive ? 'button-danger' : 'button-primary'}`}
            disabled={action.disabled || (!isArchive && (!name.trim() || !changed))}
          >
            {t(
              isArchive
                ? 'Confirm archive'
                : edit.kind === 'create'
                  ? 'Create and publish role'
                  : 'Publish new revision',
            )}
          </button>
        </div>
      </form>
    </section>
  )
}

type Permission = keyof typeof permissionLabels
type Preset = 'none' | 'read' | 'custom'

function PermissionArea({
  area,
  selected,
  disabled,
  onChange,
}: {
  area: (typeof permissionAreas)[number]
  selected: readonly Permission[]
  disabled: boolean
  onChange: (permissions: readonly Permission[]) => void
}) {
  const { t } = useI18n()
  const selectedInArea = area.permissions.filter((id) => selected.includes(id))
  const [preset, setPreset] = useState<Preset>(() =>
    selectedInArea.length === 0
      ? 'none'
      : selectedInArea.length === area.read.length &&
          area.read.every((id) => selectedInArea.includes(id))
        ? 'read'
        : 'custom',
  )
  const presetId = useId()
  return (
    <fieldset className="stack" disabled={disabled}>
      <legend>{t(area.label)}</legend>
      <Field id={presetId} label={t('Access preset for {area}', { area: t(area.label) })}>
        {(props) => (
          <select
            {...props}
            value={preset}
            onChange={(event) => {
              const value = event.currentTarget.value as Preset
              setPreset(value)
              if (value !== 'custom') onChange(value === 'read' ? area.read : [])
            }}
          >
            <option value="none">{t('No additional access')}</option>
            <option value="read">{t('Read only')}</option>
            <option value="custom">{t('Custom')}</option>
          </select>
        )}
      </Field>
      {preset === 'custom' ? (
        <div className="stack">
          {area.permissions.map((id) => (
            <label key={id} className="checkbox-row">
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={(event) =>
                  onChange(
                    event.currentTarget.checked
                      ? [...selectedInArea, id]
                      : selectedInArea.filter((value) => value !== id),
                  )
                }
              />
              {t(permissionLabels[id])}
            </label>
          ))}
        </div>
      ) : preset === 'read' ? (
        <ul>
          {area.read.map((id) => (
            <li key={id}>{t(permissionLabels[id])}</li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  )
}
