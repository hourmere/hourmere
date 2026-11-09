import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import * as session from '../../session.tsx'
import {
  fakeApi,
  json,
  ME,
  profile,
  renderApp,
  signedIn,
  signedInAs,
} from '../../test/fake-api.tsx'
import { BookingExport } from './BookingExport.tsx'

const TEAM = { ...ME, organization: { ...ME.organization, personal: false } }
function setup(team = false, role = 'owner', path = '/app/bookings') {
  fakeApi({
    ...(team ? signedInAs(TEAM) : signedIn),
    ...profile(),
    'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
    'GET /api/v1/team/bookings': () => json(200, { data: [], nextCursor: null }),
    'GET /api/auth/organization/get-active-member': () =>
      json(200, {
        id: 'membership',
        userId: ME.user.id,
        organizationId: ME.organization.id,
        role,
        createdAt: '2026-01-01T00:00:00Z',
      }),
  })
  renderApp(path)
}
async function range(from = '2030-03-01T00:00', to = '2030-04-01T00:00') {
  await screen.findByText('Export bookings as CSV')
  // The native details element is deliberately opened before inspecting its controls.
  fireEvent.click(screen.getByText('Export bookings as CSV'))
  screen.getByText('Export bookings as CSV').closest('details')?.setAttribute('open', '')
  fireEvent.change(screen.getByLabelText('Bookings starting at or after (UTC)'), {
    target: { value: from },
  })
  fireEvent.change(screen.getByLabelText('Bookings starting before (UTC)'), {
    target: { value: to },
  })
}
async function download() {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('header\r\n', { headers: { 'content-type': 'text/csv' } }))
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:test')
      static override revokeObjectURL = vi.fn()
    },
  )
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  const button = screen.getByRole('button', { name: 'Download CSV' })
  fireEvent.click(button)
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled()
  expect(screen.queryByRole('alert')).toBeNull()
  return new URL(String(fetcher.mock.calls.at(-1)?.[0]), 'http://localhost')
}
describe('CSV export action', () => {
  it('keeps the tab boundary, zone and pinned organisation in the download request', async () => {
    setup()
    await range()
    expect(Object.fromEntries((await download()).searchParams)).toMatchObject({
      from: '2030-03-01T00:00:00.000Z',
      to: '2030-04-01T00:00:00.000Z',
      timeZone: 'Europe/Berlin',
      expectedOrganizationId: ME.organization.id,
      bom: 'true',
      order: 'asc',
    })
    expect((await download()).searchParams.has('endAfter')).toBe(true)
    expect((await download()).searchParams.has('limit')).toBe(false)
    expect(screen.getByLabelText('Include UTF-8 BOM for Excel').closest('label')?.className).toBe(
      'checkbox',
    )
    fireEvent.click(screen.getByLabelText('Include UTF-8 BOM for Excel'))
    expect((await download()).searchParams.get('bom')).toBe('false')
  })
  it.each([400, 409, 429])(
    'shows an in-app error and saves no file for HTTP %s',
    async (status) => {
      setup()
      await range()
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({ error: 'export_busy' }, { status }),
      )
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
      expect((await screen.findByRole('alert')).textContent).toContain('Could not download CSV')
      expect(click).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: 'Download CSV' }).hasAttribute('disabled')).toBe(
        false,
      )
    },
  )
  it('reports a truncated download without saving a partial CSV', async () => {
    setup()
    await range()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('connection lost'))
          },
        }),
        { headers: { 'content-type': 'text/csv' } },
      ),
    )
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not download CSV')
    expect(click).not.toHaveBeenCalled()
  })
  it('retains descending order and end boundary on the personal past tab', async () => {
    setup(false, 'owner', '/app/bookings?tab=past')
    await range()
    expect((await download()).searchParams.get('order')).toBe('desc')
    expect((await download()).searchParams.has('endTo')).toBe(true)
    expect((await download()).searchParams.has('endAfter')).toBe(false)
  })
  it.each([
    ['', '2030-04-01T00:00'],
    ['2030-04-01T00:00', '2030-03-01T00:00'],
    ['2030-01-01T00:00', '2031-01-03T00:00'],
  ])('prevents incomplete, reversed or excessive ranges (%s)', async (from, to) => {
    setup()
    await range(from, to)
    expect(screen.queryByRole('link', { name: 'Download CSV' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Download CSV' }).hasAttribute('disabled')).toBe(true)
  })
  it.each(['owner', 'admin'])('retains exact team filters for %s', async (role) => {
    setup(
      true,
      role,
      '/app/team/bookings?tab=all&from=2030-03-02T12:00:00Z&to=2030-03-20T12:00:00Z&status=cancelled&endTo=2030-03-22T00:00:00Z&order=desc',
    )
    await range()
    expect(Object.fromEntries((await download()).searchParams)).toMatchObject({
      from: '2030-03-02T12:00:00.000Z',
      to: '2030-03-20T12:00:00.000Z',
      status: 'cancelled',
      endTo: '2030-03-22T00:00:00.000Z',
      order: 'desc',
    })
    expect((await download()).searchParams.has('limit')).toBe(false)
  })
  it('does not offer team export to members', async () => {
    setup(true, 'member', '/app/team/bookings')
    await screen.findByText('Team bookings are not available in this space.')
    expect(screen.queryByText('Export bookings as CSV')).toBeNull()
  })
  it('does not offer export of team data from the personal host list', async () => {
    setup(true)
    await screen.findByText('No upcoming bookings.')
    expect(screen.queryByText('Export bookings as CSV')).toBeNull()
  })
  it('localizes the export controls and privacy notice in Chinese', async () => {
    chooseLanguage('zh-CN')
    setup()
    await screen.findByText('将预约导出为 CSV')
    expect(screen.getByText('此文件包含个人数据。请妥善保存并谨慎分享。')).toBeDefined()
    expect(screen.getByLabelText('预约开始时间不早于（UTC）')).toBeDefined()
    expect(screen.getByLabelText('包含 UTF-8 BOM，便于 Excel 读取')).toBeDefined()
  })
})

it.each([true, false])('blocks a stale or disabled download (disabled=%s)', (disabled) => {
  vi.spyOn(session, 'useMe').mockReturnValue(ME)
  render(
    <BookingExport
      filters={{ from: '2030-03-01T00:00:00Z', to: '2030-04-01T00:00:00Z' }}
      timeZone="UTC"
      expectedOrganizationId={disabled ? ME.organization.id : 'another-organization'}
      disabled={disabled}
    />,
  )
  screen.getByText('Export bookings as CSV').closest('details')?.setAttribute('open', '')
  expect(screen.queryByRole('link', { name: 'Download CSV' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Download CSV' }).hasAttribute('disabled')).toBe(true)
})

it.each(['en', 'zh-CN'] as const)('explains the account export limit in %s', async (language) => {
  setup()
  await range()
  chooseLanguage(language)
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ error: 'export_user_in_progress' }, { status: 409 }),
  )
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  fireEvent.click(
    await screen.findByRole('button', { name: language === 'en' ? 'Download CSV' : '下载 CSV' }),
  )
  expect((await screen.findByRole('alert')).textContent).toBe(
    language === 'en'
      ? 'An export is already running for your account. Wait for it to finish and try again.'
      : '你的账户已有导出正在进行。请等待导出完成后重试。',
  )
  expect(click).not.toHaveBeenCalled()
})
