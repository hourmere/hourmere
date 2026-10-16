import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { ApiKey } from '../api/auth.ts'
import { fakeApi, json, renderApp, signedIn } from '../test/fake-api.tsx'

const SECRET = 'hm_NewSecretValueThatIsOnlyShownOnce0123456789abcdefghijklmnopqrstuv'

const existing: ApiKey = {
  id: '00000000-0000-7000-8000-0000000000a1',
  name: 'Claude Desktop',
  start: 'hm_Old',
  enabled: true,
  createdAt: '2026-10-01T09:00:00.000Z',
  expiresAt: null,
  lastRequest: '2026-10-15T17:30:00.000Z',
}

/** Better Auth's API key endpoints over an in-memory list. */
function keyServer(initial: ApiKey[] = [existing]) {
  let keys = [...initial]
  return fakeApi({
    ...signedIn,
    'GET /api/auth/api-key/list': () => json(200, { apiKeys: keys, total: keys.length }),
    'POST /api/auth/api-key/create': ({ body }) => {
      const { name, expiresIn } = body as { name: string; expiresIn?: number }
      const created = {
        id: '00000000-0000-7000-8000-0000000000b2',
        name,
        start: SECRET.slice(0, 6),
        enabled: true,
        createdAt: '2026-10-16T10:00:00.000Z',
        expiresAt: expiresIn
          ? new Date(Date.parse('2026-10-16T10:00:00.000Z') + expiresIn * 1000).toISOString()
          : null,
        lastRequest: null,
      }
      keys = [created, ...keys]
      return json(200, { ...created, key: SECRET })
    },
    'POST /api/auth/api-key/delete': ({ body }) => {
      const { keyId } = body as { keyId: string }
      keys = keys.filter((k) => k.id !== keyId)
      return json(200, { success: true })
    },
  })
}

const table = () => screen.findByRole('table')
const rowFor = async (name: string) =>
  (await within(await table()).findByRole('rowheader', { name: new RegExp(name) })).closest('tr')

describe('the API keys page', () => {
  it('lists keys by name and prefix, never by secret', async () => {
    keyServer()
    renderApp('/api-keys')
    const row = await rowFor('Claude Desktop')
    expect(row).not.toBeNull()
    const cells = within(row as HTMLElement)
    expect(cells.getByText('hm_Old…')).toBeDefined()
    expect(cells.getAllByText('Never')).toHaveLength(1) // expires never; it has been used
    expect(
      screen.getByText(/curl -H "Authorization: Bearer hm_…" http:\/\/localhost:\d+\/api\/v1\/me/),
    ).toBeDefined()
  })

  it('says when there are no keys yet', async () => {
    keyServer([])
    renderApp('/api-keys')
    expect(await screen.findByText('You have no API keys yet.')).toBeDefined()
  })

  it('creates a key and shows its secret exactly once', async () => {
    const user = userEvent.setup()
    const api = keyServer()
    renderApp('/api-keys')
    await table()

    await user.type(screen.getByLabelText('Name'), 'CI deploy bot')
    await user.selectOptions(screen.getByLabelText('Expires'), 'In 90 days')
    await user.click(screen.getByRole('button', { name: 'Create key' }))

    expect(api.to('POST /api/auth/api-key/create').map((c) => c.body)).toEqual([
      { name: 'CI deploy bot', expiresIn: 90 * 24 * 60 * 60 },
    ])
    const reveal = await screen.findByRole('region', { name: /Copy your new key “CI deploy bot”/ })
    expect(document.activeElement).toBe(within(reveal).getByRole('heading'))
    expect(within(reveal).getByText(/won’t be able to see this key again/)).toBeDefined()
    expect(within(reveal).getByLabelText<HTMLInputElement>('New API key').value).toBe(SECRET)
    expect(within(reveal).getByText(new RegExp(`Bearer ${SECRET}`))).toBeDefined()

    await user.click(within(reveal).getByRole('button', { name: 'Copy key' }))
    expect(await navigator.clipboard.readText()).toBe(SECRET)
    expect(within(reveal).getByText('Copied')).toBeDefined()

    // The list now has the new key, by prefix only.
    const row = await rowFor('CI deploy bot')
    expect(within(row as HTMLElement).getByText('hm_New…')).toBeDefined()

    await user.click(within(reveal).getByRole('button', { name: 'I’ve saved my key' }))
    expect(screen.queryByRole('region', { name: /Copy your new key/ })).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)
    expect(screen.getByRole('heading', { name: 'Create a key' })).toBeDefined()
  })

  it('sends no expiry for a key that never expires', async () => {
    const user = userEvent.setup()
    const api = keyServer([])
    renderApp('/api-keys')
    await screen.findByText('You have no API keys yet.')
    await user.type(screen.getByLabelText('Name'), 'Laptop')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('region', { name: /Copy your new key/ })
    expect(api.to('POST /api/auth/api-key/create')[0]?.body).toEqual({ name: 'Laptop' })
  })

  it('shows why a key could not be created', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...signedIn,
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/api-key/create': () =>
        json(403, {
          code: 'EMAIL_NOT_VERIFIED',
          message:
            'Confirm your email address by signing in with an email link before using API keys',
        }),
    })
    renderApp('/api-keys')
    await screen.findByText('You have no API keys yet.')
    await user.type(screen.getByLabelText('Name'), 'Agent')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not create the key. Confirm your email address by signing in with an email link before using API keys',
    )
    expect(screen.queryByRole('region', { name: /Copy your new key/ })).toBeNull()
  })

  it('revokes a key after confirmation', async () => {
    const user = userEvent.setup()
    const api = keyServer()
    renderApp('/api-keys')
    await table()

    await user.click(screen.getByRole('button', { name: 'Revoke Claude Desktop' }))
    const confirm = screen.getByRole('group', { name: /Revoke “Claude Desktop”\?/ })
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(api.to('POST /api/auth/api-key/delete')).toHaveLength(0)

    await user.click(within(confirm).getByRole('button', { name: 'Revoke key' }))
    expect(await screen.findByText('You have no API keys yet.')).toBeDefined()
    expect(api.to('POST /api/auth/api-key/delete').map((c) => c.body)).toEqual([
      { keyId: existing.id },
    ])
  })

  it('keeps the key when revoking is cancelled', async () => {
    const user = userEvent.setup()
    const api = keyServer()
    renderApp('/api-keys')
    await table()

    await user.click(screen.getByRole('button', { name: 'Revoke Claude Desktop' }))
    await user.keyboard('{Enter}') // focus is on Cancel
    const revoke = screen.getByRole('button', { name: 'Revoke Claude Desktop' })
    expect(document.activeElement).toBe(revoke)
    expect(api.to('POST /api/auth/api-key/delete')).toHaveLength(0)
    expect(await rowFor('Claude Desktop')).not.toBeNull()
  })
})
