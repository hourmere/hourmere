import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { ListedOrganizationMember } from '../api/auth.ts'
import { InterfaceScope } from '../i18n/runtime.tsx'
import { chooseLanguage } from '../i18n/store.ts'
import { PATHS } from '../paths.ts'
import { fakeApi, json, type Routes } from '../test/fake-api.tsx'
import { UnsavedChangesProvider } from '../unsaved-changes.tsx'
import { TeamMembers } from './TeamMembers.tsx'

const teamId = '00000000-0000-7000-8000-000000000030'
const attemptId = '00000000-0000-7000-8000-000000000031'
const transferId = '00000000-0000-7000-8000-000000000032'
const token = 't'.repeat(43)
const membersPath = 'GET /api/auth/organization/list-members'
const transferPath = `/api/v1/teams/${teamId}/ownership-transfer`
const getTransfer = `GET ${transferPath}`
const offerTransfer = `POST ${transferPath}`
const confirm = `POST ${transferPath}/${transferId}/confirm`
const revoke = `POST ${transferPath}/${transferId}/revoke`
const decline = `POST ${transferPath}/${transferId}/decline`
const sendEmail = 'POST /api/auth/sso/mailbox-proof/send'
const consumeEmail = 'POST /api/auth/sso/mailbox-proof/consume'
const contextHeader = 'X-Expected-Organization-Id'

function member(number: number, name: string, role: string): ListedOrganizationMember {
  const userId = `00000000-0000-7000-8000-10000000000${number}`
  return {
    id: `00000000-0000-7000-8000-20000000000${number}`,
    organizationId: teamId,
    userId,
    role,
    createdAt: '2026-11-20T12:00:00.000Z',
    user: { id: userId, name, email: `member-${number}@example.test` },
  }
}

const owner = member(1, 'Initiator', 'owner')
const recipient = member(2, 'نور (Team R&D)', 'member')
const otherOwner = member(3, 'Other owner', 'owner')
const base = {
  id: transferId,
  expiresAt: '2099-11-28T12:00:00.000Z',
}
const pending = {
  ...base,
  state: 'pending',
  initiator: { displayName: owner.user.name },
  recipient: { displayName: recipient.user.name },
}

function openSettings(
  actor: ListedOrganizationMember,
  routes: Routes,
  ownershipTransferEnabled = true,
) {
  const server = fakeApi({
    [membersPath]: () => json(200, { members: [owner, recipient, otherOwner], total: 3 }),
    [`GET /api/v1/teams/${teamId}/member-readiness`]: () =>
      json(200, { organizationId: teamId, members: [] }),
    'GET /api/v1/team/invitations': () => json(200, { data: [], nextCursor: null }),
    ...routes,
  })
  const onReload = vi.fn()
  const onTransferRolesChanged = vi.fn()
  render(
    <MemoryRouter>
      <UnsavedChangesProvider>
        <InterfaceScope surface="admin">
          <TeamMembers
            organizationId={teamId}
            currentUserId={actor.userId}
            role={actor.role}
            ownershipTransferEnabled={ownershipTransferEnabled}
            onReload={onReload}
            onTransferRolesChanged={onTransferRolesChanged}
          />
        </InterfaceScope>
      </UnsavedChangesProvider>
    </MemoryRouter>,
  )
  return { server, onReload, onTransferRolesChanged }
}

