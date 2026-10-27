import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../api/client.ts'
import '../i18n/admin.ts'
import { admin as english } from '../i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../i18n/catalogues/zh-CN/admin.ts'
import { type MessageKey, translate, translateMessage } from '../i18n/translate.ts'
import { fakeApi, json, PROFILE, profile, renderApp, signedIn } from '../test/fake-api.tsx'

const calendarMessages = {
  'Review synchronization permissions': '查看同步权限说明',
  'Unavailable for new bookings': '暂不能写入新预约',
  'Selected for new bookings — unavailable': '已选为新预约写入目标，暂不可用',
  'Calendar connection options': '日历连接选项',
  'Reconnect required': '需要重新连接',
  'Busy-time sync': '忙碌时段同步',
  'Conflict checks': '冲突检查',
  'New bookings': '新预约',
  'Not available': '暂不可用',
  '{0} selected': '已选择{0}个日历',
  'Not available — calendar list only.': '暂不支持，仅可查看日历列表。',
  'Not enabled — calendar list only.': '尚未启用，仅可查看日历列表。',
  'Paused until you reconnect this account.': '已暂停，请重新连接此账号。',
  'Unavailable on this instance.': '此实例暂不可用。',
  'Synchronization needs attention. Review the failed calendars below.':
    '同步需要处理，请查看下方同步失败的日历。',
  'Waiting for the first synchronization on selected calendars.': '已选日历正在等待首次同步。',
  'No calendars selected for conflict checks.': '尚未选择用于冲突检查的日历。',
  'Latest synchronization of selected conflict calendars succeeded.':
    '所选冲突检查日历的最近一次同步已成功。',
  'Not written to this account': '不写入此账号',
  'Selected for conflict checks': '已选为冲突检查日历',
  'Not used for conflict checks': '不用于冲突检查',
  'Selected for new bookings': '已选为新预约写入目标',
  'Not a booking destination': '不写入新预约',
  'The calendar provider could not be reached. Try refreshing the calendar list again.':
    '无法连接日历服务，请重试刷新日历列表。',
  'Connecting a calendar is optional. Basic booking works without one. Set up an event type to start taking bookings.':
    '日历连接是可选的。不连接日历也能使用基础预约。设置活动类型，即可开始接受预约。',
  'Set up event types': '设置活动类型',
  'Busy times synchronized for this calendar.': '此日历的忙碌时段已同步。',
  'Disconnect deletes stored credentials and local calendar data, but leaves existing event copies in Google Calendar and does not revoke your Google grant. You can revoke access in your Google Account:':
    '“断开连接”可删除已存储的凭证和本地日历数据，但会保留 Google 日历中的现有事件副本，也不会撤销 Google 授权。你可以在 Google 账号中撤销授权：',
} as const

describe('calendar catalogue preservation', () => {
  it.each(Object.entries(calendarMessages))(
    'preserves the source and Chinese copy for %s',
    (key, value) => {
      expect((english as Record<string, string>)[key]).toBe(key)
      expect((chinese as Record<string, string>)[key]).toBe(value)
      expect(translate('en', key as MessageKey)).toBe(key)
      expect(translate('zh-CN', key as MessageKey)).toBe(value)
      expect(translateMessage('zh-CN', key)).toBe(value)
    },
  )

  it('interpolates the translated selected-calendar count', () => {
    expect(translate('zh-CN', '{0} selected', { '0': 2 })).toBe('已选择 2 个日历')
  })
})

describe('Chinese calendar account summaries', () => {
  it.each([
    ['Google list access', 'google', false, true, '尚未启用，仅可查看日历列表。'],
    ['Microsoft list access', 'microsoft', false, true, '暂不支持，仅可查看日历列表。'],
    ['disabled Google provider', 'google', true, false, '此实例暂不可用。'],
    ['no conflict calendars selected', 'google', true, true, '尚未选择用于冲突检查的日历。'],
  ] as const)(
    'renders the %s state in Chinese',
    async (_state, provider, syncAuthorized, googleEnabled, summary) => {
      const connection: Schemas['CalendarConnection'] = {
        id: 'a0000000-0000-7000-8000-000000000001',
        provider,
        accountEmail: 'calendar@example.test',
        status: 'active',
        syncAuthorized,
        createdAt: '2026-10-16T10:00:00Z',
        updatedAt: '2026-10-16T10:00:00Z',
        calendars: [],
      }
      fakeApi({
        ...signedIn,
        ...profile({ ...PROFILE, locale: 'zh-CN' }),
        'GET /api/v1/calendar-connections': () =>
          json(200, {
            data: [connection],
            googleEnabled,
            microsoftEnabled: true,
            destinationCalendarId: null,
          }),
      })
      renderApp('/app/calendars')
      const account = (
        await screen.findByRole('heading', { name: 'calendar@example.test' })
      ).closest('article') as HTMLElement
      const details = account.querySelector('.calendar-account-summary') as HTMLElement
      expect(
        within(details).getByText('忙碌时段同步', { selector: 'dt' }).nextElementSibling
          ?.textContent,
      ).toBe(summary)
      expect(
        within(details).getByText('冲突检查', { selector: 'dt' }).nextElementSibling?.textContent,
      ).toBe(syncAuthorized ? '已选择 0 个日历' : '暂不可用')
      expect(
        within(details).getByText('新预约', { selector: 'dt' }).nextElementSibling?.textContent,
      ).toBe('不写入此账号')
      expect(within(account).getByText('已连接')).toBeDefined()
      expect(within(account).getByText('此账号中未找到日历。')).toBeDefined()
    },
  )
})
