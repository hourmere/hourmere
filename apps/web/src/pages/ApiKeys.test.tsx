import { spawnSync } from 'node:child_process'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import mcpDocs from '../../../../docs/mcp.md?raw'
import { API_KEY_ORGANIZATION_MEMBERSHIP_MESSAGE } from '../../../../packages/auth/src/api-key-errors.ts'
import siteMcpDocs from '../../../site/src/content/docs/docs/mcp.md?raw'
import { API_KEY_NAME_MAX_LENGTH, type ApiKey } from '../api/auth.ts'
import { chooseLanguage } from '../i18n/store.ts'
import type { Me } from '../session.tsx'
import styles from '../styles.css?raw'
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
  metadata: { organizationId: ME.organization.id, scope: 'full' },
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
function keyServer(
  initial: ApiKey[] = [existing],
  me: Me = ME,
  options: { publicUrl?: string; refresh?: Promise<Response> } = {},
) {
  let keys = [...initial]
  let reads = 0
  const api = fakeApi({
    ...signedInAs(me),
    ...organizations([ME.organization, TEAM]),
    ...emptyTeamLists,
    ...profile(),
    'GET /api/v1/instance': () =>
      json(200, {
        publicUrl: options.publicUrl ?? window.location.origin,
        signIn: { email: true, google: false, microsoft: false },
      }),
    'GET /api/auth/api-key/list': () => {
      if (reads++ > 0 && options.refresh) return options.refresh
      return json(200, { apiKeys: keys, total: keys.length })
    },
    'POST /api/auth/api-key/create': ({ body }) => {
      const { name, expiresIn, metadata } = body as {
        name: string
        expiresIn?: number
        metadata: { organizationId: string; scope: 'full' | 'read' | 'bookings' }
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
  return {
    ...api,
    removeExternally: (id: string) => {
      keys = keys.filter((key) => key.id !== id)
    },
  }
}

const table = () => screen.findByRole('table')
const rowFor = async (name: string) =>
  (await within(await table()).findByRole('rowheader', { name: new RegExp(name) })).closest('tr')

describe('the API keys page', () => {
  it.each([
    { locale: 'en' as const, legend: 'Scope', name: 'Name' },
    { locale: 'zh-CN' as const, legend: '权限范围', name: '名称' },
  ])('defaults to bookings with labelled keyboard choices in $locale', async (labels) => {
    chooseLanguage(labels.locale)
    const user = userEvent.setup()
    keyServer([])
    renderApp('/app/api-keys')
    await screen.findByLabelText(labels.name)
    const group = screen.getByRole('group', { name: labels.legend })
    const choices = within(group).getAllByRole<HTMLInputElement>('radio')
    expect(choices.map((choice) => choice.value)).toEqual(['bookings', 'read', 'full'])
    expect(choices.map((choice) => choice.checked)).toEqual([true, false, false])
    for (const choice of choices) {
      expect(choice.labels?.length).toBe(1)
      const description = document.getElementById(choice.getAttribute('aria-describedby') ?? '')
      expect(description?.textContent?.trim().length).toBeGreaterThan(20)
      if (labels.locale === 'zh-CN') expect(description?.textContent).toMatch(/。$/)
    }
    expect(group.textContent).toContain(
      labels.locale === 'en'
        ? 'Scope cannot be changed after creation. To change it, create a new key and revoke the old one.'
        : '密钥创建后无法修改权限范围。如需更改，请创建新密钥并撤销旧密钥。',
    )
    expect(choices[0]?.labels?.[0]?.textContent).toContain(
      labels.locale === 'en' ? 'recommended for AI agents' : '推荐用于 AI 智能体',
    )
    expect(choices[1]?.labels?.[0]?.textContent).toContain(
      labels.locale === 'en' ? 'analytics and reporting' : '分析和报表',
    )
    expect(
      document.getElementById(choices[2]?.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain(
      labels.locale === 'en'
        ? 'Only choose this for a client you trust with full account access.'
        : '请仅为你信任、可以授予账户完整访问权限的客户端选择此范围。',
    )
    choices[0]?.focus()
    await user.keyboard('{ArrowRight}')
    expect(choices[1]?.checked).toBe(true)
    expect(document.activeElement).toBe(choices[1])
    await user.keyboard('{ArrowRight}')
    expect(choices[2]?.checked).toBe(true)
    expect(document.activeElement).toBe(choices[2])
  })

  it.each(
    (['en', 'zh-CN'] as const).flatMap((locale) =>
      (['bookings', 'read', 'full'] as const).map((scope) => ({ locale, scope })),
    ),
  )(
    'creates an explicit $scope key and explains its MCP access in $locale',
    async ({ locale, scope }) => {
      chooseLanguage(locale)
      const user = userEvent.setup()
      const api = keyServer([], IN_TEAM)
      renderApp('/app/api-keys')
      await screen.findByLabelText(locale === 'en' ? 'Name' : '名称')
      const group = screen.getByRole('group', { name: locale === 'en' ? 'Scope' : '权限范围' })
      const choice = within(group)
        .getAllByRole<HTMLInputElement>('radio')
        .find((radio) => radio.value === scope)
      await user.click(choice as HTMLInputElement)
      await user.type(screen.getByLabelText(locale === 'en' ? 'Name' : '名称'), 'Scoped agent')
      await user.click(
        screen.getByRole('button', { name: locale === 'en' ? 'Create key' : '创建密钥' }),
      )
      const reveal = await screen.findByRole('region', {
        name: locale === 'en' ? /Copy your new key/ : /复制新密钥/,
      })
      expect(api.to('POST /api/auth/api-key/create')[0]?.body).toEqual({
        name: 'Scoped agent',
        metadata: { organizationId: TEAM.id, scope },
      })
      expect(reveal.textContent).toContain('Acme')
      const expected = {
        en: { bookings: 'Bookings', read: 'Read', full: 'Full account access' },
        'zh-CN': { bookings: '预约读写', read: '只读', full: '账户完整访问权限' },
      }[locale][scope]
      expect(reveal.textContent).toContain(expected)
      const abilities = {
        en: {
          bookings:
            'It can create, reschedule or cancel bookings and retry their conference or your calendar copy.',
          read: 'It cannot create, change or cancel bookings, or change settings.',
          full: 'Browser-only actions, including managing API keys, still require you to sign in.',
        },
        'zh-CN': {
          bookings: '它可以创建、改期或取消预约，以及重试预约的会议或你自己的日历副本。',
          read: '它无法创建、修改或取消预约，也无法修改设置。',
          full: '管理 API 密钥等仅限浏览器的操作仍需你登录后进行。',
        },
      }[locale][scope]
      expect(reveal.textContent).toContain(abilities)
      const scopeText = within(reveal).getByText(
        new RegExp(locale === 'en' ? '^Scope:' : '^权限范围：'),
      )
      const secretField = within(reveal).getByLabelText(
        locale === 'en' ? 'New API key' : '新 API 密钥',
      )
      expect(
        Boolean(scopeText.compareDocumentPosition(secretField) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true)
      const mcp = within(reveal).getByRole('region', {
        name: locale === 'en' ? 'MCP client JSON' : 'MCP 客户端 JSON 配置',
      })
      // Scope is bound to the key on the server, never a client-controlled config property.
      expect(JSON.parse(mcp.textContent ?? '')).toEqual({
        mcpServers: {
          hourmere: {
            type: 'http',
            url: new URL('/mcp', window.location.origin).href,
            headers: { Authorization: `Bearer ${SECRET}` },
          },
        },
      })
      const row = await rowFor('Scoped agent')
      expect(
        row?.querySelector(`[data-label="${locale === 'en' ? 'Scope' : '权限范围'}"]`)?.textContent,
      ).toContain(expected)
    },
  )

  it('clears the old-key reminder when it is revoked while the new key is still revealed', async () => {
    const user = userEvent.setup()
    const api = keyServer()
    renderApp('/app/api-keys')
    await table()
    await user.click(
      screen.getByRole('button', { name: 'Create a replacement for Claude Desktop' }),
    )
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    const reveal = await screen.findByRole('region', { name: /Copy your new key/ })
    expect(
      within(reveal).getByRole('link', { name: /revoke the old key “Claude Desktop”/ }),
    ).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Revoke Claude Desktop' }))
    await user.click(screen.getByRole('button', { name: 'Revoke key' }))
    await waitFor(() =>
      expect(within(reveal).queryByRole('link', { name: /revoke the old key/ })).toBeNull(),
    )
    expect(screen.getByRole('region', { name: /Copy your new key/ })).toBe(reveal)
    expect(within(reveal).getByLabelText<HTMLInputElement>('New API key').value === SECRET).toBe(
      true,
    )
    expect(api.to('POST /api/auth/api-key/delete').map((request) => request.body)).toEqual([
      { keyId: existing.id },
    ])
    await user.click(screen.getByRole('button', { name: 'I’ve saved my key' }))
    expect(
      screen.getByRole('button', { name: 'Revoke Claude Desktop (replacement)' }),
    ).toBeDefined()
    expect(screen.queryByText(/After testing the new key, revoke the old key/)).toBeNull()
  })

  it.each(['en', 'zh-CN'] as const)(
    'shows every stored scope, including migrated legacy full, in %s',
    async (locale) => {
      chooseLanguage(locale)
      keyServer([
        { ...existing, name: 'Legacy full', metadata: { scope: 'full' } },
        {
          ...existing,
          id: 'read',
          name: 'Reports',
          metadata: { organizationId: ME.organization.id, scope: 'read' },
        },
        {
          ...existing,
          id: 'bookings',
          name: 'Scheduler',
          metadata: { organizationId: ME.organization.id, scope: 'bookings' },
        },
        { ...existing, id: 'missing', name: 'Missing scope', metadata: null },
        {
          ...existing,
          id: 'invalid',
          name: 'Invalid scope',
          metadata: { scope: 'unexpected' } as unknown as ApiKey['metadata'],
        },
      ])
      renderApp('/app/api-keys')
      const scopeIn = async (name: string) =>
        (await rowFor(name))?.querySelector(
          `[data-label="${locale === 'en' ? 'Scope' : '权限范围'}"]`,
        )?.textContent
      expect(await scopeIn('Legacy full')).toContain(
        locale === 'en' ? 'Full account access' : '账户完整访问权限',
      )
      expect(await scopeIn('Reports')).toContain(locale === 'en' ? 'Read' : '只读')
      expect(await scopeIn('Scheduler')).toContain(locale === 'en' ? 'Bookings' : '预约读写')
      for (const name of ['Missing scope', 'Invalid scope']) {
        expect(await scopeIn(name)).toBe(locale === 'en' ? 'Unknown scope' : '权限范围未知')
        const row = await rowFor(name)
        const replace = within(row as HTMLElement).getByRole<HTMLButtonElement>('button', {
          name: locale === 'en' ? `Create a replacement for ${name}` : `为 ${name} 创建替代密钥`,
        })
        expect(replace.disabled).toBe(true)
      }
    },
  )

  it.each(['en', 'zh-CN'] as const)(
    'prefills a distinct replacement and identifies the old key for explicit revocation in %s',
    async (locale) => {
      chooseLanguage(locale)
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const user = userEvent.setup()
      const api = keyServer()
      renderApp('/app/api-keys')
      const row = await rowFor('Claude Desktop')
      await user.click(
        within(row as HTMLElement).getByRole('button', {
          name:
            locale === 'en'
              ? 'Create a replacement for Claude Desktop'
              : '为 Claude Desktop 创建替代密钥',
        }),
      )
      const replacementName =
        locale === 'en' ? 'Claude Desktop (replacement)' : 'Claude Desktop（替换）'
      const name = screen.getByLabelText<HTMLInputElement>(locale === 'en' ? 'Name' : '名称')
      expect(name.value).toBe(replacementName)
      expect(document.activeElement).toBe(name)
      expect(confirm).not.toHaveBeenCalled()
      const group = screen.getByRole('group', { name: locale === 'en' ? 'Scope' : '权限范围' })
      const choices = within(group).getAllByRole<HTMLInputElement>('radio')
      expect(choices.find((choice) => choice.checked)?.value).toBe('full')
      const expires = screen.getByLabelText<HTMLSelectElement>(
        locale === 'en' ? 'Expires' : '到期时间',
      )
      expect(expires.value).toBe('')
      expect(
        screen.getByText(
          locale === 'en' ? 'Replacement expires: Never' : '替代密钥到期时间：永不到期',
        ),
      ).toBeDefined()
      expect(api.to('POST /api/auth/api-key/create')).toHaveLength(0)
      await user.click(choices.find((choice) => choice.value === 'read') as HTMLInputElement)
      await user.selectOptions(expires, String(30 * 24 * 60 * 60))
      expect(
        screen.getByText(
          locale === 'en' ? 'Replacement expires: In 30 days' : '替代密钥到期时间：30 天后',
        ),
      ).toBeDefined()
      await user.click(
        screen.getByRole('button', { name: locale === 'en' ? 'Create key' : '创建密钥' }),
      )
      const reveal = await screen.findByRole('region', {
        name: locale === 'en' ? /Copy your new key/ : /复制新密钥/,
      })
      expect(api.to('POST /api/auth/api-key/create')[0]?.body).toEqual({
        name: replacementName,
        expiresIn: 30 * 24 * 60 * 60,
        metadata: { organizationId: ME.organization.id, scope: 'read' },
      })
      expect(api.to('POST /api/auth/api-key/update')).toHaveLength(0)
      expect(api.to('POST /api/auth/api-key/delete')).toHaveLength(0)
      const rows = within(await table()).getAllByRole('row')
      expect(rows).toHaveLength(3)
      const reminder =
        locale === 'en'
          ? 'After testing the new key, revoke the old key “Claude Desktop” (hm_Old…).'
          : '测试新密钥后，请撤销旧密钥“Claude Desktop”（hm_Old…）。'
      expect(within(reveal).getByText(reminder).textContent).toBe(reminder)
      expect(within(reveal).getByRole('link', { name: reminder }).getAttribute('href')).toBe(
        `#api-key-${existing.id}`,
      )
      await user.click(
        screen.getByRole('button', {
          name: locale === 'en' ? 'I’ve saved my key' : '我已保存密钥',
        }),
      )
      expect(screen.getByLabelText<HTMLInputElement>(locale === 'en' ? 'Name' : '名称').value).toBe(
        '',
      )
      expect(
        screen.getAllByRole<HTMLInputElement>('radio').find((choice) => choice.checked)?.value,
      ).toBe('bookings')
      const revokeOld = screen.getByRole('button', {
        name: locale === 'en' ? 'Revoke Claude Desktop' : '撤销 Claude Desktop',
      })
      const oldRow = revokeOld.closest('tr') as HTMLElement
      expect(oldRow.id).toBe(`api-key-${existing.id}`)
      expect(within(oldRow).getByRole('status').textContent).toBe(reminder)
      const newRow = screen
        .getByRole('button', {
          name: locale === 'en' ? `Revoke ${replacementName}` : `撤销 ${replacementName}`,
        })
        .closest('tr') as HTMLElement
      expect(within(newRow).queryByRole('status')).toBeNull()
      expect(document.body.innerHTML.includes(SECRET)).toBe(false)
      await user.click(revokeOld)
      await user.click(
        screen.getByRole('button', { name: locale === 'en' ? 'Revoke key' : '撤销密钥' }),
      )
      await waitFor(() => expect(document.getElementById(`api-key-${existing.id}`)).toBeNull())
      expect(api.to('POST /api/auth/api-key/delete').map((request) => request.body)).toEqual([
        { keyId: existing.id },
      ])
      expect(screen.queryByText(reminder)).toBeNull()
      expect(
        screen.getByRole('button', {
          name: locale === 'en' ? `Revoke ${replacementName}` : `撤销 ${replacementName}`,
        }),
      ).toBeDefined()
    },
  )

  it.each([
    { lifetimeDays: 30, chosenDays: 30, label: 'In 30 days' },
    { lifetimeDays: 90, chosenDays: 90, label: 'In 90 days' },
    { lifetimeDays: 365, chosenDays: 365, label: 'In 1 year' },
    { lifetimeDays: 45, chosenDays: 30, label: 'In 30 days' },
    { lifetimeDays: 60, chosenDays: 30, label: 'In 30 days' },
    { lifetimeDays: 75, chosenDays: 30, label: 'In 30 days' },
    { lifetimeDays: 7, chosenDays: 30, label: 'In 30 days' },
    { lifetimeDays: 227.5, chosenDays: 90, label: 'In 90 days' },
    { lifetimeDays: 300, chosenDays: 90, label: 'In 90 days' },
    { lifetimeDays: null, chosenDays: null, label: 'Never' },
  ])(
    'prefills the longest expiry not exceeding the original $lifetimeDays-day lifetime',
    async ({ lifetimeDays, chosenDays, label }) => {
      const user = userEvent.setup()
      const createdAt = '2025-01-01T09:00:00.000Z'
      const api = keyServer([
        {
          ...existing,
          createdAt,
          expiresAt:
            lifetimeDays === null
              ? null
              : new Date(Date.parse(createdAt) + lifetimeDays * 24 * 60 * 60 * 1000).toISOString(),
        },
      ])
      renderApp('/app/api-keys')
      await table()
      await user.click(
        screen.getByRole('button', { name: 'Create a replacement for Claude Desktop' }),
      )
      const expires = screen.getByLabelText<HTMLSelectElement>('Expires')
      const seconds = chosenDays === null ? undefined : chosenDays * 24 * 60 * 60
      expect(expires.value).toBe(seconds === undefined ? '' : String(seconds))
      expect(within(expires).getByRole('option', { selected: true }).textContent).toBe(label)
      expect(screen.getByText(`Replacement expires: ${label}`).textContent).toBe(
        `Replacement expires: ${label}`,
      )
      await user.click(screen.getByRole('button', { name: 'Create key' }))
      await screen.findByRole('region', { name: /Copy your new key/ })
      expect(api.to('POST /api/auth/api-key/create')[0]?.body).toEqual({
        name: 'Claude Desktop (replacement)',
        ...(seconds === undefined ? {} : { expiresIn: seconds }),
        metadata: { organizationId: ME.organization.id, scope: 'full' },
      })
    },
  )

  it.each(['en', 'zh-CN'] as const)(
    'keeps the replacement suffix within the name limit in %s',
    async (locale) => {
      chooseLanguage(locale)
      const user = userEvent.setup()
      const originalName = 'A'.repeat(API_KEY_NAME_MAX_LENGTH)
      const suffix = locale === 'en' ? ' (replacement)' : '（替换）'
      const api = keyServer([{ ...existing, name: originalName }])
      renderApp('/app/api-keys')
      await table()
      await user.click(
        screen.getByRole('button', {
          name:
            locale === 'en'
              ? `Create a replacement for ${originalName}`
              : `为 ${originalName} 创建替代密钥`,
        }),
      )
      const name = screen.getByLabelText<HTMLInputElement>(locale === 'en' ? 'Name' : '名称')
      expect(name.value).toBe(
        `${originalName.slice(0, API_KEY_NAME_MAX_LENGTH - suffix.length)}${suffix}`,
      )
      expect(name.value.length).toBe(API_KEY_NAME_MAX_LENGTH)
      expect(name.maxLength).toBe(API_KEY_NAME_MAX_LENGTH)
      await user.click(
        screen.getByRole('button', { name: locale === 'en' ? 'Create key' : '创建密钥' }),
      )
      await screen.findByRole('region', {
        name: locale === 'en' ? /Copy your new key/ : /复制新密钥/,
      })
      expect(api.to('POST /api/auth/api-key/create')[0]?.body).toMatchObject({ name: name.value })
    },
  )

  it.each(
    (['en', 'zh-CN'] as const).flatMap((locale) =>
      [false, true].map((alreadySuffixed) => ({ locale, alreadySuffixed })),
    ),
  )(
    'preserves valid Unicode in a $locale replacement name (suffix collision: $alreadySuffixed)',
    async ({ locale, alreadySuffixed }) => {
      chooseLanguage(locale)
      const user = userEvent.setup()
      const suffix = locale === 'en' ? ' (replacement)' : '（替换）'
      const originalName = alreadySuffixed
        ? `${'A'.repeat(API_KEY_NAME_MAX_LENGTH - suffix.length - 2)}😀${suffix}`
        : `a${'😀'.repeat(15)}`
      const api = keyServer([{ ...existing, name: originalName }])
      renderApp('/app/api-keys')
      await table()
      await user.click(
        screen.getByRole('button', {
          name: (label) => label.startsWith(locale === 'en' ? 'Create a replacement for ' : '为 '),
        }),
      )
      const name = screen.getByLabelText<HTMLInputElement>(locale === 'en' ? 'Name' : '名称')
      expect(name.value.isWellFormed()).toBe(true)
      expect(name.value).not.toBe(originalName)
      expect(name.value.endsWith(suffix)).toBe(true)
      expect(name.value.length).toBeLessThanOrEqual(API_KEY_NAME_MAX_LENGTH)
      const prefilledName = name.value
      await user.click(
        screen.getByRole('button', { name: locale === 'en' ? 'Create key' : '创建密钥' }),
      )
      await screen.findByRole('region', {
        name: locale === 'en' ? /Copy your new key/ : /复制新密钥/,
      })
      expect(api.to('POST /api/auth/api-key/create')[0]?.body).toMatchObject({
        name: prefilledName,
      })
    },
  )

  it.each(['en', 'zh-CN'] as const)(
    'keeps a maximum-length already suffixed replacement name distinct in %s',
    async (locale) => {
      chooseLanguage(locale)
      const user = userEvent.setup()
      const suffix = locale === 'en' ? ' (replacement)' : '（替换）'
      const originalName = `${'A'.repeat(API_KEY_NAME_MAX_LENGTH - suffix.length)}${suffix}`
      keyServer([{ ...existing, name: originalName }])
      renderApp('/app/api-keys')
      await table()
      await user.click(
        screen.getByRole('button', {
          name:
            locale === 'en'
              ? `Create a replacement for ${originalName}`
              : `为 ${originalName}创建替代密钥`,
        }),
      )
      const name = screen.getByLabelText<HTMLInputElement>(locale === 'en' ? 'Name' : '名称')
      expect(name.value).not.toBe(originalName)
      expect(name.value.endsWith(suffix)).toBe(true)
      expect(name.value.length).toBeLessThanOrEqual(API_KEY_NAME_MAX_LENGTH)
      expect(name.value.startsWith('A')).toBe(true)
    },
  )

  it.each(['name', 'expiry', 'scope', 'all'] as const)(
    'asks before replacing an unsaved $0 draft and preserves it on decline',
    async (field) => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const user = userEvent.setup()
      const api = keyServer([
        {
          ...existing,
          expiresAt: new Date(
            Date.parse(existing.createdAt) + 90 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        },
      ])
      renderApp('/app/api-keys')
      await table()
      if (field === 'name' || field === 'all')
        await user.type(screen.getByLabelText('Name'), 'Unfinished agent')
      if (field === 'expiry' || field === 'all')
        await user.selectOptions(screen.getByLabelText('Expires'), String(30 * 24 * 60 * 60))
      if (field === 'scope' || field === 'all')
        await user.click(screen.getByRole('radio', { name: /Read — analytics/ }))
      const draftName = field === 'name' || field === 'all' ? 'Unfinished agent' : ''
      const draftExpiry = field === 'expiry' || field === 'all' ? String(30 * 24 * 60 * 60) : ''
      const draftScope = field === 'scope' || field === 'all' ? 'read' : 'bookings'
      const replacement = screen.getByRole('button', {
        name: 'Create a replacement for Claude Desktop',
      })
      await user.click(replacement)
      expect(confirm).toHaveBeenCalledExactlyOnceWith(LEAVE_WITH_UNSAVED_CHANGES)
      expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe(draftName)
      expect(screen.getByLabelText<HTMLSelectElement>('Expires').value).toBe(draftExpiry)
      expect(
        screen.getAllByRole<HTMLInputElement>('radio').find((choice) => choice.checked)?.value,
      ).toBe(draftScope)
      expect(screen.queryByRole('button', { name: 'Cancel replacement' })).toBeNull()
      confirm.mockReturnValue(true)
      await user.click(replacement)
      expect(confirm).toHaveBeenCalledTimes(2)
      expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe(
        'Claude Desktop (replacement)',
      )
      expect(screen.getByLabelText<HTMLSelectElement>('Expires').value).toBe(
        String(90 * 24 * 60 * 60),
      )
      expect(
        screen.getAllByRole<HTMLInputElement>('radio').find((choice) => choice.checked)?.value,
      ).toBe('full')
      expect(document.activeElement).toBe(screen.getByLabelText('Name'))
      expect(api.to('POST /api/auth/api-key/create')).toHaveLength(0)
      expect(api.to('POST /api/auth/api-key/delete')).toHaveLength(0)
    },
  )

  it('preserves the current replacement draft when reselected or a different replacement is declined', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    keyServer([
      existing,
      {
        ...existing,
        id: 'reports',
        name: 'Reports',
        metadata: { organizationId: ME.organization.id, scope: 'read' },
        expiresAt: new Date(
          Date.parse(existing.createdAt) + 365 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    ])
    renderApp('/app/api-keys')
    await table()
    const first = screen.getByRole('button', { name: 'Create a replacement for Claude Desktop' })
    await user.click(first)
    expect(confirm).not.toHaveBeenCalled()
    await user.clear(screen.getByLabelText('Name'))
    await user.type(screen.getByLabelText('Name'), 'Replacement draft')
    await user.selectOptions(screen.getByLabelText('Expires'), String(30 * 24 * 60 * 60))
    await user.click(first)
    expect(confirm).not.toHaveBeenCalled()
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Replacement draft')
    const second = screen.getByRole('button', { name: 'Create a replacement for Reports' })
    await user.click(second)
    expect(confirm).toHaveBeenCalledExactlyOnceWith(LEAVE_WITH_UNSAVED_CHANGES)
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Replacement draft')
    expect(screen.getByLabelText<HTMLSelectElement>('Expires').value).toBe(
      String(30 * 24 * 60 * 60),
    )
    expect(
      screen.getAllByRole<HTMLInputElement>('radio').find((choice) => choice.checked)?.value,
    ).toBe('full')
    confirm.mockReturnValue(true)
    await user.click(second)
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Reports (replacement)')
    expect(screen.getByLabelText<HTMLSelectElement>('Expires').value).toBe(
      String(365 * 24 * 60 * 60),
    )
    expect(
      screen.getAllByRole<HTMLInputElement>('radio').find((choice) => choice.checked)?.value,
    ).toBe('read')
  })

  it('keeps replacement shortcuts unavailable while a new key request is pending', async () => {
    const pending = later()
    const user = userEvent.setup()
    const api = fakeApi({
      ...signedInAs(ME),
      ...organizations([ME.organization]),
      'GET /api/v1/instance': () =>
        json(200, {
          publicUrl: window.location.origin,
          signIn: { email: true, google: false, microsoft: false },
        }),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [existing], total: 1 }),
      'POST /api/auth/api-key/create': () => pending.response,
    })
    renderApp('/app/api-keys')
    await table()
    await user.type(screen.getByLabelText('Name'), 'Pending agent')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    const replace = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Create a replacement for Claude Desktop',
    })
    expect(replace.disabled).toBe(true)
    await user.click(replace)
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Pending agent')
    await pending.answer(
      json(200, {
        ...existing,
        name: 'Pending agent',
        metadata: { organizationId: ME.organization.id, scope: 'bookings' },
        key: SECRET,
      }),
    )
    await screen.findByRole('region', { name: /Copy your new key/ })
    expect(replace.disabled).toBe(true)
    expect(api.to('POST /api/auth/api-key/create')).toHaveLength(1)
  })

  it('asks before cancelling an unsaved replacement and returns focus to the fresh name field', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    const api = keyServer()
    renderApp('/app/api-keys')
    await table()
    await user.click(
      screen.getByRole('button', { name: 'Create a replacement for Claude Desktop' }),
    )
    await user.click(screen.getByRole('button', { name: 'Cancel replacement' }))
    expect(confirm).toHaveBeenCalledExactlyOnceWith(LEAVE_WITH_UNSAVED_CHANGES)
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe(
      'Claude Desktop (replacement)',
    )
    expect(screen.getByLabelText<HTMLSelectElement>('Expires').value).toBe('')
    expect(
      screen.getAllByRole<HTMLInputElement>('radio').find((choice) => choice.checked)?.value,
    ).toBe('full')
    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Cancel replacement' }))
    const name = screen.getByLabelText<HTMLInputElement>('Name')
    expect(name.value).toBe('')
    expect(document.activeElement).toBe(name)
    expect(
      screen.getAllByRole<HTMLInputElement>('radio').find((choice) => choice.checked)?.value,
    ).toBe('bookings')
    expect(screen.getByLabelText<HTMLSelectElement>('Expires').value).toBe('')
    confirm.mockClear()
    await user.click(
      screen.getByRole('button', { name: 'Create a replacement for Claude Desktop' }),
    )
    expect(confirm).not.toHaveBeenCalled()
    expect(api.to('POST /api/auth/api-key/create')).toHaveLength(0)
    expect(api.to('POST /api/auth/api-key/delete')).toHaveLength(0)
  })

  it('requires switching to the source organization before replacing its key', async () => {
    const user = userEvent.setup()
    const api = keyServer([{ ...existing, metadata: { organizationId: TEAM.id, scope: 'read' } }])
    renderApp('/app/api-keys')
    const row = await rowFor('Claude Desktop')
    const replacement = within(row as HTMLElement).getByRole<HTMLButtonElement>('button', {
      name: 'Create a replacement for Claude Desktop',
    })
    expect(replacement.disabled).toBe(true)
    expect(row?.textContent).toContain('Switch to this key’s organization to create a replacement.')
    await user.click(replacement)
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('')
    expect(api.to('POST /api/auth/api-key/create')).toHaveLength(0)
  })

  it('treats a scope-only selection as an unsaved draft', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()
    keyServer([])
    renderApp('/app/api-keys')
    await screen.findByLabelText('Name')
    const full = screen
      .getAllByRole<HTMLInputElement>('radio')
      .find((radio) => radio.value === 'full')
    await user.click(full as HTMLInputElement)
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES)
    expect(screen.getByRole('heading', { name: 'API keys', level: 1 })).toBeDefined()
    expect(full?.checked).toBe(true)
  })

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
      screen.getByText(
        /curl -H "Authorization: Bearer hm_…" 'http:\/\/localhost:\d+\/api\/v1\/me'/,
      ),
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
        metadata: { organizationId: ME.organization.id, scope: 'bookings' },
      },
    ])
    const reveal = await screen.findByRole('region', { name: /Copy your new key “CI deploy bot”/ })
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(within(reveal).getByRole('heading', { level: 2 })),
    )
    expect(within(reveal).getByText(/won’t be able to see this key again/)).toBeDefined()
    expect(within(reveal).getByLabelText<HTMLInputElement>('New API key').value).toBe(SECRET)
    expect(
      within(reveal).getByRole('region', { name: 'New API key test command' }).textContent,
    ).toContain(`Bearer ${SECRET}`)

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

  it.each([
    {
      locale: 'en' as const,
      name: 'Name',
      create: 'Create key',
      json: 'MCP client JSON',
      command: 'Claude Code command',
      copyJson: 'Copy MCP JSON',
      copyCommand: 'Copy Claude command',
      copied: 'Copied',
      saved: 'I’ve saved my key',
    },
    {
      locale: 'zh-CN' as const,
      name: '名称',
      create: '创建密钥',
      json: 'MCP 客户端 JSON 配置',
      command: 'Claude Code 命令',
      copyJson: '复制 MCP JSON 配置',
      copyCommand: '复制 Claude 命令',
      copied: '已复制',
      saved: '我已保存密钥',
    },
  ])(
    'copies instance MCP snippets by keyboard and removes them on dismiss in $locale',
    async (labels) => {
      chooseLanguage(labels.locale)
      const user = userEvent.setup()
      const publicUrl = 'https://schedule.example.test:8443/'
      keyServer([], ME, { publicUrl })
      renderApp('/app/api-keys')
      await screen.findByLabelText(labels.name)
      await user.type(screen.getByLabelText(labels.name), 'MCP agent')
      await user.click(screen.getByRole('button', { name: labels.create }))
      const jsonRegion = await screen.findByRole('region', { name: labels.json })
      const commandRegion = screen.getByRole('region', { name: labels.command })
      expect(JSON.parse(jsonRegion.textContent ?? '')).toEqual({
        mcpServers: {
          hourmere: {
            type: 'http',
            url: 'https://schedule.example.test:8443/mcp',
            headers: { Authorization: `Bearer ${SECRET}` },
          },
        },
      })
      expect(commandRegion.textContent).toBe(
        `claude mcp add --transport http hourmere 'https://schedule.example.test:8443/mcp' \\\n  --header "Authorization: Bearer ${SECRET}"`,
      )
      for (const docs of [mcpDocs, siteMcpDocs]) {
        for (const region of [jsonRegion, commandRegion]) {
          const example = (region.textContent ?? '')
            .replaceAll(SECRET, 'hm_…')
            .replaceAll('https://schedule.example.test:8443', 'https://hourmere.example.com')
          expect(docs.includes(example)).toBe(true)
        }
      }
      for (const [region, label] of [
        [jsonRegion, labels.copyJson],
        [commandRegion, labels.copyCommand],
      ] as const) {
        expect(region.getAttribute('tabindex')).toBe('0')
        region.focus()
        await user.tab()
        expect(document.activeElement).toBe(screen.getByRole('button', { name: label }))
        await user.keyboard('{Enter}')
        expect(await navigator.clipboard.readText()).toBe(region.textContent)
        expect(within(region.parentElement as HTMLElement).getByRole('status').textContent).toBe(
          labels.copied,
        )
      }
      const listed = await rowFor('MCP agent')
      expect(listed?.innerHTML.includes(SECRET)).toBe(false)
      expect(screen.getAllByRole('table')).toHaveLength(1)
      await user.click(screen.getByRole('button', { name: labels.saved }))
      expect(document.body.innerHTML.includes(SECRET)).toBe(false)
      expect(document.body.textContent?.includes(SECRET)).toBe(false)
      for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input, textarea',
      )) {
        expect(field.value.includes(SECRET)).toBe(false)
        expect(field.defaultValue.includes(SECRET)).toBe(false)
      }
      expect(screen.queryByRole('region', { name: labels.json })).toBeNull()
      expect(screen.queryByRole('region', { name: labels.command })).toBeNull()
    },
  )

  it('shows the new key immediately while the list refresh is pending', async () => {
    const refresh = later()
    const user = userEvent.setup()
    const api = keyServer([], ME, { refresh: refresh.response })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    await user.type(screen.getByLabelText('Name'), 'Immediate key')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('region', { name: /Copy your new key/ })
    const row = await rowFor('Immediate key')
    expect(within(row as HTMLElement).getByText('hm_New…')).toBeDefined()
    expect(row?.innerHTML.includes(SECRET)).toBe(false)
    expect(screen.queryByText('You have no API keys yet.')).toBeNull()
    expect(api.to('GET /api/auth/api-key/list')).toHaveLength(2)
    await refresh.answer(json(200, { apiKeys: [], total: 0 }))
    expect(await rowFor('Immediate key')).not.toBeNull()
  })

  it('keeps the key available and retries when instance configuration cannot load', async () => {
    const user = userEvent.setup()
    let available = false
    fakeApi({
      ...signedInAs(ME),
      ...organizations([ME.organization]),
      'GET /api/v1/instance': () =>
        available
          ? json(200, {
              publicUrl: 'https://recovered.example.test',
              signIn: { email: true, google: false, microsoft: false },
            })
          : json(503, { error: 'unavailable', message: 'Unavailable' }),
      'GET /api/auth/api-key/list': () => json(200, { apiKeys: [], total: 0 }),
      'POST /api/auth/api-key/create': () => json(200, { ...existing, key: SECRET }),
    })
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    await user.type(screen.getByLabelText('Name'), 'Recover config')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByText('Could not load MCP configuration.')
    expect(screen.getByLabelText<HTMLInputElement>('New API key').value === SECRET).toBe(true)
    expect(screen.queryByRole('region', { name: 'MCP client JSON' })).toBeNull()
    available = true
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    const config = await screen.findByRole('region', { name: 'MCP client JSON' })
    expect(JSON.parse(config.textContent ?? '')).toMatchObject({
      mcpServers: { hourmere: { url: 'https://recovered.example.test/mcp' } },
    })
    expect(screen.queryByText('Could not load MCP configuration.')).toBeNull()
  })

  it('uses the refreshed list after the server has confirmed a new key', async () => {
    const user = userEvent.setup()
    const api = keyServer()
    renderApp('/app/api-keys')
    await table()
    await user.type(screen.getByLabelText('Name'), 'Confirmed key')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await waitFor(() => expect(api.to('GET /api/auth/api-key/list')).toHaveLength(2))
    await act(async () => {})
    await rowFor('Confirmed key')
    api.removeExternally('00000000-0000-7000-8000-0000000000b2')
    await user.click(screen.getByRole('button', { name: 'Revoke Claude Desktop' }))
    await user.click(screen.getByRole('button', { name: 'Revoke key' }))
    await screen.findByText('You have no API keys yet.')
    expect(screen.queryByRole('rowheader', { name: 'Confirmed key' })).toBeNull()
  })

  it.each(['http://[::1]:4318', "https://quote'$USER.example"])(
    'pastes commands with shell-safe URL arguments for %s',
    async (publicUrl) => {
      const user = userEvent.setup()
      keyServer([], ME, { publicUrl })
      renderApp('/app/api-keys')
      await screen.findByText('You have no API keys yet.')
      await user.type(screen.getByLabelText('Name'), 'Shell key')
      await user.click(screen.getByRole('button', { name: 'Create key' }))
      const command = await screen.findByRole('region', { name: 'Claude Code command' })
      for (const [region, program, expected] of [
        [
          command,
          'claude',
          [
            'mcp',
            'add',
            '--transport',
            'http',
            'hourmere',
            new URL('/mcp', publicUrl).href,
            '--header',
            `Authorization: Bearer ${SECRET}`,
          ],
        ],
        [
          screen.getByRole('region', { name: 'New API key test command' }),
          'curl',
          ['-H', `Authorization: Bearer ${SECRET}`, new URL('/api/v1/me', publicUrl).href],
        ],
      ] as const) {
        // Only a shell function runs: no Claude process, network or provider call.
        const run = spawnSync(
          'zsh',
          ['-f', '-c', `${program}() { printf '%s\\0' "$@"; }\n${region.textContent}`],
          { encoding: 'utf8' },
        )
        expect(run.status).toBe(0)
        expect(
          JSON.stringify(run.stdout.split('\0').slice(0, -1)) === JSON.stringify(expected),
        ).toBe(true)
      }
    },
  )

  it('forgets the one-time key when leaving and returning to the page', async () => {
    const user = userEvent.setup()
    keyServer([])
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    await user.type(screen.getByLabelText('Name'), 'Navigation key')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('region', { name: 'MCP client JSON' })
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings', level: 1 })
    expect(document.body.innerHTML.includes(SECRET)).toBe(false)
    await user.click(screen.getByRole('link', { name: 'API keys' }))
    await rowFor('Navigation key')
    expect(document.body.innerHTML.includes(SECRET)).toBe(false)
    expect(screen.queryByRole('region', { name: 'MCP client JSON' })).toBeNull()
  })

  it('constrains code blocks to the available width while keeping code scrollable', async () => {
    const user = userEvent.setup()
    keyServer([])
    renderApp('/app/api-keys')
    await screen.findByText('You have no API keys yet.')
    await user.type(screen.getByLabelText('Name'), 'Layout key')
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    await screen.findByRole('region', { name: 'MCP client JSON' })
    const sheet = document.createElement('style')
    sheet.textContent = styles
    document.head.append(sheet)
    try {
      for (const block of document.querySelectorAll('.code-block')) {
        expect(getComputedStyle(block).gridTemplateColumns).toBe('minmax(0, 1fr)')
        expect(getComputedStyle(block).minWidth).toBe('0px')
        const pre = block.querySelector('pre') as HTMLElement
        expect(getComputedStyle(pre).overflowX).toBe('auto')
      }
    } finally {
      sheet.remove()
    }
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
      metadata: { organizationId: ME.organization.id, scope: 'bookings' },
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
      metadata: { organizationId: TEAM.id, scope: 'bookings' },
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
        metadata: { organizationId: TEAM.id, scope: 'bookings' },
      },
      {
        ...existing,
        id: '00000000-0000-7000-8000-0000000000a3',
        name: 'Old bot',
        metadata: { organizationId: '00000000-0000-7000-8000-0000000000ff', scope: 'full' },
      },
      {
        ...existing,
        id: '00000000-0000-7000-8000-0000000000a4',
        name: 'Legacy bot',
        metadata: { scope: 'full' },
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
        metadata: { organizationId: TEAM.id, scope: 'bookings' },
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
      metadata: { organizationId: TEAM.id, scope: 'bookings' },
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
