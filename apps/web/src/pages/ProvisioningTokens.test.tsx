import '../i18n/admin.ts'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AccountLanguage, InterfaceScope } from '../i18n/runtime.tsx'
import { fakeApi, json, later } from '../test/fake-api.tsx'
import { ProvisioningTokens } from './ProvisioningTokens.tsx'

const ORG = '00000000-0000-7000-8000-000000000002'
const BASE = `/api/v1/organizations/${ORG}/provisioning-tokens`
const TOKEN = {
  id: 'token-1',
  organizationId: ORG,
  name: 'Directory',
  createdAt: '2026-11-06T12:00:00Z',
  lastUsedAt: null,
  previousValidUntil: null,
  revokedAt: null,
}
// A noncredential marker keeps intentional assertion failures free of bearer material.
const MARKER = 'one-time-display-marker'
function view(
  role: string | null = 'owner',
  organizationId = ORG,
  locale = 'en',
  timeZone = 'America/Los_Angeles',
) {
  return (
    <MemoryRouter>
      <InterfaceScope surface="admin">
        <AccountLanguage locale={locale}>
          <ProvisioningTokens organizationId={organizationId} role={role} timeZone={timeZone} />
          <Link to="?other">Navigate</Link>
        </AccountLanguage>
      </InterfaceScope>
    </MemoryRouter>
  )
}
function setup(extra = {}) {
  return fakeApi({
    'GET /api/v1/instance': () => json(200, { scimProvisioningEnabled: true }),
    [`GET ${BASE}`]: () => json(200, { tokens: [TOKEN] }),
    [`POST ${BASE}`]: () => json(201, { token: TOKEN, secret: MARKER }),
    ...extra,
  })
}
async function create() {
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('Provisioning token name'), 'Directory')
  await user.click(screen.getByRole('button', { name: 'Create provisioning token' }))
  await screen.findByRole('region', { name: 'New provisioning token' })
  return user
}
describe('SCIM provisioning credentials', () => {
  it.each([null, 'member', 'unknown'])(
    'does not fetch tokens without confirmed management role %s',
    async (role) => {
      const api = setup()
      render(view(role))
      await waitFor(() => expect(api.to('GET /api/v1/instance')).toHaveLength(1))
      expect(screen.queryByRole('heading', { name: 'SCIM provisioning tokens' })).toBeNull()
      expect(api.to(`GET ${BASE}`)).toHaveLength(0)
    },
  )
  it.each([false, undefined])(
    'allows revocation but no minting when feature is %s',
    async (flag) => {
      const api = setup({
        'GET /api/v1/instance': () => json(200, { scimProvisioningEnabled: flag }),
        [`DELETE ${BASE}/token-1`]: () => json(200, { token: TOKEN }),
      })
      render(view())
      await waitFor(() => expect(api.to('GET /api/v1/instance')).toHaveLength(1))
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: 'Revoke token' }))
      await user.click(screen.getByRole('button', { name: 'Confirm token change' }))
      await waitFor(() => expect(api.to(`DELETE ${BASE}/token-1`)).toHaveLength(1))
      expect(screen.queryByRole('button', { name: 'Create provisioning token' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Rotate token' })).toBeNull()
    },
  )
  it('lets admins list and revoke but never create or rotate tokens', async () => {
    const api = setup({ [`DELETE ${BASE}/token-1`]: () => json(200, { token: TOKEN }) })
    render(view('admin'))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Revoke token' }))
    expect(screen.queryByRole('button', { name: 'Create provisioning token' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rotate token' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Confirm token change' }))
    await waitFor(() => expect(api.to(`DELETE ${BASE}/token-1`)).toHaveLength(1))
  })
  it.each(['en', 'zh-CN'])(
    'formats timestamps with the user locale and time zone (%s)',
    async (locale) => {
      const date = '2026-11-06T12:00:00Z'
      setup({
        [`GET ${BASE}`]: () =>
          json(200, {
            tokens: [{ ...TOKEN, lastUsedAt: date, previousValidUntil: '2000-01-01T00:00:00Z' }],
          }),
      })
      render(view('owner', ORG, locale, 'Pacific/Honolulu'))
      const formatted = new Intl.DateTimeFormat(locale, {
        calendar: 'gregory',
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Pacific/Honolulu',
      }).format(new Date(date))
      await screen.findByText((text) => text.includes(formatted))
      expect(screen.getByText(locale === 'en' ? 'Active' : '启用')).toBeDefined()
      expect(document.body.textContent).not.toContain(date)
      expect(document.body.textContent).not.toContain('2000-01-01')
    },
  )
  it('shows a future overlap using a localized date', async () => {
    const date = new Date(Date.now() + 3600000).toISOString()
    setup({
      [`GET ${BASE}`]: () => json(200, { tokens: [{ ...TOKEN, previousValidUntil: date }] }),
    })
    render(view())
    const formatted = new Intl.DateTimeFormat('en', {
      calendar: 'gregory',
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Los_Angeles',
    }).format(new Date(date))
    await screen.findByText(`Previous token valid until: ${formatted}`)
  })
  it('paginates token metadata using the server cursor and can return to the first page', async () => {
    const api = setup({
      [`GET ${BASE}`]: (call: { path: string }) =>
        json(
          200,
          new URL(call.path, 'http://localhost').searchParams.has('after')
            ? { tokens: [{ ...TOKEN, id: 'second', name: 'Second directory' }], nextCursor: null }
            : { tokens: [TOKEN], nextCursor: TOKEN.id },
        ),
    })
    render(view())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Next page' }))
    await screen.findByText('Second directory')
    expect(screen.queryByText('Directory')).toBeNull()
    expect(api.to(`GET ${BASE}`).at(-1)?.path).toContain('after=token-1')
    expect(api.to(`GET ${BASE}`).at(-1)?.path).toContain('limit=20')
    await user.click(screen.getByRole('button', { name: 'Previous page' }))
    await screen.findByText('Directory')
    expect(screen.queryByText('Second directory')).toBeNull()
  })
  it('allows returning to the previous page after a pagination request fails', async () => {
    setup({
      [`GET ${BASE}`]: (call: { path: string }) =>
        call.path.includes('after=')
          ? json(503, {})
          : json(200, { tokens: [TOKEN], nextCursor: TOKEN.id }),
    })
    render(view())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Next page' }))
    await screen.findByText('Could not load provisioning tokens.')
    await user.click(screen.getByRole('button', { name: 'Previous page' }))
    await screen.findByText('Directory')
  })
  it('shows the response once, pins writes to the organization and clears on dismissal', async () => {
    const api = setup()
    render(view('owner'))
    const user = await create()
    expect(document.body.textContent?.includes(MARKER)).toBe(true)
    expect(api.to(`POST ${BASE}`)[0]?.headers.get('X-Expected-Organization-Id')).toBe(ORG)
    await user.click(screen.getByRole('button', { name: 'Dismiss token' }))
    expect(document.body.textContent?.includes(MARKER)).toBe(false)
    expect(screen.queryByRole('region', { name: 'New provisioning token' })).toBeNull()
  })
  it('clears the secret on navigation within settings', async () => {
    setup()
    render(view())
    const user = await create()
    await user.click(screen.getByRole('link', { name: 'Navigate' }))
    expect(document.body.textContent?.includes(MARKER)).toBe(false)
  })
  it('clears secrets when the organization changes', async () => {
    setup({
      'GET /api/v1/organizations/another-organization/provisioning-tokens': () =>
        json(200, { tokens: [] }),
    })
    const rendered = render(view())
    await create()
    rendered.rerender(view('owner', 'another-organization'))
    await screen.findByText('No provisioning tokens.')
    expect(document.body.textContent?.includes(MARKER)).toBe(false)
  })
  it('discards pending creation after losing the management role', async () => {
    const pending = later()
    setup({ [`POST ${BASE}`]: () => pending.response })
    const rendered = render(view())
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Provisioning token name'), 'Directory')
    await user.click(screen.getByRole('button', { name: 'Create provisioning token' }))
    rendered.rerender(view('member'))
    await pending.answer(json(201, { token: TOKEN, secret: MARKER }))
    rendered.rerender(view('owner'))
    await screen.findByRole('heading', { name: 'SCIM provisioning tokens' })
    expect(document.body.textContent?.includes(MARKER)).toBe(false)
  })
  it('confirms rotation overlap and revocation of both generations', async () => {
    let revoked = false
    const api = setup({
      [`GET ${BASE}`]: () =>
        json(200, { tokens: [{ ...TOKEN, revokedAt: revoked ? '2026-11-06T13:00:00Z' : null }] }),
      [`POST ${BASE}/token-1/rotate`]: () => json(200, { token: TOKEN, secret: MARKER }),
      [`DELETE ${BASE}/token-1`]: () => {
        revoked = true
        return json(200, { token: TOKEN })
      },
    })
    render(view())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Rotate token' }))
    expect(screen.getByText(/old token will remain valid for one hour/)).toBeDefined()
    expect(api.to(`POST ${BASE}/token-1/rotate`)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Confirm token change' }))
    await screen.findByRole('region', { name: 'New provisioning token' })
    expect(api.to(`POST ${BASE}/token-1/rotate`)[0]?.body).toEqual({ overlapSeconds: 3600 })
    await user.click(screen.getByRole('button', { name: 'Revoke token' }))
    expect(screen.getByText(/both the current token and its previous version/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: 'Confirm token change' }))
    await screen.findByText('Revoked')
    expect(document.body.textContent?.includes(MARKER)).toBe(false)
    expect(screen.queryByRole('button', { name: 'Rotate token' })).toBeNull()
  })
  it('uses neutral errors without rendering server details or claiming missing configuration', async () => {
    setup({ [`GET ${BASE}`]: () => json(403, { message: MARKER }) })
    render(view())
    await screen.findByText('Could not load provisioning tokens.')
    expect(document.body.textContent?.includes(MARKER)).toBe(false)
    expect(screen.queryByText('No provisioning tokens.')).toBeNull()
  })
  it('renders the admin surface in Chinese', async () => {
    setup()
    render(view('owner', ORG, 'zh-CN'))
    await screen.findByRole('button', { name: '创建预配令牌' })
    await screen.findByRole('button', { name: '轮换令牌' })
    expect(screen.getByText('SCIM 预配令牌')).toBeDefined()
    expect(screen.queryByText('Create provisioning token')).toBeNull()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('预配令牌名称'), 'Directory')
    await user.click(screen.getByRole('button', { name: '创建预配令牌' }))
    await user.click(await screen.findByRole('button', { name: '隐藏令牌' }))
    expect(document.body.textContent?.includes(MARKER)).toBe(false)
  })
})
