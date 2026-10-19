import { expect, it } from 'vitest'
import { admin } from '../i18n/admin.ts'
import { registerCatalog, translateMessage } from '../i18n/translate.ts'
import { errorMessage, requestError } from './errors.ts'

registerCatalog(admin)
const cases = [
  ['invalid_request', 'Check the form and try again.', '请检查表单后重试。'],
  [
    'invalid_calendar_settings',
    'Check your calendar settings and try again.',
    '请检查日历设置后重试。',
  ],
  [
    'invalid_calendar_access',
    'Choose calendar-list access or calendar synchronization.',
    '请选择日历列表访问或日历同步权限。',
  ],
  ['profile_not_found', 'Create your profile in Settings first.', '请先在“设置”中创建个人资料。'],
  [
    'session_required',
    'Sign in again, then start a new calendar connection.',
    '请重新登录，然后开始新的日历连接。',
  ],
  [
    'invalid_oauth_state',
    'This connection attempt expired or was already used. Start again.',
    '此连接尝试已过期或已使用。请重新开始。',
  ],
  [
    'calendar_connection_not_found',
    'This calendar connection no longer exists.',
    '此日历连接已不存在。',
  ],
  [
    'calendar_not_found',
    'This calendar is no longer available. Refresh the calendar list.',
    '此日历已不可用。请刷新日历列表。',
  ],
  [
    'calendar_selection_limit',
    'Select at most 20 conflict calendars.',
    '最多可选择 20 个用于检查冲突的日历。',
  ],
  [
    'calendar_events_unreadable',
    'This calendar does not allow event synchronization.',
    '此日历不允许同步事件。',
  ],
  [
    'calendar_sync_disabled',
    'Select this calendar for conflict checks before synchronizing it.',
    '请先选择此日历用于检查冲突，再进行同步。',
  ],
  [
    'calendar_not_writable',
    'Choose an owned Google calendar and enable synchronization first.',
    '请先选择你拥有的 Google 日历并启用同步。',
  ],
  [
    'google_calendar_disabled',
    'Google Calendar is not configured on this Hourmere instance. Contact its administrator to enable it.',
    '此 Hourmere 实例尚未配置 Google 日历。请联系管理员启用。',
  ],
  [
    'google_calendar_provider_unavailable',
    'Google Calendar could not be reached. Try again shortly.',
    '无法连接 Google 日历。请稍后重试。',
  ],
  [
    'microsoft_calendar_disabled',
    'Microsoft Calendar is not configured on this Hourmere instance. Contact its administrator to enable it.',
    '此 Hourmere 实例尚未配置 Microsoft 日历。请联系管理员启用。',
  ],
  [
    'microsoft_calendar_provider_unavailable',
    'Microsoft Calendar could not be reached. Try again shortly.',
    '无法连接 Microsoft 日历。请稍后重试。',
  ],
  [
    'microsoft_calendar_needs_reauth',
    'Reconnect Microsoft Calendar to restore access.',
    '请重新连接 Microsoft 日历以恢复访问。',
  ],
  [
    'microsoft_calendar_permissions_missing',
    'Reconnect Microsoft Calendar and allow the requested permissions.',
    '请重新连接 Microsoft 日历并允许请求的权限。',
  ],
  [
    'zoom_operation_busy',
    'Zoom account operations are busy. Try again shortly.',
    'Zoom 账号操作繁忙。请稍后重试。',
  ],
  [
    'zoom_refresh_in_progress',
    'Zoom account operations are busy. Try again shortly.',
    'Zoom 账号操作繁忙。请稍后重试。',
  ],
  [
    'zoom_needs_reauth',
    'Reconnect this Zoom account before refreshing it.',
    '请先重新连接此 Zoom 账号，再刷新。',
  ],
] as const

it.each(cases)(
  'localizes integration error %s by its code in every supported locale',
  (code, english, chinese) => {
    // Deliberately unrelated prose catches English-message matching and literal fallbacks.
    for (const prose of ['Unrelated server detail.', 'Changed server detail.']) {
      const error = errorMessage(requestError(409, { error: code, message: prose }))
      expect(translateMessage('en', error)).toBe(english)
      expect(translateMessage('zh-CN', error)).toBe(chinese)
    }
  },
)

it('recognizes the neutral Zoom busy alias while retaining the original error code', () => {
  const error = requestError(409, {
    error: 'zoom_refresh_in_progress',
    errorAlias: 'zoom_operation_busy',
    message: 'Unrelated server detail.',
  })
  expect(error.code).toBe('zoom_refresh_in_progress')
  expect(error.codeAlias).toBe('zoom_operation_busy')
  expect(translateMessage('en', errorMessage(error))).toBe(
    'Zoom account operations are busy. Try again shortly.',
  )
  expect(translateMessage('zh-CN', errorMessage(error))).toBe('Zoom 账号操作繁忙。请稍后重试。')
})

it.each([
  { error: 'zoom_refresh_in_progress', errorAlias: 'unknown_alias' },
  { error: 'zoom_refresh_in_progress', errorAlias: { error: 'zoom_operation_busy' } },
  { error: 'unknown_code', errorAlias: 'zoom_operation_busy' },
])('ignores unsupported error alias combinations %j', (body) => {
  const error = requestError(409, { ...body, message: 'Unrelated server detail.' })
  expect(error.code).toBe(body.error)
  expect(error.codeAlias).toBeUndefined()
  expect(translateMessage('zh-CN', errorMessage(error))).toBe(
    body.error === 'zoom_refresh_in_progress'
      ? 'Zoom 账号操作繁忙。请稍后重试。'
      : 'Unrelated server detail.',
  )
})
