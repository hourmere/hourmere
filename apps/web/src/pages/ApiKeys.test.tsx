import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { API_KEY_ORGANIZATION_MEMBERSHIP_MESSAGE } from '../../../../packages/auth/src/api-key-errors.ts'
import type { ApiKey } from '../api/auth.ts'
import { chooseLanguage } from '../i18n/store.ts'
import type { Me } from '../session.tsx'
import { browserLocale } from '../test/browser-locale.ts'
import {
  emptyTeamLists,
  fakeApi,
  json,
  later,
  ME,
  organizations,
  profile,
  renderApp,
  signedInAs,
} from '../test/fake-api.tsx'
import { LEAVE_WITH_UNSAVED_CHANGES } from '../unsaved-changes.tsx'

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
  it.each([
    {
      locale: 'en' as const,
      name: 'Name',
      create: 'Create key',
      usage: 'API key usage command',
      newKey: 'New API key test command',
    },
    {
      locale: 'zh-CN' as const,
      name: '名称',
      create: '创建密钥',
      usage: 'API 密钥使用命令',
      newKey: '新 API 密钥测试命令',
    },
  ])('makes both scrollable command regions keyboard reachable in $locale', async (labels) => {
    chooseLanguage(labels.locale)
    const user = userEvent.setup()
    keyServer()
    renderApp('/app/api-keys')
    const usage = await screen.findByRole('region', { name: labels.usage })
    await user.type(screen.getByLabelText(labels.name), 'Keyboard test')
    await user.click(screen.getByRole('button', { name: labels.create }))
    const newKey = await screen.findByRole('region', { name: labels.newKey })

    for (const command of [usage, newKey]) {
      expect(command.tagName).toBe('PRE')
      expect(command.getAttribute('data-layout-scroll')).toBe('horizontal')
      expect(command.getAttribute('tabindex')).toBe('0')
      command.focus()
      expect(document.activeElement).toBe(command)
      await user.tab()
      expect(document.activeElement).toBe(command.parentElement?.querySelector('button'))
      await user.tab({ shift: true })
      expect(document.activeElement).toBe(command)
    }
  })

  it('distinguishes Chinese resource names, unused keys and nonexpiring keys', async () => {
    chooseLanguage('zh-CN')
    keyServer([{ ...existing, lastRequest: null }])
    renderApp('/app/api-keys')
    await screen.findByRole('heading', { name: 'API 密钥', level: 1 })
    expect(screen.getByLabelText('名称')).toBeDefined()
    const row = await rowFor(existing.name as string)
    expect(row?.querySelector('[data-label="上次使用"]')?.textContent).toBe('从未使用')
    expect(row?.querySelector('[data-label="到期时间"]')?.textContent).toBe('永不到期')
    const hint = document.getElementById(
      screen.getByLabelText('名称').getAttribute('aria-describedby') ?? '',
    )
    expect(hint?.querySelectorAll('.cjk-quote')).toHaveLength(2)
  })

  it('uses Chinese sentence punctuation in the usage and organization hints', async () => {
    chooseLanguage('zh-CN')
    keyServer()
    renderApp('/app/api-keys')
    await screen.findByRole('heading', { name: 'API 密钥', level: 1 })
    expect(screen.getByRole('link', { name: 'OpenAPI 文档' }).closest('p')?.textContent).toBe(
      'API 说明参见 OpenAPI 文档。',
    )
    expect(screen.getByText('密钥将作用于', { exact: false }).textContent).toBe(
      `密钥将作用于 ${ME.organization.name}（你的个人组织）。`,
    )
    await screen.findByText('hm_Old…')
  })

  it.each(['fa-IR', 'th-TH'])(
    'keeps API key dates Gregorian for browser locale %s',
    async (locale) => {
      browserLocale(locale)
      keyServer([{ ...existing, expiresAt: '2030-11-02T09:00:00.000Z' }])
      renderApp('/app/api-keys')
      const row = await rowFor('Claude Desktop')
      for (const iso of [
        existing.createdAt,
        existing.lastRequest as string,
        '2030-11-02T09:00:00.000Z',
      ]) {
        const time = row?.querySelector(`time[datetime="${iso}"]`)
        const full = new Intl.DateTimeFormat(locale, {
          calendar: 'gregory',
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(iso))
        expect(time?.getAttribute('title')).toBe(full)
        expect(time?.classList.contains('date-time')).toBe(true)
        expect(time?.closest('td')?.classList.contains('nowrap')).toBe(false)
        expect([...(time?.querySelectorAll('span') ?? [])].map((part) => part.textContent)).toEqual(
          [
            new Intl.DateTimeFormat(locale, { calendar: 'gregory', dateStyle: 'medium' }).format(
              new Date(iso),
            ),
            new Intl.DateTimeFormat(locale, { calendar: 'gregory', timeStyle: 'short' }).format(
              new Date(iso),
            ),
          ],
        )
      }
    },
  )

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
    expect(
      screen
        .getByRole('heading', { name: 'API keys', level: 1 })
        .closest('.page-intro')
        ?.querySelector('.lede'),
    ).not.toBeNull()
    const action = screen.getByRole('link', { name: 'Create your first key' })
    expect(action.closest('.empty-actions')).not.toBeNull()
    expect(action.getAttribute('href')).toBe('#key-name')
    expect(document.querySelector(action.getAttribute('href') as string)).toBe(
      screen.getByLabelText('Name'),
    )
    const command = screen.getByRole('button', { name: 'Copy command' }).closest('.code-block')
    expect(command?.querySelector('pre')?.getAttribute('data-layout-scroll')).toBe('horizontal')
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
    await vi.waitFor(() => expect(document.activeElement).toBe(within(reveal).getByRole('heading')))
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

  it.each(['FORBIDDEN', 'INSTANCE_POLICY_DENIED', undefined])(
    'uses the normal permission error for an unrelated 403 with code %s',
    async (code) => {
      const user = userEvent.setup()
      fakeApi({
        ...signedInAs(IN_TEAM),
        ...organizations([ME.organization, TEAM]),
        'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
        'POST /api/auth/api-key/create': () =>
          json(403, { code, message: 'API key creation is disabled by instance policy.' }),
      })
      renderApp('/app/api-keys')
      await screen.findByText('You have no API keys yet.')
      await user.type(screen.getByLabelText('Name'), 'Policy-refused key')
      await user.click(screen.getByRole('button', { name: 'Create key' }))
      const alerts = await screen.findAllByRole('alert')
      expect(alerts).toHaveLength(1)
      expect(alerts[0]?.textContent).toBe(
        "Could not create the key. You don't have permission to do that.",
      )
      expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Policy-refused key')
    },
  )

  it.each([
    { status: 409, code: 'organization_context_changed' },
    { status: 409, code: 'ORGANIZATION_CONTEXT_CHANGED' },
    { status: 403, code: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION' },
  ])('offers context recovery for $status $code', async ({ status, code }) => {
    const user = userEvent.setup()
    fakeApi({
      ...signedInAs(IN_TEAM),
      ...organizations([ME.organization, TEAM]),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/api-key/create': () => json(status, { code, message: 'Context drift.' }),
    })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    await user.type(screen.getByLabelText('Name'), 'Original team key')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('button', { name: 'Reload' })
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Original team key')
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

  // Use the server's actual wording so changes must keep the browser's legacy match in sync.
  it.each(['en', 'zh-CN'] as const)(
    'recognizes the server legacy membership refusal and keeps a recoverable key draft in %s',
    async (locale) => {
      chooseLanguage(locale)
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const user = userEvent.setup()
      let me: Me = IN_TEAM
      const api = fakeApi({
        'GET /api/v1/profile': () => json(404, { error: 'profile_not_found' }),
        'GET /api/v1/me': () => json(200, me),
        ...organizations([ME.organization]),
        'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
        'POST /api/auth/api-key/create': () =>
          json(403, {
            message: API_KEY_ORGANIZATION_MEMBERSHIP_MESSAGE,
          }),
      })
      renderApp('/app/api-keys')
      await screen.findByRole('heading', {
        name: locale === 'en' ? 'API keys' : 'API 密钥',
        level: 1,
      })
      // Removed from the team meanwhile; the session now acts in the personal organization.
      me = ME
      const name = locale === 'en' ? 'Name' : '名称'
      const expires = locale === 'en' ? 'Expires' : '到期时间'
      await user.type(screen.getByLabelText(name), 'Team agent')
      await user.selectOptions(screen.getByLabelText(expires), String(90 * 24 * 60 * 60))
      await user.click(
        screen.getByRole('button', { name: locale === 'en' ? 'Create key' : '创建密钥' }),
      )
      await screen.findByText(
        locale === 'en'
          ? "Could not create the key: you can't create keys in Acme."
          : '无法创建密钥：你不能在 Acme 中创建密钥。',
      )
      expect(screen.queryByText(/metadata\.organizationId/)).toBeNull()
      expect((screen.getByLabelText(name) as HTMLInputElement).value).toBe('Team agent')
      expect((screen.getByLabelText(expires) as HTMLSelectElement).value).toBe(
        String(90 * 24 * 60 * 60),
      )
      expect(api.to('POST /api/auth/api-key/create')[0]?.body).toMatchObject({
        metadata: { organizationId: TEAM.id },
      })
      expect(api.to('GET /api/v1/me')).toHaveLength(1)
      expect(
        screen.queryByRole('button', { name: locale === 'en' ? 'Reload' : '重新加载' }),
      ).not.toBeNull()
      await user.click(
        screen.getByRole('button', { name: locale === 'en' ? 'Reload' : '重新加载' }),
      )
      expect(confirm).toHaveBeenCalled()
      expect((screen.getByLabelText(name) as HTMLInputElement).value).toBe('Team agent')
      confirm.mockReturnValue(true)
      await user.click(
        screen.getByRole('button', { name: locale === 'en' ? 'Reload' : '重新加载' }),
      )
      await waitFor(() => expect((screen.getByLabelText(name) as HTMLInputElement).value).toBe(''))
      expect(api.to('POST /api/auth/api-key/create')).toHaveLength(1)
    },
  )

  it('keeps the original key target after a declined multi-tab switch', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    let me: Me = IN_TEAM
    const api = fakeApi({
      ...signedInAs(IN_TEAM),
      ...organizations([ME.organization, TEAM]),
      'GET /api/v1/me': () => json(200, me),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/api-key/create': ({ body }) =>
        json(200, { ...existing, ...(body as object), key: SECRET }),
    })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    await user.type(screen.getByLabelText('Name'), 'Original team agent')
    me = ME
    await act(async () => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Original team agent')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('region', { name: /Copy your new key/ })
    expect(api.to('POST /api/auth/api-key/create')[0]?.body).toEqual({
      name: 'Original team agent',
      metadata: { organizationId: TEAM.id },
    })
  })

  it('does not show that explanation on a page the person went to meanwhile', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    let me: Me = IN_TEAM
    let refuse: (res: Response) => void = () => {}
    fakeApi({
      ...emptyTeamLists,
      'GET /api/v1/me': () => json(200, me),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: TEAM.id, userId: ME.user.id, role: 'member' }),
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
          message: API_KEY_ORGANIZATION_MEMBERSHIP_MESSAGE,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    // A late refusal cannot replace the current session or publish a warning.
    await vi.waitFor(() =>
      expect(screen.getByText('Organization').nextElementSibling?.textContent).toBe(TEAM.name),
    )
    watch.disconnect()
    expect(alerts).toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()

    // Nor does the keys page bring it back later.
    await user.click(screen.getByRole('link', { name: 'API keys' }))
    await screen.findByText('You have no API keys yet.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('discards a late key secret after an accepted multi-tab switch', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    const pending = later()
    let me: Me = IN_TEAM
    const api = fakeApi({
      ...signedInAs(IN_TEAM),
      ...organizations([ME.organization, TEAM]),
      'GET /api/v1/me': () => json(200, me),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/api-key/create': () => pending.response,
    })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    await user.type(screen.getByLabelText('Name'), 'Late team key')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    me = ME
    fireEvent(window, new Event('focus'))
    await waitFor(() => expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(''))
    await pending.answer(json(200, { ...existing, name: 'Late team key', key: SECRET }))
    expect(screen.queryByRole('region', { name: /Copy your new key/ })).toBeNull()
    expect(document.body.innerHTML).not.toContain(SECRET)
    expect(api.to('POST /api/auth/api-key/create')).toHaveLength(1)
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
