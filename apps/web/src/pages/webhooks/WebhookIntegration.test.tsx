import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Me } from '../../session.tsx'
import {
  emptyTeamLists,
  fakeApi,
  json,
  later,
  ME,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'

const LIST = 'GET /api/v1/webhooks'
const ROLE = 'GET /api/auth/organization/get-active-member'
const TEAM: Me = {
  ...ME,
  organization: {
    id: '00000000-0000-7000-8000-000000000040',
    name: 'Example team',
    slug: 'example-team',
    personal: false,
  },
}

const endpointFor = (me: Me) => ({
  id: '00000000-0000-7000-8000-000000000041',
  organizationId: me.organization.id,
  url: 'https://receiver.example.test/private',
  events: ['booking.created'],
  isActive: true,
})

function membership(role: string) {
  return json(200, {
    id: 'membership-1',
    organizationId: TEAM.organization.id,
    userId: TEAM.user.id,
    role,
    createdAt: '2026-10-01T09:00:00.000Z',
  })
}

const openSettings = async () => {
  renderApp('/app/settings')
  return within(await screen.findByRole('region', { name: 'Integrations' }))
}

describe('Webhooks in Settings → Integrations', () => {
  it.each(['personal owner', 'owner', 'admin'])('opens only on demand for %s', async (role) => {
    const me = role === 'personal owner' ? ME : TEAM
    const api = fakeApi({
      ...signedInAs(me),
      ...emptyTeamLists,
      [ROLE]: () => membership(role),
      [LIST]: () => json(200, []),
    })
    const integrations = await openSettings()
    const toggle = await integrations.findByRole('button', { name: 'Webhooks' })
    expect(integrations.getByRole('button', { name: 'Slack booking notifications' })).toBeTruthy()
    expect(api.to(LIST)).toHaveLength(0)
    await userEvent.click(toggle)
    expect(await integrations.findByText('No webhook endpoints yet.')).toBeTruthy()
    expect(api.to(LIST)).toHaveLength(1)
    expect(api.to(LIST)[0]?.headers.get('x-expected-organization-id')).toBe(me.organization.id)
  })

  it('shows a neutral check before team authority is known and denies a member', async () => {
    const role = later()
    const api = fakeApi({
      ...signedInAs(TEAM),
      ...emptyTeamLists,
      [ROLE]: () => role.response.then((response) => response.clone()),
    })
    const integrations = await openSettings()
    expect(integrations.getByRole('status').textContent).toBe('Checking webhook access…')
    expect(integrations.queryByRole('button', { name: 'Webhooks' })).toBeNull()
    await role.answer(membership('member'))
    expect(await integrations.findByRole('alert')).toBeTruthy()
    expect(integrations.getByText('Webhook endpoints are unavailable.')).toBeTruthy()
    expect(integrations.queryByRole('button', { name: 'Webhooks' })).toBeNull()
    expect(api.to(LIST)).toHaveLength(0)
  })

  it('uses a retryable neutral state if team membership could not be checked', async () => {
    let denied = true
    const api = fakeApi({
      ...signedInAs(TEAM),
      ...emptyTeamLists,
      [ROLE]: () => (denied ? json(503, { error: 'unavailable' }) : membership('owner')),
    })
    const integrations = await openSettings()
    expect(await integrations.findByText('Webhook endpoints are unavailable.')).toBeTruthy()
    expect(integrations.queryByRole('button', { name: 'Webhooks' })).toBeNull()
    expect(api.to(LIST)).toHaveLength(0)
    denied = false
    await userEvent.click(integrations.getByRole('button', { name: 'Try again' }))
    expect(await integrations.findByRole('button', { name: 'Webhooks' })).toBeTruthy()
    expect(api.to(LIST)).toHaveLength(0)
  })

  it('clears list and management controls when a team admin is denied on return', async () => {
    let allowed = true
    const endpoint = endpointFor(TEAM)
    const api = fakeApi({
      ...signedInAs(TEAM),
      ...emptyTeamLists,
      [ROLE]: () => membership('admin'),
      [LIST]: () =>
        allowed ? json(200, [endpoint]) : json(403, { error: 'team_management_access_denied' }),
    })
    const integrations = await openSettings()
    await userEvent.click(await integrations.findByRole('button', { name: 'Webhooks' }))
    expect(await integrations.findByText(endpoint.id)).toBeTruthy()
    allowed = false
    fireEvent.focus(window)
    await waitFor(() => expect(integrations.queryByText(endpoint.id)).toBeNull())
    expect(integrations.getByRole('alert').textContent).toBe('Webhook endpoints are unavailable.')
    expect(integrations.queryByRole('button', { name: 'Webhooks' })).toBeNull()
    expect(integrations.queryByRole('button', { name: 'Edit webhook' })).toBeNull()
    expect(api.to(LIST)).toHaveLength(2)
    expect(document.activeElement).toBe(integrations.getByRole('heading', { name: 'Webhooks' }))
  })

  it('keeps the accordion open during a write and allows collapse after the result', async () => {
    const endpoint = endpointFor(ME)
    const rotation = later()
    const rotate = `POST /api/v1/webhooks/${endpoint.id}/rotate-secret`
    const api = fakeApi({
      ...signedInAs(ME),
      [LIST]: () => json(200, [endpoint]),
      [rotate]: () => rotation.response,
    })
    const user = userEvent.setup()
    const integrations = await openSettings()
    const toggle = await integrations.findByRole('button', { name: 'Webhooks' })
    await user.click(toggle)
    await user.click(await integrations.findByRole('button', { name: 'Edit webhook' }))
    await user.click(integrations.getByRole('button', { name: 'Rotate signing secret…' }))
    await user.click(integrations.getByRole('button', { name: 'Rotate signing secret' }))
    await waitFor(() => expect(api.to(rotate)).toHaveLength(1))

    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(integrations.getByText('Saving webhook settings…')).toBeTruthy()

    await rotation.answer(json(200, { secret: 'synthetic-webhook-secret' }))
    expect(await integrations.findByRole('button', { name: 'Copy signing secret' })).toBeTruthy()
    await user.click(integrations.getByRole('button', { name: 'Dismiss' }))
    await user.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(integrations.queryByRole('region', { name: 'Webhooks' })).toBeNull()
    expect(api.to(rotate)).toHaveLength(1)
  })
})
