import { useCallback, useEffect, useRef, useState } from 'react'
import { loadTeamPermissions, renewTeamPermissions } from '../../api/custom-roles.ts'
import { RequestError } from '../../api/errors.ts'
import { type Loaded, useLoad } from '../../hooks.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import { PermissionList } from './PermissionList.tsx'
import { fixedRoleLabel } from './permissions.ts'
import { type RoleProofContext, RoleWriteFeedback, useRoleWrite } from './role-write.tsx'

type Permissions = Awaited<ReturnType<typeof loadTeamPermissions>>

export function useCustomRolePermissions(organizationId: string, available: boolean) {
  const load = useCallback(
    async (signal: AbortSignal): Promise<Permissions | null> => {
      if (!available) return null
      try {
        return await loadTeamPermissions(organizationId, signal)
      } catch (error) {
        if (error instanceof RequestError && error.code === 'custom_roles_disabled') return null
        throw error
      }
    },
    [organizationId, available],
  )
  const [state, reload] = useLoad(load)
  const [refreshing, setRefreshing] = useState<typeof state | null>(null)
  const status: Loaded<Permissions | null> = state === refreshing ? { status: 'loading' } : state
  const refresh = () => {
    setRefreshing(state)
    reload()
  }
  return { status, refresh }
}

export function CustomRoleRenewal({
  context,
  view,
  onRenewed,
}: {
  context: RoleProofContext
  view: ReturnType<typeof useCustomRolePermissions>
  onRenewed: () => void
}) {
  const { t } = useI18n()
  const { status, refresh } = view
  const [renewed, setRenewed] = useState(false)
  const feedback = useRef<HTMLParagraphElement>(null)
  const permissions = status.status === 'ready' ? status.data : null
  useEffect(() => {
    if (renewed && permissions && !permissions.renewalRequired) feedback.current?.focus()
  }, [permissions, renewed])

  if (status.status === 'error')
    return (
      <div role="alert" className="alert alert-error">
        <p>{t('Your current team access could not be checked.')}</p>
        <button type="button" className="button button-small" onClick={refresh}>
          {t('Try again')}
        </button>
      </div>
    )
  if (!permissions) return null
  const allowedActions = permissions.decisions
    .filter(({ source, allowed }) => source === 'custom' && allowed)
    .map(({ operation }) => operation)
  if (!permissions.renewalRequired)
    return (
      <>
        {renewed && (
          <p role="status" tabIndex={-1} ref={feedback}>
            {t('Your team access was renewed.')}
          </p>
        )}
        {allowedActions.length > 0 && (
          <section className="panel stack" aria-labelledby="team-custom-actions-heading">
            <h2 id="team-custom-actions-heading">{t('Team actions available in this browser')}</h2>
            <p>{t('Your custom role adds these actions in this team.')}</p>
            <PermissionList ids={allowedActions} />
          </section>
        )}
      </>
    )
  if (!permissions.policyVersion || !permissions.membershipGeneration) return null
  const { policyVersion, membershipGeneration: generation, permissionIds } = permissions
  return (
    <RenewalReview
      key={`${policyVersion.masterEpoch}:${policyVersion.teamEpoch}:${generation}`}
      context={context}
      version={policyVersion}
      generation={generation}
      permissionIds={permissionIds}
      fixedRole={fixedRoleLabel(permissions.fixedRole)}
      onReload={refresh}
      onRenewed={() => {
        setRenewed(true)
        refresh()
        onRenewed()
      }}
    />
  )
}

function RenewalReview({
  context,
  version,
  generation,
  permissionIds,
  fixedRole,
  onReload,
  onRenewed,
}: {
  context: RoleProofContext
  version: Parameters<typeof renewTeamPermissions>[1]
  generation: number
  permissionIds: string[]
  fixedRole: ReturnType<typeof fixedRoleLabel>
  onReload: () => void
  onRenewed: () => void
}) {
  const { t } = useI18n()
  const action = useRoleWrite()
  return (
    <section className="panel stack" aria-labelledby="team-access-renewal-heading">
      <h2 id="team-access-renewal-heading">{t('Renew team access')}</h2>
      <p>
        {t(
          'Your team permissions changed. Verify your identity to use your current access in this browser.',
        )}
      </p>
      {fixedRole && <p>{t('Base team role: {role}', { role: t(fixedRole) })}</p>}
      <PermissionList ids={permissionIds} empty="Your fixed team role applies." />
      <p>{t('Replace affected API keys and reconnect affected MCP apps separately.')}</p>
      <RoleWriteFeedback
        action={action}
        context={context}
        onReload={onReload}
        title="Confirm your identity to renew team access."
      />
      <div className="form-actions" inert={action.pending !== null}>
        <button
          type="button"
          className="button button-primary"
          disabled={action.disabled}
          onClick={() =>
            action.write(
              (signal, proofAttemptId) =>
                renewTeamPermissions(
                  context.organizationId,
                  version,
                  generation,
                  signal,
                  proofAttemptId,
                ),
              onRenewed,
            )
          }
        >
          {t('Verify and renew team access')}
        </button>
      </div>
    </section>
  )
}
