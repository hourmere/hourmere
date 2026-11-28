import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../api/client.ts'
import { chooseLanguage } from '../i18n/store.ts'
import { PATHS } from '../paths.ts'
import {
  emptyTeamLists,
  fakeApi,
  json,
  ME,
  profile,
  renderApp,
  signedInAs,
} from '../test/fake-api.tsx'

const team = {
  id: '00000000-0000-7000-8000-000000000031',
  name: 'Coordinator team',
  slug: 'coordinators',
  personal: false,
}
const memberId = '00000000-0000-7000-8000-000000000032'
const userId = '00000000-0000-7000-8000-000000000033'
const roleId = '00000000-0000-7000-8000-000000000034'
const secondRoleId = '00000000-0000-7000-8000-000000000035'
const attemptId = '00000000-0000-7000-8000-000000000037'
const base = `/api/v1/teams/${team.id}`
const rolesPath = `${base}/roles`
const modePath = `${base}/permissions-mode`
const assignmentPath = `${base}/members/${memberId}/custom-role`
const permissionsPath = `${base}/permissions`
const policyVersion = { masterEpoch: 4, teamEpoch: 6 }
const defaultPermissions: Schemas['TeamPermissions'] = {
  decisions: [],
  membershipGeneration: 1,
  permissionIds: [],
  policyVersion,
  renewalRequired: false,
}
const coordinator: Schemas['CustomTeamRole'] = {
  id: roleId,
  revision: 1,
  name: 'Coordinator',
  catalogueVersion: 1,
  archived: false,
  permissionIds: ['branding.read'],
}
const activityViewer: Schemas['CustomTeamRole'] = {
  ...coordinator,
  id: secondRoleId,
  name: 'Activity viewer',
  permissionIds: ['analytics.read'],
}

