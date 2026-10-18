import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ApiKey } from '../api/auth.ts'
import type { Me } from '../session.tsx'
import {
  fakeApi,
  json,
  ME,
  organizations,
  profile,
  renderApp,
  signedInAs,
} from '../test/fake-api.tsx'

const SECRET = 'hm_NewSecretValueThatIsOnlyShownOnce0123456789abcdefghijklmnopqrstuv'

const existing: ApiKey = {
  id: '00000000-0000-7000-8000-0000000000a1',
  name: 'Claude Desktop',
  start: 'hm_Old',
  enabled: true,
  createdAt: '2026-10-01T09:00:00.000Z',
  expiresAt: null,
  lastRequest: '2026-10-15T17:30:00.000Z',
  metadata: { organizationId: ME.organization.id },
}

const TEAM = {
  id: '00000000-0000-7000-8000-0000000000c3',
  name: 'Acme',
  slug: 'acme',
  personal: false,
}
/** Ada working in her team rather than her personal organization. */
const IN_TEAM: Me = { ...ME, organization: TEAM }

/** Better Auth's API key endpoints over an in-memory list. */
function keyServer(initial: ApiKey[] = [existing], me: Me = ME) {
  let keys = [...initial]
  return fakeApi({
    ...signedInAs(me),
    ...organizations([ME.organization, TEAM]),
    'GET /api/auth/api-key/list': () => json(200, { apiKeys: keys, total: keys.length }),
    'POST /api/auth/api-key/create': ({ body }) => {
      const { name, expiresIn, metadata } = body as {
        name: string
        expiresIn?: number
        metadata: { organizationId: string }
      }
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
        metadata,
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
    renderApp('/app/api-keys')
    const row = await rowFor('Claude Desktop')
    expect(row).not.toBeNull()
    const cells = within(row as HTMLElement)
    expect(cells.getByText('hm_Old…')).toBeDefined()
    expect(cells.getByText(ME.organization.name)).toBeDefined()
    expect(cells.getAllByText('Never')).toHaveLength(1) // expires never; it has been used
    expect(
      screen.getByText(/curl -H "Authorization: Bearer hm_…" http:\/\/localhost:\d+\/api\/v1\/me/),
    ).toBeDefined()
  })

  it('says when there are no keys yet', async () => {
    keyServer([])
    renderApp('/app/api-keys')
    expect(await screen.findByText('You have no API keys yet.')).toBeDefined()
  })

  it('creates a key and shows its secret exactly once', async () => {
    const user = userEvent.setup()
    const api = keyServer()
    renderApp('/app/api-keys')
    await table()

    await user.type(screen.getByLabelText('Name'), 'CI deploy bot')
    await user.selectOptions(screen.getByLabelText('Expires'), 'In 90 days')
    await user.click(screen.getByRole('button', { name: 'Create key' }))

    expect(api.to('POST /api/auth/api-key/create').map((c) => c.body)).toEqual([
      {
        name: 'CI deploy bot',
        expiresIn: 90 * 24 * 60 * 60,
        metadata: { organizationId: ME.organization.id },
      },
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
    // Gone from the page: not in its text, its markup, or any field's value (a hidden
    // input would show in neither of the first two).
    expect(document.body.textContent).not.toContain(SECRET)
    expect(document.body.innerHTML).not.toContain(SECRET)
    for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea',
    )) {
      expect(field.value).not.toContain(SECRET)
      expect(field.defaultValue).not.toContain(SECRET)
    }
    expect(screen.getByRole('heading', { name: 'Create a key' })).toBeDefined()
    // Focus does not drop to the page: it goes to the list, which has the new key.
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your keys' }))
  })

  it('sends no expiry for a key that never expires', async () => {
    const user = userEvent.setup()
    const api = keyServer([])
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    await user.type(screen.getByLabelText('Name'), 'Laptop')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('region', { name: /Copy your new key/ })
    expect(api.to('POST /api/auth/api-key/create')[0]?.body).toEqual({
      name: 'Laptop',
      metadata: { organizationId: ME.organization.id },
    })
  })

  it('creates keys in the organization the person is working in', async () => {
    const user = userEvent.setup()
    const api = keyServer([], IN_TEAM)
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    const form = screen.getByRole('region', { name: 'Create a key' })
    expect(form.textContent).toContain('The key will act in Acme.')

    await user.type(screen.getByLabelText('Name'), 'Team agent')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('region', { name: /Copy your new key/ })
    expect(api.to('POST /api/auth/api-key/create')[0]?.body).toEqual({
      name: 'Team agent',
      metadata: { organizationId: TEAM.id },
    })
    const row = await rowFor('Team agent')
    expect(within(row as HTMLElement).getByText('Acme')).toBeDefined()
  })

  it('names the organization each key acts in', async () => {
    keyServer([
      existing,
      {
        ...existing,
        id: '00000000-0000-7000-8000-0000000000a2',
        name: 'Team bot',
        metadata: { organizationId: TEAM.id },
      },
      {
        ...existing,
        id: '00000000-0000-7000-8000-0000000000a3',
        name: 'Old bot',
        metadata: { organizationId: '00000000-0000-7000-8000-0000000000ff' },
      },
      {
        ...existing,
        id: '00000000-0000-7000-8000-0000000000a4',
        name: 'Legacy bot',
        metadata: null,
      },
    ])
    renderApp('/app/api-keys')
    const organizationIn = async (name: string) =>
      within((await rowFor(name)) as HTMLElement).getByText(
        (_, el) => el?.getAttribute('data-label') === 'Organization',
      ).textContent
    expect(await organizationIn('Claude Desktop')).toBe(ME.organization.name)
    expect(await organizationIn('Team bot')).toBe('Acme')
    expect(await organizationIn('Old bot')).toBe('An organization you have left')
    expect(await organizationIn('Legacy bot')).toBe('Personal organization')
  })

  it('shows why a key could not be created', async () => {
    const user = userEvent.setup()
    fakeApi({
      ...signedInAs(ME),
      ...organizations(),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/api-key/create': () =>
        json(403, {
          code: 'EMAIL_NOT_VERIFIED',
          message:
            'Confirm your email address by signing in with an email link before using API keys',
        }),
    })
    renderApp('/app/api-keys')
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
    renderApp('/app/api-keys')
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
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your keys' }))
    expect(screen.getByText('Revoked “Claude Desktop”.').getAttribute('role')).toBe('status')
  })

  it('cancels revoking with Escape', async () => {
    const user = userEvent.setup()
    const api = keyServer()
    renderApp('/app/api-keys')
    await table()

    await user.click(screen.getByRole('button', { name: 'Revoke Claude Desktop' }))
    expect(screen.getByRole('group', { name: /Revoke “Claude Desktop”\?/ })).toBeDefined()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('group', { name: /Revoke/ })).toBeNull()
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Revoke Claude Desktop' }),
    )
    expect(api.to('POST /api/auth/api-key/delete')).toHaveLength(0)
  })

  it('explains, in plain words, a key refused because the organization changed', async () => {
    const user = userEvent.setup()
    let me: Me = IN_TEAM
    const api = fakeApi({
      'GET /api/v1/profile': () => json(404, { error: 'profile_not_found' }),
      'GET /api/v1/me': () => json(200, me),
      ...organizations([ME.organization]),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/api-key/create': () =>
        json(403, {
          message: 'metadata.organizationId must be an organization you are a member of',
        }),
    })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    // Removed from the team meanwhile; the session now acts in the personal organization.
    me = ME
    await user.type(screen.getByLabelText('Name'), 'Team agent')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      "You're no longer a member of Acme, so no key was created. Keys you create now act in Ada.",
    )
    expect(screen.queryByText(/metadata\.organizationId/)).toBeNull()
    expect(screen.getByRole('region', { name: 'Create a key' }).textContent).toContain(
      'The key will act in Ada, your personal organization.',
    )
    expect(api.to('GET /api/v1/me').length).toBeGreaterThanOrEqual(2)

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not show that explanation on a page the person went to meanwhile', async () => {
    const user = userEvent.setup()
    let me: Me = IN_TEAM
    let refuse: (res: Response) => void = () => {}
    fakeApi({
      'GET /api/v1/me': () => json(200, me),
      ...organizations([ME.organization]),
      ...profile(),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      // The server takes its time to refuse.
      'POST /api/auth/api-key/create': () =>
        new Promise<Response>((resolve) => {
          refuse = resolve
        }),
    })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    me = ME
    await user.type(screen.getByLabelText('Name'), 'Team agent')
    await user.click(screen.getByRole('button', { name: 'Create key' }))

    await user.click(screen.getByRole('link', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    // Not even for a moment: screen readers announce an alert as soon as it appears.
    const alerts: string[] = []
    // Records alerts that were added, even if removed again before the observer ran: a
    // removed subtree keeps its contents, an added one may have lost them meanwhile.
    const watch = new MutationObserver((records) => {
      for (const node of records.flatMap((r) => [...r.addedNodes, ...r.removedNodes])) {
        if (!(node instanceof Element)) continue
        for (const el of [node, ...node.querySelectorAll('*')]) {
          if (el.getAttribute('role') === 'alert') alerts.push(el.textContent)
        }
      }
    })
    watch.observe(document.body, { childList: true, subtree: true, characterData: true })
    await act(async () => {
      refuse(
        json(403, {
          message: 'metadata.organizationId must be an organization you are a member of',
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    // The session moved to the personal organization; Settings shows it, with no warning.
    await vi.waitFor(() =>
      expect(screen.getByText('Organization').nextElementSibling?.textContent).toBe(
        'Ada (personal)',
      ),
    )
    watch.disconnect()
    expect(alerts).toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()

    // Nor does the keys page bring it back later.
    await user.click(screen.getByRole('link', { name: 'API keys' }))
    await screen.findByText('You have no API keys yet.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the key when revoking is cancelled', async () => {
    const user = userEvent.setup()
    const api = keyServer()
    renderApp('/app/api-keys')
    await table()

    await user.click(screen.getByRole('button', { name: 'Revoke Claude Desktop' }))
    await user.keyboard('{Enter}') // focus is on Cancel
    const revoke = screen.getByRole('button', { name: 'Revoke Claude Desktop' })
    expect(document.activeElement).toBe(revoke)
    expect(api.to('POST /api/auth/api-key/delete')).toHaveLength(0)
    expect(await rowFor('Claude Desktop')).not.toBeNull()
  })
})
