import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { goTo } from '../browser.ts'
import { fakeApi, json, later, ME, renderApp, signedIn } from '../test/fake-api.tsx'

vi.mock('../browser.ts', () => ({ goTo: vi.fn() }))
const query = 'client_id=https%3A%2F%2Fconnector.test%2Fclient.json&sig=signed'
const info = {
  clientName: 'Synthetic AI app',
  clientId: 'https://connector.test/client.json',
  redirectUri: 'https://connector.test/callback',
  scopes: ['mcp:tools', 'offline_access'],
  organizations: [
    ME.organization,
    { id: '00000000-0000-7000-8000-000000000003', name: 'Team Alpha', slug: 'alpha' },
  ],
  selectedOrganization: null,
}

describe('MCP connection approval', () => {
  beforeEach(() => vi.mocked(goTo).mockClear())
  it('shows the signed request, requires an explicit organization, and submits only that organization', async () => {
    const user = userEvent.setup(),
      api = fakeApi({
        ...signedIn,
        'POST /api/v1/mcp-oauth/request': () => json(200, info),
        'POST /api/v1/mcp-oauth/select': () =>
          json(200, { redirectUrl: 'http://localhost/oauth/consent?sig=continued#intent=chosen' }),
      })
    renderApp(`/oauth/authorize?${query}`)
    await screen.findByText('Synthetic AI app')
    expect(screen.getByText(/attendee information and answers/)).toBeDefined()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(true)
    await user.selectOptions(
      screen.getByLabelText('Organization to connect'),
      info.organizations[1]?.id as string,
    )
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(api.to('POST /api/v1/mcp-oauth/select')[0]?.body).toEqual({
      oauthQuery: query,
      organizationId: info.organizations[1]?.id,
    })
    expect(goTo).toHaveBeenCalledWith('http://localhost/oauth/consent?sig=continued#intent=chosen')
  })
  it.each([true, false])(
    'pins consent to the selected organization and submits accept=%s',
    async (accept) => {
      const user = userEvent.setup(),
        api = fakeApi({
          ...signedIn,
          'POST /api/v1/mcp-oauth/request': () =>
            json(200, { ...info, selectedOrganization: info.organizations[1] }),
          'POST /api/v1/mcp-oauth/consent': () =>
            json(200, { redirectUrl: 'https://connector.test/callback?code=synthetic' }),
        })
      renderApp(`/oauth/consent?${query}#intent=00000000-0000-7000-8000-000000000004`)
      await screen.findByText('Team Alpha')
      expect(screen.queryByRole('combobox', { name: 'Organization to connect' })).toBeNull()
      expect(api.to('POST /api/v1/mcp-oauth/request')[0]?.body).toEqual({
        oauthQuery: query,
        intentId: '00000000-0000-7000-8000-000000000004',
      })
      await user.click(screen.getByRole('button', { name: accept ? 'Allow access' : 'Deny' }))
      expect(api.to('POST /api/v1/mcp-oauth/consent')[0]?.body).toEqual({
        oauthQuery: query,
        intentId: '00000000-0000-7000-8000-000000000004',
        accept,
      })
      expect(goTo).toHaveBeenCalledWith('https://connector.test/callback?code=synthetic')
    },
  )
  it('requires restarting a consent page without its session-bound intent', async () => {
    const api = fakeApi(signedIn)
    renderApp(`/oauth/consent?${query}`)
    expect(await screen.findByText(/attempt was interrupted/)).toBeDefined()
    expect(api.to('POST /api/v1/mcp-oauth/request')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Allow access' })).toBeNull()
  })
  it('does not navigate when a slow authorization response arrives after leaving the page', async () => {
    const user = userEvent.setup(),
      pending = later()
    fakeApi({
      ...signedIn,
      'POST /api/v1/mcp-oauth/request': () => json(200, info),
      'POST /api/v1/mcp-oauth/select': () => pending.response,
    })
    const rendered = renderApp(`/oauth/authorize?${query}`)
    await screen.findByText('Synthetic AI app')
    await user.selectOptions(screen.getByLabelText('Organization to connect'), ME.organization.id)
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    rendered.unmount()
    await act(async () => pending.answer(json(200, { redirectUrl: 'https://connector.test/late' })))
    expect(goTo).not.toHaveBeenCalled()
  })
  it('lets the owner revoke an app, and explains disabled instances', async () => {
    let revoked = false
    const api = fakeApi({
      ...signedIn,
      'GET /api/v1/mcp-oauth/connections': () =>
        json(200, {
          data: revoked
            ? []
            : [
                {
                  id: '00000000-0000-7000-8000-000000000004',
                  clientName: 'Synthetic AI app',
                  clientId: info.clientId,
                  organizationName: 'Team Alpha',
                  createdAt: '2026-10-17T00:00:00Z',
                },
              ],
        }),
      'DELETE /api/v1/mcp-oauth/connections/00000000-0000-7000-8000-000000000004': () => {
        revoked = true
        return json(200, { success: true })
      },
    })
    renderApp('/app/connected-apps')
    await screen.findByText('Team Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }))
    expect(await screen.findByText('No connected apps.')).toBeDefined()
    expect(
      api.to('DELETE /api/v1/mcp-oauth/connections/00000000-0000-7000-8000-000000000004'),
    ).toHaveLength(1)
  })
})
