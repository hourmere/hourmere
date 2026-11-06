import { fireEvent, render, screen } from '@testing-library/react'
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
  fireEvent.change(screen.getByLabelText('Export starts at or after (UTC)'), {
    target: { value: from },
  })
  fireEvent.change(screen.getByLabelText('Export starts before (UTC)'), { target: { value: to } })
}
function download() {
  const link = screen.getByRole('link', { name: 'Download CSV' })
  return new URL(link.getAttribute('href') ?? '', 'http://localhost')
}
describe('CSV export action', () => {
  it('keeps the tab boundary, zone and pinned organisation in a native download', async () => {
    setup()
    await range()
    expect(Object.fromEntries(download().searchParams)).toMatchObject({
      from: '2030-03-01T00:00:00.000Z',
      to: '2030-04-01T00:00:00.000Z',
      timeZone: 'Europe/Berlin',
      expectedOrganizationId: ME.organization.id,
      bom: 'true',
      order: 'asc',
    })
    expect(download().searchParams.has('endAfter')).toBe(true)
    expect(download().searchParams.has('limit')).toBe(false)
    expect(screen.getByRole('link', { name: 'Download CSV' }).getAttribute('target')).toBe('_blank')
    fireEvent.click(screen.getByLabelText('Include UTF-8 BOM for Excel'))
    expect(download().searchParams.get('bom')).toBe('false')
  })
  it('retains descending order and end boundary on the personal past tab', async () => {
    setup(false, 'owner', '/app/bookings?tab=past')
    await range()
    expect(download().searchParams.get('order')).toBe('desc')
    expect(download().searchParams.has('endTo')).toBe(true)
    expect(download().searchParams.has('endAfter')).toBe(false)
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
    expect(Object.fromEntries(download().searchParams)).toMatchObject({
      from: '2030-03-02T12:00:00.000Z',
      to: '2030-03-20T12:00:00.000Z',
      status: 'cancelled',
      endTo: '2030-03-22T00:00:00.000Z',
      order: 'desc',
    })
    expect(download().searchParams.has('limit')).toBe(false)
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
    expect(screen.getByLabelText('导出开始时间不早于（UTC）')).toBeDefined()
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
