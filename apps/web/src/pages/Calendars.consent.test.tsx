import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fakeApi, json, PROFILE, profile, renderApp, signedIn } from '../test/fake-api.tsx'

describe('Google Calendar pre-consent consequences', () => {
  it.each([
    {
      locale: 'en',
      heading: 'Connect Google Calendar',
      permissions: /Google will ask for your email/,
      singleCopy: 'create one private copy of each new booking',
      destination: 'Changing this destination affects new bookings',
      existingCopies:
        'existing booking copies continue to be updated or cancelled on their original calendar',
      disconnect: /Disconnect below/,
      retainedEvents: 'leaves existing event copies in Google Calendar',
      retainedGrant: 'does not revoke your Google grant',
      revoke: 'Google Account connections',
      punctuation: '.',
    },
    {
      locale: 'zh-CN',
      heading: '连接 Google 日历',
      permissions: /Google 将请求你的邮箱/,
      singleCopy: '为每个新预约创建一份私有副本',
      destination: '更改写入目标只影响新预约',
      existingCopies: '现有预约的副本仍会在原日历中更新或取消',
      disconnect: /使用下方的“断开连接”/,
      retainedEvents: '保留 Google 日历中的现有事件副本',
      retainedGrant: '不会撤销 Google 授权',
      revoke: 'Google 账号连接',
      punctuation: '。',
    },
  ])('explains destination changes and local disconnect in $locale', async (copy) => {
    fakeApi({
      ...signedIn,
      ...profile({ ...PROFILE, locale: copy.locale }),
      'GET /api/v1/calendar-connections': () =>
        json(200, {
          data: [],
          googleEnabled: true,
          microsoftEnabled: false,
          destinationCalendarId: null,
        }),
    })
    renderApp('/app/calendars')
    const section = await screen.findByRole('region', { name: copy.heading })
    const permissions = within(section).getByText(copy.permissions)
    for (const detail of [copy.singleCopy, copy.destination, copy.existingCopies])
      expect(permissions.textContent).toContain(detail)

    const disconnect = within(section).getByText(copy.disconnect)
    expect(disconnect.textContent).toContain(copy.retainedEvents)
    expect(disconnect.textContent).toContain(copy.retainedGrant)
    const revoke = within(disconnect).getByRole('link', { name: copy.revoke })
    expect(revoke.getAttribute('href')).toBe('https://myaccount.google.com/connections')
    expect(disconnect.textContent?.trim().endsWith(copy.revoke + copy.punctuation)).toBe(true)
    if (copy.locale === 'zh-CN') {
      expect(permissions.textContent).not.toMatch(/[.,:;!?]/)
      expect(disconnect.textContent).not.toMatch(/[.,:;!?]/)
    }
    const connect = within(section).getByRole('button', { name: copy.heading })
    expect(
      document
        .getElementById(connect.getAttribute('aria-describedby') ?? '')
        ?.contains(permissions),
    ).toBe(true)
  })
})