function challenge() {
  return json(403, {
    error: 'sso_reauthentication_required',
    attemptId,
    proofMethods: ['mailbox'],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
}

const mailRoutes: Routes = {
  [sendEmail]: () => json(202, { status: 'queued' }),
  [consumeEmail]: () => json(200, { status: 'proven' }),
}

async function transferPanel(title = 'Team ownership transfer') {
  return within(await screen.findByRole('region', { name: title }))
}

async function verifyMailbox(
  user: ReturnType<typeof userEvent.setup>,
  panel: ReturnType<typeof within>,
) {
  await user.click(await panel.findByRole('button', { name: 'Send verification email' }))
  const link = new URL(`${PATHS.mailboxProof}#attempt=${attemptId}&token=${token}`, location.origin)
  await user.type(await panel.findByLabelText('Email verification link'), link.href)
  await user.click(panel.getByRole('button', { name: 'Verify email link' }))
  await panel.findByText('Email verification complete.')
}

describe('team ownership transfer in member settings', () => {
  it('keeps ownership transfer hidden and makes no transfer request while switched off', async () => {
    const { server } = openSettings(owner, {}, false)
    await screen.findByText('3 joined members')
    expect(screen.queryByRole('region', { name: 'Team ownership transfer' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Offer ownership/ })).toBeNull()
    expect(server.to(getTransfer)).toEqual([])
  })

  it('reviews a bound joined member and retries the same offer after fresh mailbox proof', async () => {
    let offered = false
    const { server } = openSettings(owner, {
      ...mailRoutes,
      [getTransfer]: () => json(200, { offer: offered ? { ...pending, action: 'revoke' } : null }),
      [offerTransfer]: ({ body }) => {
        if (
          !body ||
          typeof body !== 'object' ||
          !('proofAttemptId' in body) ||
          body.proofAttemptId !== attemptId
        )
          return challenge()
        offered = true
        return json(201, base)
      },
    })
    const user = userEvent.setup()
    const panel = await transferPanel()
    const button = await screen.findByRole('button', {
      name: `Offer ownership to ${recipient.user.name}`,
    })
    expect(screen.getAllByRole('button', { name: /Offer ownership/ })).toEqual([button])
    button.focus()
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(
      panel.getByRole('heading', { name: 'Review ownership transfer' }),
    )
    expect(panel.getByText(recipient.user.name, { selector: 'bdi' })).toBeTruthy()
    expect(panel.getByText(recipient.user.email ?? '')).toBeTruthy()
    expect(panel.getByText('You will become an admin when the recipient accepts.')).toBeTruthy()
    expect(panel.getByText(/API keys and agent authorizations/)).toBeTruthy()
    expect(server.to(offerTransfer)).toEqual([])
    await user.click(panel.getByRole('button', { name: 'Send transfer offer' }))
    await verifyMailbox(user, panel)
    expect(server.to(offerTransfer).map(({ body }) => body)).toEqual([
      { targetMembershipId: recipient.id },
    ])
    await user.click(panel.getByRole('button', { name: 'Continue' }))
    await panel.findByRole('button', { name: 'Revoke transfer' })
    await panel.findByText(owner.user.name, { selector: 'bdi' })
    expect(panel.getByRole('status').textContent).toBe('Transfer offer pending.')
    const calls = server.to(offerTransfer)
    expect(calls.map(({ body }) => body)).toEqual([
      { targetMembershipId: recipient.id },
      { targetMembershipId: recipient.id, proofAttemptId: attemptId },
    ])
    expect(
      [
        ...server.to(getTransfer),
        ...calls,
        ...server.to(sendEmail),
        ...server.to(consumeEmail),
      ].every(
        ({ headers }) => headers.get(contextHeader) === teamId && !headers.has('Authorization'),
      ),
    ).toBe(true)
  })

  it('shows both role changes in Chinese, then refreshes the roster after an explicit acceptance', async () => {
    chooseLanguage('zh-CN')
    let completed = false
    const { server, onTransferRolesChanged } = openSettings(recipient, {
      [getTransfer]: () => json(200, { offer: { ...pending, action: 'confirm' } }),
      [membersPath]: () =>
        json(200, {
          members: completed
            ? [
                { ...owner, role: 'admin' },
                { ...recipient, role: 'owner' },
              ]
            : [owner, recipient],
          total: 2,
        }),
      [confirm]: ({ body, headers }) => {
        expect(headers.get(contextHeader)).toBe(teamId)
        expect(body).toEqual({})
        completed = true
        return json(200, {
          initiator: { membershipId: owner.id, role: 'admin' },
          recipient: { membershipId: recipient.id, role: 'owner' },
        })
      },
    })
    const panel = await transferPanel('团队所有权转移')
    const accept = await panel.findByRole('button', { name: '接受所有权' })
    const text = (name: string) =>
      panel.getByText(name, { selector: 'bdi' }).parentElement?.textContent?.replace(/ (?=将)/u, '')
    expect(text(owner.user.name)).toBe(`${owner.user.name}将成为管理员。`)
    expect(text(recipient.user.name)).toBe(`${recipient.user.name}将成为团队所有者。`)
    expect(panel.getByText(/代理授权不会转移/)).toBeTruthy()
    expect(panel.getByText(/UTC/, { selector: 'time' }).getAttribute('datetime')).toBe(
      base.expiresAt,
    )
    expect(panel.queryByText(recipient.user.email ?? '')).toBeNull()
    expect(server.to(confirm)).toEqual([])
    await userEvent.click(accept)
    await panel.findByText('所有权转移已完成。')
    await waitFor(() => expect(onTransferRolesChanged).toHaveBeenCalledOnce())
    await waitFor(() => expect(server.to(membersPath)).toHaveLength(2))
    expect(server.to(confirm)).toHaveLength(1)
    expect(panel.queryByRole('button', { name: '接受所有权' })).toBeNull()
  })

  it('allows the recipient to decline with one deliberate action', async () => {
    const { server, onTransferRolesChanged } = openSettings(recipient, {
      [getTransfer]: () => json(200, { offer: { ...pending, action: 'confirm' } }),
      [decline]: () => json(200, { state: 'revoked' }),
    })
    const panel = await transferPanel()
    const declineButton = await panel.findByRole('button', { name: 'Decline transfer' })
    expect(server.to(decline)).toEqual([])
    expect(panel.queryByRole('button', { name: 'Revoke transfer' })).toBeNull()
    await userEvent.click(declineButton)
    await panel.findByText('You declined the transfer offer.')
    expect(server.to(decline)[0]?.headers.get(contextHeader)).toBe(teamId)
    expect(server.to(confirm)).toEqual([])
    expect(server.to(revoke)).toEqual([])
    expect(onTransferRolesChanged).not.toHaveBeenCalled()
  })

  it.each([
    ['revoked', 'The transfer offer was revoked or declined.'],
    ['expired', 'The transfer offer expired.'],
    ['invalidated', 'The transfer offer is no longer valid.'],
  ])('reconciles a previously viewed %s offer without another write', async (state, copy) => {
    let ended = false
    const { server } = openSettings(owner, {
      [getTransfer]: ({ path }) => {
        if (!ended) return json(200, { offer: { ...pending, action: 'revoke' } })
        const viewed = new URL(path, location.origin).searchParams.get('transferId')
        return json(200, { offer: viewed === transferId ? { ...base, state } : null })
      },
    })
    const panel = await transferPanel()
    await panel.findByText('Transfer offer pending.')
    ended = true
    await userEvent.click(panel.getByRole('button', { name: 'Refresh transfer status' }))
    await panel.findByText(copy)
    expect(panel.queryByRole('button', { name: 'Revoke transfer' })).toBeNull()
    expect(server.to(getTransfer).map(({ path }) => path)).toContain(
      `${transferPath}?transferId=${transferId}`,
    )
    expect(server.to(revoke)).toEqual([])
  })

  it('supports revocation by a different owner without rendering participant identities', async () => {
    openSettings(otherOwner, {
      [getTransfer]: () => json(200, { offer: { ...base, state: 'pending', action: 'revoke' } }),
      [revoke]: () => json(200, { state: 'revoked' }),
    })
    const panel = await transferPanel()
    const revokeButton = await panel.findByRole('button', { name: 'Revoke transfer' })
    expect(panel.queryByText(owner.user.name)).toBeNull()
    expect(panel.queryByText(recipient.user.name)).toBeNull()
    expect(panel.queryByRole('button', { name: 'Accept ownership' })).toBeNull()
    await userEvent.click(revokeButton)
    await panel.findByText('The transfer offer was revoked or declined.')
  })

  it('asks for an explicit reload after a stale context write', async () => {
    const { server, onReload, onTransferRolesChanged } = openSettings(recipient, {
      [getTransfer]: () => json(200, { offer: { ...pending, action: 'confirm' } }),
      [confirm]: () => json(409, { error: 'organization_context_changed' }),
    })
    const panel = await transferPanel()
    await userEvent.click(await panel.findByRole('button', { name: 'Accept ownership' }))
    const reload = within(await panel.findByRole('alert')).getByRole('button', {
      name: 'Reload team',
    })
    expect(panel.queryByRole('button', { name: 'Accept ownership' })).toBeNull()
    expect(panel.queryByRole('button', { name: 'Decline transfer' })).toBeNull()
    expect(server.to(getTransfer)).toHaveLength(1)
    expect(onTransferRolesChanged).not.toHaveBeenCalled()
    await userEvent.click(reload)
    expect(onReload).toHaveBeenCalledOnce()
  })

  it('leaves unknown transfer status neutral after an access denial', async () => {
    openSettings(owner, {
      [getTransfer]: () => json(403, { error: 'team_management_access_denied' }),
    })
    const panel = await transferPanel()
    await panel.findByText('Could not check the transfer status.')
    expect(panel.queryByText('No pending transfer offer.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Offer ownership/ })).toBeNull()
  })
})