function settings({
  actor = 'owner',
  available = true,
  renewalAvailable = false,
  enabled = true,
  initial = [] as Schemas['CustomTeamRole'][],
  permissions = defaultPermissions,
  proof = false,
} = {}) {
  let roles = [...initial]
  let mode = enabled
  let teamEpoch = policyVersion.teamEpoch
  let authorization = permissions
  let assignment = {
    kind: 'assignment',
    memberId,
    generation: 4,
    roleId: initial[0]?.id ?? null,
    revision: initial[0]?.revision ?? null,
  }
  const viewer = { ...ME, organization: team }
  const admin = userId.replace('33', '99')
  let stale = false

  const requests = fakeApi({
    ...signedInAs(viewer),
    ...emptyTeamLists,
    ...profile(),
    'GET /api/v1/instance': () =>
      json(200, {
        ...(available && { customRolesAvailable: true }),
        ...(renewalAvailable && { customRoleRenewalAvailable: true }),
      }),
    'GET /api/auth/organization/get-active-member': () =>
      json(200, { organizationId: team.id, userId: viewer.user.id, role: actor }),
    'GET /api/auth/organization/list-members': () =>
      json(200, {
        members: [
          {
            id: memberId,
            organizationId: team.id,
            userId,
            role: 'member',
            user: { id: userId, name: 'Casey' },
          },
          {
            id: admin,
            organizationId: team.id,
            userId: admin,
            role: 'admin',
            user: { id: admin, name: 'Other Admin' },
          },
        ],
        total: 2,
      }),
    [`GET ${modePath}`]: () =>
      json(200, { enabled: mode, policyVersion: { ...policyVersion, teamEpoch }, renewals: [] }),
    [`PUT ${modePath}`]: ({ body }) => {
      mode = (body as { enabled: boolean }).enabled
      return json(200, {
        enabled: mode,
        policyVersion: { ...policyVersion, teamEpoch: ++teamEpoch },
        renewals: [],
      })
    },
    [`GET ${rolesPath}`]: () => json(200, roles),
    [`POST ${rolesPath}`]: ({ body }) => {
      const input = body as Pick<Schemas['CustomTeamRole'], 'name' | 'permissionIds'> & {
        proofAttemptId?: string
      }
      if (proof && !input.proofAttemptId)
        return json(403, {
          error: 'sso_reauthentication_required',
          attemptId,
          proofMethods: ['mailbox'],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      const role = { ...coordinator, name: input.name, permissionIds: input.permissionIds }
      roles = [role]
      return json(200, { kind: 'role', role })
    },
    [`PATCH ${rolesPath}/${roleId}`]: ({ body }) => {
      const input = body as Pick<Schemas['CustomTeamRole'], 'name' | 'permissionIds'> & {
        expectedRevision: number
      }
      if (stale) return json(409, { error: 'role_revision_conflict' })
      const role = {
        ...coordinator,
        name: input.name,
        permissionIds: input.permissionIds,
        revision: input.expectedRevision + 1,
      }
      roles = [role]
      return json(200, { kind: 'role', role })
    },
    [`DELETE ${rolesPath}/${roleId}`]: () => {
      roles = []
      return json(200, { kind: 'role', role: { ...coordinator, archived: true } })
    },
    [`GET ${assignmentPath}`]: () => json(200, assignment),
    [`PUT ${assignmentPath}`]: ({ body }) => {
      const input = body as { roleId: string | null; expectedRevision: number | null }
      assignment = {
        ...assignment,
        generation: assignment.generation + 1,
        roleId: input.roleId,
        revision: input.roleId ? input.expectedRevision : null,
      }
      return json(200, assignment)
    },
    [`GET ${permissionsPath}`]: () => json(200, authorization),
    [`POST ${permissionsPath}/renew`]: () => {
      authorization = {
        ...authorization,
        renewalRequired: false,
        decisions: authorization.permissionIds.map((operation) => ({
          operation,
          allowed: true,
          source: 'custom',
        })),
      }
      return json(200, { renewed: true })
    },
    'POST /api/auth/sso/mailbox-proof/send': () => json(200, { status: 'queued' }),
    'POST /api/auth/sso/mailbox-proof/consume': () => json(200, { status: 'proven' }),
  })
  renderApp(PATHS.settings)
  return {
    ...requests,
    user: userEvent.setup(),
    makeStale: () => {
      stale = true
      roles = roles.map((role) => ({ ...role, revision: role.revision + 1 }))
    },
  }
}

describe('custom roles in team settings', () => {
  it('hides role management while hard-off and sends no feature request', async () => {
    const requests = settings({ available: false })
    const account = within(await screen.findByRole('region', { name: 'Account' }))
    await account.findByText('Your role')
    await account.findByText('Owner')
    expect(screen.queryByRole('region', { name: 'Roles and permissions' })).toBeNull()
    expect(requests.to(`GET ${modePath}`)).toHaveLength(0)
    expect(requests.to(`GET ${permissionsPath}`)).toHaveLength(0)
  })

  it('preserves fixed Admin controls without opening Owner role or assignment controls', async () => {
    const requests = settings({ actor: 'admin', initial: [coordinator] })
    await screen.findByText('Casey')
    expect(screen.queryByRole('region', { name: 'Roles and permissions' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Change custom role for Casey' })).toBeNull()
    expect(requests.to(`GET ${modePath}`)).toHaveLength(0)
  })

  it('shows the impact before an Owner can enable custom roles', async () => {
    const { user, to } = settings({ enabled: false })
    await user.click(await screen.findByRole('button', { name: 'Turn on custom roles' }))
    expect(
      screen.getByText('Members assigned a custom role who must renew after activation: 0'),
    ).toBeDefined()
    expect(to(`PUT ${modePath}`)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Confirm turning on custom roles' }))
    await screen.findByRole('button', { name: 'Create custom role' })
    expect(to(`PUT ${modePath}`)[0]?.body).toEqual({
      enabled: true,
      expectedMasterEpoch: 4,
      expectedTeamEpoch: 6,
    })
    expect(to(`PUT ${modePath}`)[0]?.headers.get('X-Expected-Organization-Id')).toBe(team.id)
  })

  it('publishes only explicit preset actions after identity verification and preserves a stale edit for review', async () => {
    const { user, to, makeStale } = settings({ proof: true })
    await user.click(await screen.findByRole('button', { name: 'Create custom role' }))
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Create custom role' }))
    await user.type(screen.getByRole('textbox', { name: 'Custom role name' }), 'Coordinator')
    await user.selectOptions(screen.getByLabelText('Access preset for Branding'), 'read')
    await user.selectOptions(screen.getByLabelText('Access preset for Event types'), 'custom')
    await user.click(screen.getByRole('checkbox', { name: 'Create event types' }))
    await user.click(screen.getByRole('button', { name: 'Create and publish role' }))
    const proof = within(
      await screen.findByRole('region', {
        name: 'Confirm your identity before changing team roles.',
      }),
    )
    expect(document.activeElement).toBe(proof.getByRole('heading'))
    await user.click(proof.getByRole('button', { name: 'Send verification email' }))
    await user.type(
      await proof.findByLabelText('Email verification link'),
      `${location.origin}${PATHS.mailboxProof}#attempt=${attemptId}&token=${'t'.repeat(43)}`,
    )
    await user.click(proof.getByRole('button', { name: 'Verify email link' }))
    await proof.findByText('Email verification complete.')
    await user.click(proof.getByRole('button', { name: 'Continue' }))
    const edit = await screen.findByRole('button', { name: 'Edit custom role Coordinator' })
    const definition = {
      name: 'Coordinator',
      permissionIds: ['branding.read', 'event_types.create'],
    }
    expect(to(`POST ${rolesPath}`).map(({ body }) => body)).toEqual([
      definition,
      { ...definition, proofAttemptId: attemptId },
    ])

    makeStale()
    await user.click(edit)
    await user.type(screen.getByRole('textbox', { name: 'Custom role name' }), ' edited')
    await user.click(screen.getByRole('button', { name: 'Publish new revision' }))
    const alert = await screen.findByText('The role or assignment changed. Reload before saving.')
    expect(alert.closest('[role=alert]')).toBe(document.activeElement)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Publish new revision' }).disabled,
    ).toBe(true)
    expect(to(`PATCH ${rolesPath}/${roleId}`)[0]?.body).toMatchObject({ expectedRevision: 1 })
    await user.click(screen.getByRole('button', { name: 'Reload team' }))
    await screen.findByText('Revision 2')
    await user.click(screen.getByRole('button', { name: 'Edit custom role Coordinator' }))
    await user.type(screen.getByRole('textbox', { name: 'Custom role name' }), ' revised')
    expect(to(`PATCH ${rolesPath}/${roleId}`)).toHaveLength(1)
  })

  it('publishes a new revision and archives the confirmed saved role', async () => {
    const { user, to } = settings({ initial: [coordinator] })
    await user.click(await screen.findByRole('button', { name: 'Edit custom role Coordinator' }))
    await user.clear(screen.getByRole('textbox', { name: 'Custom role name' }))
    await user.type(screen.getByRole('textbox', { name: 'Custom role name' }), 'Planner')
    await user.click(screen.getByRole('button', { name: 'Publish new revision' }))
    await screen.findByText('Revision 2')
    await user.click(screen.getByRole('button', { name: 'Archive custom role Planner' }))
    expect(to(`DELETE ${rolesPath}/${roleId}`)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Confirm archive' }))
    await screen.findByText('No custom roles have been published.')
    expect(to(`DELETE ${rolesPath}/${roleId}`)[0]?.body).toEqual({ expectedRevision: 2 })
  })

  it('previews assignment changes and clears the assignment with the current revision', async () => {
    chooseLanguage('zh-CN')
    const { user, to } = settings({ initial: [coordinator, activityViewer] })
    const open = await screen.findByRole('button', { name: /更改自定义角色（.*Casey.*）/u })
    expect(screen.queryByRole('button', { name: /更改自定义角色（.*Other Admin.*）/u })).toBeNull()
    await user.click(open)
    const review = within(
      await screen.findByRole('region', { name: /更改自定义角色（.*Casey.*）/u }),
    )
    await user.selectOptions(await review.findByLabelText('此成员的自定义角色'), secondRoleId)
    expect(review.getByText('新增操作')).toBeDefined()
    expect(review.getByText('查看汇总预约活动')).toBeDefined()
    expect(review.getByText('移除的操作')).toBeDefined()
    expect(review.getByText('查看团队品牌设置')).toBeDefined()
    await user.click(review.getByRole('button', { name: '保存自定义角色分配' }))
    await screen.findByText('已保存自定义角色分配。')
    await waitFor(() => expect(document.activeElement).toBe(open))
    expect(to(`PUT ${assignmentPath}`)[0]?.body).toEqual({
      expectedGeneration: 4,
      expectedRevision: 1,
      roleId: secondRoleId,
    })
    await user.click(open)
    const clearReview = within(
      await screen.findByRole('region', { name: /更改自定义角色（.*Casey.*）/u }),
    )
    await user.selectOptions(await clearReview.findByLabelText('此成员的自定义角色'), '')
    await user.click(clearReview.getByRole('button', { name: '保存自定义角色分配' }))
    await screen.findByText('已保存自定义角色分配。')
    expect(to(`PUT ${assignmentPath}`)[1]?.body).toEqual({
      expectedGeneration: 5,
      expectedRevision: 1,
      roleId: null,
    })
  })

  it('lets an affected fixed Owner renew access while custom role management is off', async () => {
    const { to } = settings({
      available: false,
      renewalAvailable: true,
      permissions: {
        ...defaultPermissions,
        renewalRequired: true,
        membershipGeneration: 7,
        fixedRole: 'owner',
      },
    })
    const panel = within(await screen.findByRole('region', { name: 'Renew team access' }))
    expect(panel.getByText('Base team role: Owner')).toBeDefined()
    expect(screen.queryByRole('region', { name: 'Roles and permissions' })).toBeNull()
    expect(to(`GET ${modePath}`)).toHaveLength(0)
  })

  it('shows a member the scope of renewal and applies only the reviewed team version', async () => {
    const { user, to } = settings({
      actor: 'member',
      permissions: {
        ...defaultPermissions,
        renewalRequired: true,
        membershipGeneration: 7,
        fixedRole: 'member',
        permissionIds: ['analytics.read'],
      },
    })
    const panel = within(await screen.findByRole('region', { name: 'Renew team access' }))
    expect(panel.getByText('View aggregate booking activity')).toBeDefined()
    expect(panel.getByText('Base team role: Member')).toBeDefined()
    expect(screen.queryByRole('region', { name: 'Roles and permissions' })).toBeNull()
    await user.click(panel.getByRole('button', { name: 'Verify and renew team access' }))
    expect(await screen.findByText('Your team access was renewed.')).toBeDefined()
    expect(to(`POST ${permissionsPath}/renew`)[0]?.body).toEqual({
      expectedGeneration: 7,
      expectedMasterEpoch: 4,
      expectedTeamEpoch: 6,
    })
    expect(
      within(
        screen.getByRole('region', { name: 'Team actions available in this browser' }),
      ).getByText('View aggregate booking activity'),
    ).toBeDefined()
  })
})
