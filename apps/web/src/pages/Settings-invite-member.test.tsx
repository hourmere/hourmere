import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { QueuedInvitation } from '../api/auth.ts'
import type { Schemas } from '../api/client.ts'
import { InterfaceScope } from '../i18n/runtime.tsx'
import { chooseLanguage } from '../i18n/store.ts'
import { PATHS } from '../paths.ts'
import { SessionProvider } from '../session.tsx'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../test/fake-api.tsx'
import { TeamInvitations } from './TeamInvitations.tsx'

const TEAM_ME: Schemas['Me'] = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000010',
    name: 'Example team',
    slug: 'example-team',
    personal: false,
  },
}
const EMAIL = 'new-member@example.com'
const INVITATION: Schemas['TeamInvitationSummary'] = {
  id: '00000000-0000-7000-8000-000000000020',
  email: EMAIL,
  status: 'pending',
  createdAt: '2026-10-30T10:00:00.000Z',
  expiresAt: '2026-11-13T10:00:00.000Z',
  generation: 1,
  resendDeniedReason: null,
  resendRetryAfterSeconds: null,
  resendAllowed: false,
  delivery: { state: 'queued', attempts: 0, lastAttemptAt: null, lastErrorCode: null },
}
const QUEUED_INVITATION: QueuedInvitation = {
  existing: false,
  ...INVITATION,
  email: EMAIL,
  organizationId: TEAM_ME.organization.id,
  inviterId: TEAM_ME.user.id,
  role: 'member',
  status: 'pending',
  delivery: { generation: 1, state: 'queued', attempts: 0 },
}
const INVITE_ROUTE = 'POST /api/auth/organization/invite-member'
const PENDING_ROUTE = 'GET /api/v1/team/invitations'
const DETAIL_ROUTE = `GET /api/v1/team/invitations/${INVITATION.id}`

function server(routes: Routes = {}, role = 'owner') {
  return fakeApi({
    ...signedInAs(TEAM_ME),
    ...profile(PROFILE),
    'GET /api/auth/organization/get-active-member': () =>
      json(200, {
        id: 'membership-1',
        organizationId: TEAM_ME.organization.id,
        userId: TEAM_ME.user.id,
        role,
        createdAt: '2026-10-01T09:00:00.000Z',
      }),
    'GET /api/auth/organization/list-members': () => json(200, { members: [], total: 0 }),
    [PENDING_ROUTE]: () => json(200, { data: [], nextCursor: null }),
    [INVITE_ROUTE]: () => json(200, QUEUED_INVITATION),
    [DETAIL_ROUTE]: () => json(200, { ...INVITATION, resendAllowed: true }),
    ...routes,
  })
}

async function form() {
  return screen.findByRole('region', { name: 'Invite member' })
}

async function fillAndSubmit(email = EMAIL) {
  const user = userEvent.setup()
  const invitationForm = await form()
  const emailInput = within(invitationForm).getByRole('textbox', { name: 'Email' })
  await user.type(emailInput, email)
  await user.click(within(invitationForm).getByRole('button', { name: 'Invite member' }))
  return { user, invitationForm, emailInput: emailInput as HTMLInputElement }
}

