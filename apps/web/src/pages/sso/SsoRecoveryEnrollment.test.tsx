import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { App } from '../../App.tsx'
import { PATHS } from '../../paths.ts'
import {
  emptyTeamLists,
  fakeApi,
  json,
  later,
  ME,
  profile,
  type Routes,
  signedInAs,
} from '../../test/fake-api.tsx'

const team = {
  id: '00000000-0000-7000-8000-000000000071',
  name: 'Team One',
  slug: 'team-one',
  personal: false,
}
const otherTeamId = '00000000-0000-7000-8000-000000000072'
const nomineeId = '00000000-0000-7000-8000-000000000073'
const memberId = '00000000-0000-7000-8000-000000000074'
const enrollmentId = '00000000-0000-7000-8000-000000000075'
const proofAttemptId = '00000000-0000-7000-8000-000000000076'
const acceptPath = `POST /api/v1/team/sso/recovery/${enrollmentId}/accept`
const nominatePath = 'POST /api/v1/team/sso/recovery'
const policyPath = 'GET /api/v1/team/sso/policy'
const membershipPath = 'GET /api/auth/organization/get-active-member'
const mailboxSend = 'POST /api/auth/sso/mailbox-proof/send'
const mailboxConsume = 'POST /api/auth/sso/mailbox-proof/consume'
const acceptHeading = 'Accept recovery nomination'
const unavailable = 'This recovery nomination is unavailable. Ask a team owner to send a new one.'
const proofHeading = 'Confirm your identity before changing SSO settings.'

function nominationHash(organizationId = team.id, revision = '13') {
  return `#ssoRecoveryEnrollment=${enrollmentId}&organizationId=${organizationId}&expectedRevision=${revision}`
}

function CurrentHash() {
  return <output data-testid="current-hash">{useLocation().hash}</output>
}

function settings({
  hash = '',
  role = 'owner',
  routes = {},
}: {
  hash?: string
  role?: string
  routes?: Routes
} = {}) {
  const viewer = { ...ME, organization: team }
  const requests = fakeApi({
    ...signedInAs(viewer),
    ...emptyTeamLists,
    ...profile(),
    'GET /api/v1/instance': () => json(200, { ssoOidcEnabled: true, ssoSamlEnabled: false }),
    [membershipPath]: () => json(200, { organizationId: team.id, userId: viewer.user.id, role }),
    'GET /api/auth/organization/list-members': () =>
      json(200, {
        members: [
          {
            id: 'co-owner',
            organizationId: team.id,
            userId: nomineeId,
            role: 'owner',
            user: { id: nomineeId, name: 'Second Owner' },
          },
          {
            id: 'member',
            organizationId: team.id,
            userId: memberId,
            role: 'admin',
            user: { id: memberId, name: 'Team Admin' },
          },
        ],
        total: 2,
      }),
    ...routes,
  })
  render(
    <MemoryRouter initialEntries={[`${PATHS.settings}${hash}`]}>
      <App />
      <CurrentHash />
    </MemoryRouter>,
  )
  return { requests, user: userEvent.setup() }
}

const noSsoCalls = (requests: ReturnType<typeof fakeApi>) =>
  expect(requests.calls.filter(({ path }) => path.includes('/sso/'))).toEqual([])

const mailRoutes: Routes = {
  [mailboxSend]: () => json(202, { status: 'queued' }),
  [mailboxConsume]: () => json(200, { status: 'proven' }),
}

function challenge() {
  return json(403, {
    error: 'sso_reauthentication_required',
    attemptId: proofAttemptId,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    proofMethods: ['mailbox'],
  })
}

async function finishProof(user: ReturnType<typeof userEvent.setup>) {
  const heading = await screen.findByRole('heading', { name: proofHeading })
  expect(document.activeElement).toBe(heading)
  const next = screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' })
  expect(next.disabled).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Send verification email' }))
  const field = await screen.findByLabelText('Email verification link')
  await user.click(field)
  await user.paste(
    `${window.location.origin}${PATHS.mailboxProof}#attempt=${proofAttemptId}&token=synthetic-mailbox-token`,
  )
  await user.click(screen.getByRole('button', { name: 'Verify email link' }))
  await waitFor(() => expect(next.disabled).toBe(false))
  await user.click(next)
}

