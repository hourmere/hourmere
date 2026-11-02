import { readFileSync } from 'node:fs'
import { registeredLocales } from '@hourmere/core/language'
import { describe, expect, it } from 'vitest'
import './admin.ts'
import { admin as english } from './catalogues/en/admin.ts'
import { admin as chinese } from './catalogues/zh-CN/admin.ts'
import type { Catalog } from './catalogues.ts'
import { commonCatalogues } from './common.ts'
import { type MessageKey, translate } from './translate.ts'

const reviewed = {
  'Choose 1–10 available times for the saved event type. Unsaved changes are not included.':
    '为已保存的活动类型选择 1 至 10 个可约时间。未保存的更改不会包含在内。',
  'Availability is checked again when you copy. Times are not reserved and may become unavailable. Invitees must confirm their bookings on the booking page.':
    '复制时会重新检查所选时间是否可约。这些时间不会被预留，受邀人打开链接时可能已不可约。受邀人仍需在预约页面上确认预约。',
  'This event type is unlisted. Anyone with these links can open the booking page and book an available time.':
    '此活动类型未公开列出。任何获得这些链接的人都可以打开预约页面，并选择可约时间进行预约。',
  'The language and time zone selected here apply only to the email snippet. Booking pages use each invitee’s preferences.':
    '此处选择的语言和时区仅用于邮件片段。预约页面会使用每位受邀人的偏好设置。',
  'Availability date (UTC)': '可约日期（UTC）',
  'Available times': '可选时间',
  'Loading available times…': '正在加载可约时间……',
  'Check availability again': '重新检查可约时间',
  'Selected times: {0} (maximum 10)': '已选择{0}个备选时间，最多可选 10 个',
  'Selected times': '已选时间',
  'The email preview could not be created. Please choose fewer times and try again.':
    '无法创建邮件预览。请少选几个时间后重试。',
  'Checking selected times…': '正在检查已选时间……',
  'This meeting length is no longer offered. Reload the saved event type before trying again.':
    '此会议时长已不可选。请重新加载已保存的活动类型后重试。',
  'Some selected times are no longer offered. Nothing was copied. Remove those times manually before trying again.':
    '部分已选时间已不可约，未复制任何内容。请手动移除这些时间后重试。',
  'Clipboard access was unavailable. Select and copy the complete plain-text preview manually.':
    '无法访问剪贴板。请手动选中并复制完整的纯文本预览。',
  '{0} min': '{0}分钟',
  'Checking that you can preview these times…': '正在确认你是否可以预览这些时间……',
  'Availability date ({zone})': '可约日期（{zone}）',
  'Email preview ready.': '邮件预览已就绪。',
  'This time could not be displayed. Please try another display time zone.':
    '无法显示此时间。请尝试其他显示时区。',
  'The saved event title is invalid. Reload the saved event type and try again.':
    '已保存的活动标题无效。请重新加载已保存的活动类型后重试。',
  'The saved booking address is invalid. Reload the saved event type and try again.':
    '已保存的预约地址无效。请重新加载已保存的活动类型后重试。',
  'The email preview could not be created. Reload the saved event type and try again.':
    '无法创建邮件预览。请重新加载已保存的活动类型后重试。',
} satisfies Partial<Record<MessageKey, string>>

const retired = [
  'Choose 1–10 alternatives from the saved event type. Unsaved changes are not included.',
  'Availability is checked again when you copy. Times are not reserved, and each booking requires confirmation.',
  'This event type is unlisted. Anyone receiving or forwarding these links may open and book it.',
  'Language and display time zone change labels only. Booking pages use each invitee’s preferences.',
  'Available alternatives',
  'Retry availability',
  '{0} of 10 alternatives selected',
  'Selected alternatives',
  'This meeting length is no longer offered. Reload the saved event before trying again.',
  'Some selected times are no longer offered. Nothing was copied. Remove those times explicitly before trying again.',
  '{0} minutes',
  'Checking preview access…',
]

function assertReviewed(catalogue: Catalog, locale: 'en' | 'zh-CN') {
  for (const [key, chineseText] of Object.entries(reviewed))
    expect(catalogue[key], `${locale}: ${key}`).toBe(locale === 'en' ? key : chineseText)
  for (const key of retired) expect(Object.hasOwn(catalogue, key), `${locale}: ${key}`).toBe(false)
}

function catalogueFromSource(source: string): Catalog {
  return new Function(
    `${source.replace('export const admin', 'const admin').replace(/ as const\s*$/, '')}; return admin;`,
  )()
}

describe('reviewed slot picker catalogue copy', () => {
  it('preserves every corrected source key and exact Chinese proofreading', () => {
    assertReviewed(english, 'en')
    assertReviewed(chinese, 'zh-CN')
  })

  it('uses localized common messages and English fallback in public-only locales', () => {
    for (const { code } of registeredLocales) {
      if (code === 'zh-CN') continue
      for (const key of Object.keys(reviewed) as (keyof typeof reviewed)[])
        expect(translate(code, key), `${code}: ${key}`).toBe(
          commonCatalogues[`./catalogues/${code}/common.ts`]?.[key] ?? key,
        )
    }
  })

  it('preserves count and display-zone placeholders through rendered translation', () => {
    expect(translate('en', 'Selected times: {0} (maximum 10)', { '0': 3 })).toBe(
      'Selected times: 3 (maximum 10)',
    )
    expect(translate('zh-CN', 'Selected times: {0} (maximum 10)', { '0': 3 })).toBe(
      '已选择 3 个备选时间，最多可选 10 个',
    )
    expect(translate('zh-CN', 'Availability date ({zone})', { zone: 'Pacific/Kiritimati' })).toBe(
      '可约日期（Pacific/Kiritimati）',
    )
    expect(translate('en', '{0} min', { '0': 1 })).toBe('1 min')
    expect(translate('en', '{0} min', { '0': 30 })).toBe('30 min')
  })

  it.each(['en', 'zh-CN'] as const)(
    'detects a changed copy in each reviewed %s production-source entry',
    (locale) => {
      const source = readFileSync(`apps/web/src/i18n/catalogues/${locale}/admin.ts`, 'utf8')
      assertReviewed(catalogueFromSource(source), locale)
      for (const [key, chineseText] of Object.entries(reviewed)) {
        const value = locale === 'en' ? key : chineseText
        const anchor = `'${key}':`
        const start = source.indexOf(anchor)
        expect(start, `${locale}: ${key}`).toBeGreaterThanOrEqual(0)
        const valueStart = source.indexOf(`'${value}'`, start + anchor.length)
        expect(valueStart, `${locale}: ${key}`).toBeGreaterThanOrEqual(start + anchor.length)
        const mutation = `${source.slice(0, valueStart)}'Changed copy'${source.slice(valueStart + value.length + 2)}`
        expect(() => assertReviewed(catalogueFromSource(mutation), locale)).toThrowError(
          expect.objectContaining({ name: 'AssertionError' }),
        )
      }
      assertReviewed(catalogueFromSource(source), locale)
    },
  )
})