describe('inviting a team member in settings', () => {
  it.each(['owner', 'admin', 'member, admin'])(
    'lets a current %s queue only a member invitation and refreshes pending state',
    async (role) => {
      let queued = false
      const api = server(
        {
          [INVITE_ROUTE]: () => {
            queued = true
            return json(200, QUEUED_INVITATION)
          },
          [PENDING_ROUTE]: () => json(200, { data: queued ? [INVITATION] : [], nextCursor: null }),
        },
        role,
      )
      renderApp(PATHS.settings)
      const invitationForm = await form()
      expect(
        within(invitationForm).getByText('Invitations always use the member role.'),
      ).toBeDefined()
      expect(within(invitationForm).queryByRole('combobox')).toBeNull()
      const { emailInput } = await fillAndSubmit()
      expect((await within(invitationForm).findByRole('status')).textContent).toBe(
        'Invitation queued for delivery.',
      )
      const pending = await screen.findByRole('region', { name: 'Pending invitations' })
      expect(await within(pending).findByText('Waiting to send')).toBeDefined()
      expect(
        within(pending).getByRole('heading', { name: `Invitation to ${INVITATION.email}` }),
      ).toBeDefined()
      expect(invitationForm.textContent).not.toMatch(/invitation sent|delivered/i)
      expect(emailInput.value).toBe('')
      expect(api.to(INVITE_ROUTE)).toHaveLength(1)
      expect(api.to(INVITE_ROUTE)[0]?.body).toEqual({
        email: EMAIL,
        role: 'member',
        organizationId: TEAM_ME.organization.id,
      })
      expect(api.to(INVITE_ROUTE)[0]?.headers.get('X-Expected-Organization-Id')).toBe(
        TEAM_ME.organization.id,
      )
      expect(api.to(PENDING_ROUTE)).toHaveLength(2)
      expect(
        api
          .to(PENDING_ROUTE)
          .every(
            ({ path }) =>
              new URL(path, window.location.origin).searchParams.get('status') === 'pending',
          ),
      ).toBe(true)
    },
  )

  it('refreshes the first pending page after submission from a later page', async () => {
    const user = userEvent.setup()
    let queued = false
    const api = server({
      [INVITE_ROUTE]: () => {
        queued = true
        return json(200, QUEUED_INVITATION)
      },
      [PENDING_ROUTE]: ({ path }) => {
        const cursor = new URL(path, window.location.origin).searchParams.get('cursor')
        return json(200, {
          data: queued || cursor ? [INVITATION] : [],
          nextCursor: queued || cursor ? null : INVITATION.id,
        })
      },
    })
    renderApp(PATHS.settings)
    const pending = await screen.findByRole('region', { name: 'Pending invitations' })
    await user.click(await within(pending).findByRole('button', { name: 'Next invitations page' }))
    await within(pending).findByText('Waiting to send')
    await fillAndSubmit()
    await screen.findByText('Invitation queued for delivery.')
    await waitFor(() => expect(api.to(PENDING_ROUTE)).toHaveLength(3))
    const requests = api.to(PENDING_ROUTE)
    expect(
      new URL(requests[1]?.path as string, window.location.origin).searchParams.get('cursor'),
    ).toBe(INVITATION.id)
    expect(
      new URL(requests[2]?.path as string, window.location.origin).searchParams.get('cursor'),
    ).toBeNull()
    expect(
      within(screen.getByRole('region', { name: 'Pending invitations' })).queryByRole('button', {
        name: 'Previous invitations page',
      }),
    ).toBeNull()
  })

  it.each(['queued', 'sending', 'smtp_accepted', 'failed', 'skipped', 'unknown'] as const)(
    'does not claim a retained %s invitation was newly queued',
    async (state) => {
      const api = server({
        [INVITE_ROUTE]: () =>
          json(200, {
            ...QUEUED_INVITATION,
            existing: true,
            delivery: { ...QUEUED_INVITATION.delivery, state },
          }),
      })
      renderApp(PATHS.settings)
      const { invitationForm, emailInput } = await fillAndSubmit()
      expect(
        await within(invitationForm).findByText(
          'An invitation already exists. Review its mail submission status below.',
        ),
      ).toBeDefined()
      expect(within(invitationForm).queryByText('Invitation queued for delivery.')).toBeNull()
      expect(emailInput.value).toBe('')
      await waitFor(() => expect(api.to(PENDING_ROUTE)).toHaveLength(2))
    },
  )

  it.each([false, true])(
    'offers an explicit resend for an existing queued invitation only when allowed=%s',
    async (resendAllowed) => {
      let submissions = 0
      const api = server({
        [INVITE_ROUTE]: () => {
          submissions += 1
          return json(200, {
            ...QUEUED_INVITATION,
            existing: true,
            delivery: { ...QUEUED_INVITATION.delivery, generation: submissions },
          })
        },
        [PENDING_ROUTE]: () =>
          json(200, {
            data: [
              {
                ...INVITATION,
                generation: submissions > 1 ? 2 : 1,
                resendAllowed: resendAllowed && submissions < 2,
              },
            ],
            nextCursor: null,
          }),
        [DETAIL_ROUTE]: () => json(200, { ...INVITATION, generation: 2, resendAllowed: false }),
      })
      renderApp(PATHS.settings)
      const { user, invitationForm, emailInput } = await fillAndSubmit()
      await within(invitationForm).findByText(
        'An invitation already exists. Review its mail submission status below.',
      )
      expect(emailInput.value).toBe('')
      const pending = await screen.findByRole('region', { name: 'Pending invitations' })
      await within(pending).findByRole('heading', { name: `Invitation to ${EMAIL}` })
      if (!resendAllowed) {
        expect(
          (within(pending).getByRole('button', { name: 'Resend invitation' }) as HTMLButtonElement)
            .disabled,
        ).toBe(true)
        expect(api.to(INVITE_ROUTE)).toHaveLength(1)
        return
      }
      await user.click(await within(pending).findByRole('button', { name: 'Resend invitation' }))
      await screen.findByText('Invitation queued for delivery.')
      expect(api.to(INVITE_ROUTE)).toHaveLength(2)
      expect(api.to(INVITE_ROUTE)[1]?.body).toEqual({
        email: EMAIL,
        organizationId: TEAM_ME.organization.id,
        role: 'member',
        invitationId: INVITATION.id,
        resend: true,
        expectedGeneration: 1,
        requestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
      })
      expect(api.to(INVITE_ROUTE)[1]?.headers.get('X-Expected-Organization-Id')).toBe(
        TEAM_ME.organization.id,
      )
      await waitFor(() => expect(api.to(PENDING_ROUTE)).toHaveLength(3))
      expect(
        (screen.getByRole('button', { name: 'Resend invitation' }) as HTMLButtonElement).disabled,
      ).toBe(true)
    },
  )

  it('finds an existing invitation across multiple pages and leaves manual paging available', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      ...INVITATION,
      id: `00000000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`,
      email: `other-${index}@example.com`,
    }))
    const secondPage = firstPage.map((invitation, index) => ({
      ...invitation,
      id: `00000000-0000-7000-8000-${String(index + 200).padStart(12, '0')}`,
    }))
    const api = server({
      [INVITE_ROUTE]: () => json(200, { ...QUEUED_INVITATION, existing: true }),
      [PENDING_ROUTE]: ({ path }) => {
        const cursor = new URL(path, window.location.origin).searchParams.get('cursor')
        if (!cursor) return json(200, { data: firstPage, nextCursor: firstPage.at(-1)?.id })
        if (cursor === firstPage.at(-1)?.id)
          return json(200, { data: secondPage, nextCursor: secondPage.at(-1)?.id })
        return json(200, { data: [{ ...INVITATION, resendAllowed: true }], nextCursor: null })
      },
    })
    renderApp(PATHS.settings)
    const { user, emailInput } = await fillAndSubmit()
    const pending = await screen.findByRole('region', { name: 'Pending invitations' })
    await within(pending).findByRole('button', { name: 'Resend invitation' })
    expect(within(pending).getByRole('heading', { name: `Invitation to ${EMAIL}` })).toBeDefined()
    expect(emailInput.value).toBe('')
    expect(api.to(PENDING_ROUTE)).toHaveLength(4)
    expect(
      api
        .to(PENDING_ROUTE)
        .map(({ path }) => new URL(path, window.location.origin).searchParams.get('cursor')),
    ).toEqual([null, null, firstPage.at(-1)?.id, secondPage.at(-1)?.id])
    await user.click(within(pending).getByRole('button', { name: 'Previous invitations page' }))
    await within(pending).findByRole('heading', { name: `Invitation to ${secondPage[0]?.email}` })
    expect(api.to(PENDING_ROUTE)).toHaveLength(5)
    expect(
      within(pending)
        .getAllByRole('button', { name: 'Resend invitation' })
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true)
    expect(
      within(pending).queryByText('The invitation changed. Reload before trying again.'),
    ).toBeNull()
    await user.click(within(pending).getByRole('button', { name: 'Next invitations page' }))
    await user.click(await within(pending).findByRole('button', { name: 'Resend invitation' }))
    await screen.findByText('Invitation queued for delivery.')
    expect(api.to(INVITE_ROUTE)[1]?.body).toMatchObject({
      email: EMAIL,
      invitationId: INVITATION.id,
      expectedGeneration: 1,
      resend: true,
    })
  })

  it.each([false, true])(
    'clears the confirmed invitation draft and unload guard when existing=%s',
    async (existing) => {
      server({
        [INVITE_ROUTE]: () => json(200, { ...QUEUED_INVITATION, existing }),
        [PENDING_ROUTE]: () => json(200, { data: [INVITATION], nextCursor: null }),
      })
      renderApp(PATHS.settings)
      const invitationForm = await form()
      const user = userEvent.setup()
      const emailInput = within(invitationForm).getByRole('textbox', { name: 'Email' })
      await user.type(emailInput, EMAIL)
      const draftUnload = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(draftUnload)
      expect(draftUnload.defaultPrevented).toBe(true)
      await user.click(within(invitationForm).getByRole('button', { name: 'Invite member' }))
      await within(invitationForm).findByRole('status')
      expect((emailInput as HTMLInputElement).value).toBe('')
      const confirmedUnload = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(confirmedUnload)
      expect(confirmedUnload.defaultPrevented).toBe(false)
    },
  )

  it.each(['no matching invitation', 'page limit'])(
    'stops seeking with reload guidance after %s',
    async (ending) => {
      let page = 0
      const api = server({
        [INVITE_ROUTE]: () => json(200, { ...QUEUED_INVITATION, existing: true }),
        [PENDING_ROUTE]: () => {
          page += 1
          return json(200, {
            data: [],
            nextCursor: ending === 'page limit' ? `cursor-${page}` : null,
          })
        },
      })
      renderApp(PATHS.settings)
      await fillAndSubmit()
      const pending = await screen.findByRole('region', { name: 'Pending invitations' })
      await within(pending).findByText('The invitation changed. Reload before trying again.')
      expect(api.to(PENDING_ROUTE)).toHaveLength(ending === 'page limit' ? 6 : 2)
      expect(within(pending).queryByRole('button', { name: 'Resend invitation' })).toBeNull()
      expect(within(pending).queryByText('Loading pending invitations…')).toBeNull()
    },
  )

  it('stops seeking on a failed page and continues only after an explicit retry', async () => {
    let fail = true
    const api = server({
      [INVITE_ROUTE]: () => json(200, { ...QUEUED_INVITATION, existing: true }),
      [PENDING_ROUTE]: ({ path }) => {
        const cursor = new URL(path, window.location.origin).searchParams.get('cursor')
        if (!cursor) return json(200, { data: [], nextCursor: 'next-page' })
        if (fail) return json(503, { error: { code: 'unavailable', message: 'Try later' } })
        return json(200, { data: [{ ...INVITATION, resendAllowed: true }], nextCursor: null })
      },
    })
    renderApp(PATHS.settings)
    const { user } = await fillAndSubmit()
    const pending = await screen.findByRole('region', { name: 'Pending invitations' })
    expect((await within(pending).findByRole('alert')).textContent).toContain(
      'Could not load pending invitations.',
    )
    expect(api.to(PENDING_ROUTE)).toHaveLength(3)
    expect(within(pending).queryByRole('button', { name: 'Resend invitation' })).toBeNull()
    fail = false
    await user.click(within(pending).getByRole('button', { name: 'Try again' }))
    await within(pending).findByRole('button', { name: 'Resend invitation' })
    expect(api.to(PENDING_ROUTE)).toHaveLength(4)
  })

  it('moves keyboard focus to stable status feedback after the resend completes', async () => {
    const api = server({
      [INVITE_ROUTE]: () => json(200, { ...QUEUED_INVITATION, existing: true }),
      [DETAIL_ROUTE]: () => json(200, { ...INVITATION, resendAllowed: false }),
      [PENDING_ROUTE]: () =>
        json(200, {
          data: [{ ...INVITATION, resendAllowed: api.to(INVITE_ROUTE).length < 2 }],
          nextCursor: null,
        }),
    })
    renderApp(PATHS.settings)
    const { user, invitationForm } = await fillAndSubmit()
    const existing = await within(invitationForm).findByText(
      'An invitation already exists. Review its mail submission status below.',
    )
    expect(document.activeElement).toBe(existing.parentElement)
    await user.tab()
    expect(document.activeElement).toBe(
      within(invitationForm).getByRole('button', { name: 'Invite member' }),
    )
    await user.tab()
    expect(document.activeElement).toBe(
      screen.getByRole('combobox', { name: 'Filter invitations' }),
    )
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Resend invitation' }))
    await user.keyboard('{Enter}')
    const status = await screen.findByText('Invitation queued for delivery.')
    expect(status.getAttribute('role')).toBe('status')
    expect(document.activeElement).toBe(status.parentElement)
    expect(
      (screen.getByRole('button', { name: 'Resend invitation' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(api.to(INVITE_ROUTE)).toHaveLength(2)
  })

  it('shows a completed resend replay without claiming it was newly queued', async () => {
    let resent = false
    server({
      [INVITE_ROUTE]: ({ body }) => {
        resent = Boolean((body as { resend?: boolean }).resend)
        return json(200, {
          ...QUEUED_INVITATION,
          existing: true,
          delivery: {
            ...QUEUED_INVITATION.delivery,
            state: resent ? 'smtp_accepted' : 'queued',
          },
        })
      },
      [DETAIL_ROUTE]: () =>
        json(200, {
          ...INVITATION,
          resendAllowed: false,
          delivery: { ...INVITATION.delivery, state: 'smtp_accepted' },
        }),
      [PENDING_ROUTE]: () =>
        json(200, {
          data: [
            {
              ...INVITATION,
              resendAllowed: !resent,
              delivery: { ...INVITATION.delivery, state: resent ? 'smtp_accepted' : 'queued' },
            },
          ],
          nextCursor: null,
        }),
    })
    renderApp(PATHS.settings)
    const { user, invitationForm } = await fillAndSubmit()
    await within(invitationForm).findByText(
      'An invitation already exists. Review its mail submission status below.',
    )
    const pending = await screen.findByRole('region', { name: 'Pending invitations' })
    await user.click(await within(pending).findByRole('button', { name: 'Resend invitation' }))
    await screen.findByText('Accepted by the mail server')
    expect(screen.queryByText('Invitation queued for delivery.')).toBeNull()
  })

  it('reuses the explicit resend identity after an uncertain queue failure', async () => {
    let submissions = 0
    const api = server({
      [INVITE_ROUTE]: () => {
        submissions += 1
        if (submissions === 2) return json(503, { code: 'INVITATION_DELIVERY_UNAVAILABLE' })
        return json(200, { ...QUEUED_INVITATION, existing: true })
      },
      [PENDING_ROUTE]: () =>
        json(200, { data: [{ ...INVITATION, resendAllowed: true }], nextCursor: null }),
    })
    renderApp(PATHS.settings)
    const { user, invitationForm } = await fillAndSubmit()
    await within(invitationForm).findByText(
      'An invitation already exists. Review its mail submission status below.',
    )
    const pending = await screen.findByRole('region', { name: 'Pending invitations' })
    await user.click(await within(pending).findByRole('button', { name: 'Resend invitation' }))
    expect((await within(pending).findByRole('alert')).textContent).toMatch(/could not be queued/i)
    await user.click(within(pending).getByRole('button', { name: 'Resend invitation' }))
    await screen.findByText('Invitation queued for delivery.')
    expect(api.to(INVITE_ROUTE)[2]?.body).toEqual(api.to(INVITE_ROUTE)[1]?.body)
  })

  it('localizes an existing queued invitation and its allowed resend in Simplified Chinese', async () => {
    chooseLanguage('zh-CN')
    server({
      [INVITE_ROUTE]: () => json(200, { ...QUEUED_INVITATION, existing: true }),
      [PENDING_ROUTE]: () =>
        json(200, { data: [{ ...INVITATION, resendAllowed: true }], nextCursor: null }),
    })
    renderApp(PATHS.settings)
    const invitationForm = await screen.findByRole('region', { name: '邀请成员' })
    const user = userEvent.setup()
    await user.type(within(invitationForm).getByRole('textbox', { name: '邮箱' }), EMAIL)
    await user.keyboard('{Enter}')
    await within(invitationForm).findByText('邀请已存在。请查看下方的邮件提交状态。')
    const pending = screen.getByRole('region', { name: '待接受的邀请' })
    await within(pending).findByRole('heading', { name: `发给 ${EMAIL} 的邀请` })
    expect(within(pending).getByRole('button', { name: '重新发送邀请' })).toBeDefined()
    expect(within(invitationForm).queryByText('邀请已加入投递队列。')).toBeNull()
  })

  it.each([
    {
      status: 409,
      code: 'INVITATION_ALREADY_PENDING',
      message: /already.*pending|pending.*already/i,
    },
    {
      status: 400,
      code: 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION',
      message: /already.*pending|already.*invit/i,
    },
    {
      status: 409,
      code: 'INVITATION_RECIPIENT_ALREADY_MEMBER',
      message: /already.*(member|belongs)/i,
    },
    { status: 409, code: 'INVITATION_PENDING_LIMIT', message: /pending.*limit|too many pending/i },
    { status: 400, code: 'INVALID_INVITATION_REQUEST', message: /valid.*email|email.*valid/i },
    { status: 503, code: 'INVITATION_DELIVERY_UNAVAILABLE', message: /queue|queued/i },
    { status: 503, code: 'INVITATION_REQUEST_FAILED', message: /queue|queued/i },
    {
      status: 403,
      code: 'TEAM_MANAGEMENT_ACCESS_DENIED',
      message: /permission|access|only.*(owner|admin)/i,
    },
  ])('explains $code and retains the email draft on failure', async ({ status, code, message }) => {
    const api = server({ [INVITE_ROUTE]: () => json(status, { code }) })
    renderApp(PATHS.settings)
    const { invitationForm, emailInput } = await fillAndSubmit()
    expect((await within(invitationForm).findByRole('alert')).textContent).toMatch(message)
    expect(emailInput.value).toBe(EMAIL)
    expect(within(invitationForm).queryByText('Invitation queued for delivery.')).toBeNull()
    expect(api.to(PENDING_ROUTE)).toHaveLength(1)
    expect(api.to(INVITE_ROUTE)).toHaveLength(1)
  })

  it.each(['body', 'header'] as const)(
    'shows the server retry time from the %s on rate limit',
    async (source) => {
      const api = server({
        [INVITE_ROUTE]: () => {
          const response = json(429, {
            code: 'INVITATION_RATE_LIMITED',
            ...(source === 'body' && { retryAfterSeconds: 125 }),
          })
          if (source === 'header') response.headers.set('Retry-After', '125')
          return response
        },
      })
      renderApp(PATHS.settings)
      const { invitationForm, emailInput } = await fillAndSubmit()
      const message = (await within(invitationForm).findByRole('alert')).textContent
      expect(message).toMatch(/limited|too many|wait/i)
      expect(message).toContain('125')
      expect(emailInput.value).toBe(EMAIL)
      expect(api.to(INVITE_ROUTE)).toHaveLength(1)
    },
  )

  it('explains rate limiting when no retry time is available', async () => {
    server({ [INVITE_ROUTE]: () => json(429, { code: 'INVITATION_RATE_LIMITED' }) })
    renderApp(PATHS.settings)
    const { invitationForm, emailInput } = await fillAndSubmit()
    expect((await within(invitationForm).findByRole('alert')).textContent).toMatch(
      /limited|wait|too many/i,
    )
    expect(emailInput.value).toBe(EMAIL)
  })

  it('rejects invalid email locally and retains it for correction', async () => {
    const api = server()
    renderApp(PATHS.settings)
    const { invitationForm, emailInput } = await fillAndSubmit('invalid-address')
    expect((await within(invitationForm).findByRole('alert')).textContent).toMatch(
      /valid.*email|email.*valid/i,
    )
    expect(emailInput.value).toBe('invalid-address')
    expect(api.to(INVITE_ROUTE)).toHaveLength(0)
  })

  it('retains the draft after a network failure and allows a retry', async () => {
    let fail = true
    const api = server({
      [INVITE_ROUTE]: () => {
        if (fail) throw new TypeError('Failed to fetch')
        return json(200, QUEUED_INVITATION)
      },
    })
    renderApp(PATHS.settings)
    const { user, invitationForm, emailInput } = await fillAndSubmit()
    expect((await within(invitationForm).findByRole('alert')).textContent).toMatch(
      /connection|reach/i,
    )
    expect(emailInput.value).toBe(EMAIL)
    fail = false
    await user.click(within(invitationForm).getByRole('button', { name: 'Invite member' }))
    await within(invitationForm).findByText('Invitation queued for delivery.')
    expect(api.to(INVITE_ROUTE)).toHaveLength(2)
    expect(api.to(INVITE_ROUTE)[1]?.body).toEqual(api.to(INVITE_ROUTE)[0]?.body)
  })

  it('submits by keyboard and blocks a second request while queueing', async () => {
    const response = later()
    const api = server({ [INVITE_ROUTE]: () => response.response })
    renderApp(PATHS.settings)
    const user = userEvent.setup()
    const invitationForm = await form()
    const emailInput = within(invitationForm).getByRole('textbox', { name: 'Email' })
    await user.click(emailInput)
    await user.type(emailInput, EMAIL)
    await user.keyboard('{Enter}{Enter}')
    await waitFor(() => expect(api.to(INVITE_ROUTE)).toHaveLength(1))
    expect(within(invitationForm).queryByText('Invitation queued for delivery.')).toBeNull()
    await response.answer(json(200, QUEUED_INVITATION))
    await within(invitationForm).findByText('Invitation queued for delivery.')
    expect(api.to(INVITE_ROUTE)).toHaveLength(1)
  })

  it.each(['member', 'superadmin', 'owner-assistant', 'admin,custom-role', 'owner,'])(
    'does not show the form for role %s',
    async (role) => {
      const api = server({}, role)
      renderApp(PATHS.settings)
      const members = await screen.findByRole('region', { name: 'Team members' })
      await within(members).findByText('No team members found.')
      expect(screen.queryByRole('region', { name: 'Invite member' })).toBeNull()
      expect(screen.queryByRole('textbox', { name: 'Email' })).toBeNull()
      expect(api.to(INVITE_ROUTE)).toHaveLength(0)
      expect(api.to(PENDING_ROUTE)).toHaveLength(0)
    },
  )

  it('shows the server refusal when permissions were removed after the form opened', async () => {
    server({ [INVITE_ROUTE]: () => json(403, { code: 'TEAM_MANAGEMENT_ACCESS_DENIED' }) })
    renderApp(PATHS.settings)
    const { invitationForm, emailInput } = await fillAndSubmit()
    expect((await within(invitationForm).findByRole('alert')).textContent).toMatch(
      /permission|access/i,
    )
    expect(emailInput.value).toBe(EMAIL)
  })

  it('preserves the bound team draft and shows reload guidance on a team switch conflict', async () => {
    const api = server({
      [INVITE_ROUTE]: () => json(409, { code: 'ORGANIZATION_CONTEXT_CHANGED' }),
    })
    renderApp(PATHS.settings)
    const { invitationForm, emailInput } = await fillAndSubmit()
    expect((await within(invitationForm).findByRole('alert')).textContent).toContain(
      'Your team context changed. Reload before making changes.',
    )
    expect(within(invitationForm).getByRole('button', { name: 'Reload' })).toBeDefined()
    expect(invitationForm.textContent).not.toMatch(/permission/i)
    expect(emailInput.value).toBe(EMAIL)
    expect(api.to(INVITE_ROUTE)[0]?.body).toMatchObject({ organizationId: TEAM_ME.organization.id })
  })

  it('aborts the old team request and ignores late success after the form changes teams', async () => {
    const oldResponse = later()
    const otherOrganizationId = '00000000-0000-7000-8000-000000000011'
    const api = server({ [INVITE_ROUTE]: () => oldResponse.response })
    const contents = (organizationId: string) => (
      <MemoryRouter>
        <InterfaceScope surface="admin">
          <SessionProvider>
            <TeamInvitations organizationId={organizationId} />
          </SessionProvider>
        </InterfaceScope>
      </MemoryRouter>
    )
    const view = render(contents(TEAM_ME.organization.id))
    const { user } = await fillAndSubmit()
    await waitFor(() => expect(api.to(INVITE_ROUTE)).toHaveLength(1))
    const pendingSignal = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([request]) =>
        String(request).endsWith('/organization/invite-member'),
      )?.[1]?.signal
    expect(pendingSignal?.aborted).toBe(false)
    view.rerender(contents(otherOrganizationId))
    const currentForm = await form()
    const currentEmail = within(currentForm).getByRole('textbox', {
      name: 'Email',
    }) as HTMLInputElement
    expect(currentEmail.value).toBe('')
    expect(currentEmail.disabled).toBe(false)
    expect(pendingSignal?.aborted).toBe(true)
    await user.type(currentEmail, 'other-member@example.com')
    await oldResponse.answer(json(200, QUEUED_INVITATION))
    expect(currentEmail.value).toBe('other-member@example.com')
    expect(within(currentForm).queryByRole('status')).toBeNull()
    expect(api.to(INVITE_ROUTE)).toHaveLength(1)
    expect(
      api.to(PENDING_ROUTE).map(({ headers }) => headers.get('X-Expected-Organization-Id')),
    ).toEqual([TEAM_ME.organization.id, otherOrganizationId])
  })

  it('states the restricted sign-up policy without promising registration', async () => {
    server()
    renderApp(PATHS.settings)
    const invitationForm = await form()
    expect(invitationForm.textContent).toMatch(/closed|restricted/i)
    expect(invitationForm.textContent).toMatch(
      /earliest user or has a currently allowed email domain/i,
    )
    expect(invitationForm.textContent).toContain(
      'The recipient must verify this exact address and accept the invitation separately to join.',
    )
    expect(invitationForm.textContent).not.toMatch(/anyone can sign up|every invited address can/i)
  })

  it('localizes the invitation form and queued confirmation in Simplified Chinese', async () => {
    chooseLanguage('zh-CN')
    server()
    renderApp(PATHS.settings)
    const invitationForm = await screen.findByRole('region', { name: '邀请成员' })
    expect(within(invitationForm).getByText(/角色.*成员/)).toBeDefined()
    expect(invitationForm.textContent).toContain(
      '仅当邀请者为实例首位用户，或其当前邮箱域名在允许名单中时，邀请才允许注册。',
    )
    expect(invitationForm.textContent).toContain(
      '受邀者须验证该确切邮箱地址，并另行接受邀请才能加入团队。',
    )
    const user = userEvent.setup()
    await user.type(within(invitationForm).getByRole('textbox', { name: '邮箱' }), EMAIL)
    await user.keyboard('{Enter}')
    expect(await within(invitationForm).findByText('邀请已加入投递队列。')).toBeDefined()
    expect(invitationForm.textContent).not.toMatch(/已发送|发送成功|Invitation queued/)
  })

  it.each([
    { status: 409, code: 'INVITATION_ALREADY_PENDING', message: /已有.*邀请|邀请.*待接受/ },
    { status: 409, code: 'INVITATION_RECIPIENT_ALREADY_MEMBER', message: /已属于团队成员/ },
    { status: 409, code: 'INVITATION_PENDING_LIMIT', message: /邀请.*上限|上限.*邀请/ },
    { status: 400, code: 'INVALID_INVITATION_REQUEST', message: /有效的邮箱地址/ },
    { status: 503, code: 'INVITATION_DELIVERY_UNAVAILABLE', message: /无法.*队列|未能.*队列/ },
    { status: 403, code: 'TEAM_MANAGEMENT_ACCESS_DENIED', message: /没有.*权限/ },
    { status: 429, code: 'INVITATION_RATE_LIMITED', message: /限制|频繁/ },
  ])(
    'localizes $code while retaining the draft in Simplified Chinese',
    async ({ status, code, message }) => {
      chooseLanguage('zh-CN')
      server({
        [INVITE_ROUTE]: () =>
          json(status, { code, ...(status === 429 && { retryAfterSeconds: 125 }) }),
      })
      renderApp(PATHS.settings)
      const invitationForm = await screen.findByRole('region', { name: '邀请成员' })
      const user = userEvent.setup()
      const emailInput = within(invitationForm).getByRole('textbox', {
        name: '邮箱',
      }) as HTMLInputElement
      await user.type(emailInput, EMAIL)
      await user.keyboard('{Enter}')
      const alert = await within(invitationForm).findByRole('alert')
      expect(alert.textContent).toMatch(message)
      if (status === 429) expect(alert.textContent).toMatch(/125.*秒/)
      expect(emailInput.value).toBe(EMAIL)
    },
  )
})