const hasProof = (body: unknown) =>
  (body as { proofAttemptId?: string }).proofAttemptId === proofAttemptId

function expectBound(calls: ReturnType<typeof fakeApi>['calls']) {
  for (const { headers } of calls) {
    expect(headers.get('X-Expected-Organization-Id')).toBe(team.id)
    expect(headers.get('Authorization')).toBeNull()
  }
}

describe('SSO recovery enrollment in team settings', () => {
  it('nominates another owner with fresh proof and leaves their 72-hour consent pending', async () => {
    const { requests, user } = settings({
      routes: {
        ...mailRoutes,
        [policyPath]: () =>
          json(200, {
            requireSso: false,
            admission: 'invitation_only',
            policyRevision: 12,
            trustGeneration: 1,
          }),
        [nominatePath]: ({ body }) =>
          hasProof(body)
            ? json(201, {
                enrollmentId,
                expiresAt: new Date(Date.now() + 72 * 60 * 60_000).toISOString(),
                policyRevision: 13,
              })
            : challenge(),
      },
    })
    const nominate = await screen.findByRole('button', {
      name: 'Nominate Second Owner for SSO recovery',
    })
    expect(
      screen.queryByRole('button', { name: 'Nominate Team Admin for SSO recovery' }),
    ).toBeNull()
    await user.click(nominate)
    const form = within(screen.getByRole('region', { name: 'Nominate a recovery owner' }))
    expect(
      form.getByText('The nominee has 72 hours to accept using their Hourmere email.'),
    ).toBeDefined()
    noSsoCalls(requests)
    await user.click(form.getByRole('button', { name: 'Send nomination' }))
    await finishProof(user)
    await form.findByText('Recovery nomination sent.')
    expect(form.getByText(/^The nomination expires on /)).toBeDefined()
    expect(requests.to(policyPath)).toHaveLength(1)
    expect(requests.to(nominatePath).map(({ body }) => body)).toEqual([
      { ownerUserId: nomineeId, expectedRevision: 12 },
      { ownerUserId: nomineeId, expectedRevision: 12, proofAttemptId },
    ])
    expectBound([
      ...requests.to(policyPath),
      ...requests.to(nominatePath),
      ...requests.to(mailboxSend),
      ...requests.to(mailboxConsume),
    ])
    expect(requests.to(acceptPath)).toHaveLength(0)
    await user.click(form.getByRole('button', { name: 'Close' }))
    expect(document.activeElement).toBe(nominate)
  })

  it('accepts a nomination in the enforced team only after the nominee consents and verifies their own mailbox', async () => {
    const { requests, user } = settings({
      hash: nominationHash(),
      routes: {
        ...mailRoutes,
        [membershipPath]: () => json(403, { code: 'SSO_REQUIRED', message: 'sso_required' }),
        [acceptPath]: ({ body }) =>
          hasProof(body) ? new Response(null, { status: 204 }) : challenge(),
      },
    })
    const accept = await screen.findByRole('button', { name: 'Accept nomination' })
    const form = within(screen.getByRole('region', { name: acceptHeading }))
    await waitFor(() => expect(screen.getByTestId('current-hash').textContent).toBe(''))
    noSsoCalls(requests)
    await user.click(accept)
    await finishProof(user)
    await form.findByText('You are now a recovery owner for this team.')
    expect(requests.to(acceptPath).map(({ body }) => body)).toEqual([
      { expectedRevision: 13 },
      { expectedRevision: 13, proofAttemptId },
    ])
    expectBound([
      ...requests.to(acceptPath),
      ...requests.to(mailboxSend),
      ...requests.to(mailboxConsume),
    ])
    expect(requests.to(policyPath)).toHaveLength(0)
    expect(requests.to(nominatePath)).toHaveLength(0)
  })

  it.each([
    [403, 'team_management_access_denied'],
    [404, 'sso_not_found'],
    [409, 'sso_configuration_changed'],
  ])('keeps a refused or expired nomination neutral (%s)', async (status, error) => {
    const { requests, user } = settings({
      hash: nominationHash(),
      routes: {
        [acceptPath]: () => json(status, { error, message: 'Private endpoint detail' }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Accept nomination' }))
    const form = within(screen.getByRole('region', { name: acceptHeading }))
    await form.findByText(unavailable)
    expect(form.queryByText('Private endpoint detail')).toBeNull()
    expect(form.queryByRole('button', { name: 'Accept nomination' })).toBeNull()
    expect(form.queryByRole('heading', { name: proofHeading })).toBeNull()
    expect(requests.to(acceptPath)).toHaveLength(1)
    expect(requests.to(mailboxSend)).toHaveLength(0)
  })

  it('keeps the link inert in another team, with no cross-team request', async () => {
    const hash = nominationHash(otherTeamId)
    const { requests } = settings({ hash })
    await screen.findByText('Switch to the nominated team, then reopen the link from your email.')
    expect(screen.getByTestId('current-hash').textContent).toBe(hash)
    expect(screen.queryByRole('button', { name: 'Accept nomination' })).toBeNull()
    noSsoCalls(requests)
  })

  it('omits owner controls for a confirmed non-owner', async () => {
    const { requests } = settings({ hash: nominationHash(), role: 'admin' })
    await screen.findByText(unavailable)
    await screen.findByText('Second Owner')
    expect(screen.queryByRole('button', { name: 'Accept nomination' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'SSO recovery' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Nominate/ })).toBeNull()
    noSsoCalls(requests)
  })

  it('keeps unconfirmed membership loading and error states neutral', async () => {
    const membership = later()
    const { requests } = settings({
      hash: nominationHash(),
      routes: { [membershipPath]: () => membership.response },
    })
    const form = within(await screen.findByRole('region', { name: acceptHeading }))
    await form.findByText('Loading recovery nomination…')
    expect(form.queryByRole('button', { name: 'Accept nomination' })).toBeNull()
    expect(form.queryByText(unavailable)).toBeNull()
    await membership.answer(json(403, { code: 'TEAM_MANAGEMENT_ACCESS_DENIED' }))
    await screen.findByText('Could not load the recovery nomination.')
    const error = within(screen.getByRole('region', { name: acceptHeading }))
    expect(error.queryByText(unavailable)).toBeNull()
    expect(error.queryByRole('button', { name: 'Accept nomination' })).toBeNull()
    noSsoCalls(requests)
  })

  it('does not submit a nomination when the policy read is denied', async () => {
    const { requests, user } = settings({
      routes: { [policyPath]: () => json(403, { error: 'team_management_access_denied' }) },
    })
    await user.click(
      await screen.findByRole('button', { name: 'Nominate Second Owner for SSO recovery' }),
    )
    await user.click(screen.getByRole('button', { name: 'Send nomination' }))
    await screen.findByText('SSO settings are unavailable in this team.')
    expectBound(requests.to(policyPath))
    expect(requests.to(nominatePath)).toHaveLength(0)
    expect(screen.queryByRole('heading', { name: proofHeading })).toBeNull()
  })

  it('omits recovery entry and all SSO fetches while capabilities are unknown or off', async () => {
    const instance = later()
    const { requests } = settings({
      hash: nominationHash(),
      routes: { 'GET /api/v1/instance': () => instance.response },
    })
    await screen.findByText('Second Owner')
    expect(screen.queryByRole('heading', { name: acceptHeading })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Nominate/ })).toBeNull()
    noSsoCalls(requests)
    await instance.answer(json(200, { ssoOidcEnabled: false, ssoSamlEnabled: false }))
    expect(screen.queryByRole('heading', { name: acceptHeading })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Nominate/ })).toBeNull()
    expect(screen.queryByRole('link', { name: 'SSO recovery' })).toBeNull()
    noSsoCalls(requests)
  })

  it.each(['0', '2147483647', '2.5', '2&expectedRevision=2'])(
    'keeps malformed revision %s inert',
    async (revision) => {
      const { requests } = settings({ hash: nominationHash(team.id, revision) })
      await screen.findByText(unavailable)
      await waitFor(() => expect(screen.getByTestId('current-hash').textContent).toBe(''))
      noSsoCalls(requests)
    },
  )
})
