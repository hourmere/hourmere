import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import { fakeApi, json, profile, renderApp, signedIn } from '../test/fake-api.tsx'
import {
  BOOKING_ID,
  booking,
  EVENT_TYPE_ID,
  eventType,
  OTHER_SCHEDULE_ID,
  SCHEDULE_ID,
  schedule,
} from '../test/fixtures.ts'

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_', ' ')

function pageApi({ schedules = [schedule()], hasProfile = true } = {}) {
  fakeApi({
    ...signedIn,
    ...profile(hasProfile ? undefined : null),
    'GET /api/v1/event-types': () => json(200, { data: [] }),
    'GET /api/v1/schedules': () => json(200, { data: schedules }),
    'GET /api/v1/bookings': () => json(200, { data: [], nextCursor: null }),
    [`GET /api/v1/bookings/${BOOKING_ID}`]: () => json(200, booking()),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, eventType()),
    [`GET /api/v1/schedules/${SCHEDULE_ID}`]: () => json(200, schedule()),
    [`GET /api/v1/schedules/${SCHEDULE_ID}/overrides`]: () => json(200, { data: [] }),
  })
}

describe.each(['en', 'zh-CN'] as const)('linked admin sentences in %s', (language) => {
  it('keeps the browser-zone list note and its linked ending in one sentence template', async () => {
    chooseLanguage(language)
    pageApi({ hasProfile: false })
    renderApp('/app/bookings')
    const link = await screen.findByRole('link', {
      name: language === 'en' ? 'Set your time zone' : '设置时区',
    })
    expect(link.closest('p')?.textContent).toBe(
      language === 'en'
        ? `Times are in ${browserZone()}, this browser’s time zone. Set your time zone.`
        : `时间使用以下时区：${browserZone()}（此浏览器的时区）。设置时区。`,
    )
    expect(link.getAttribute('href')).toBe('/app/settings')
  })

  it('keeps the browser-zone detail hint punctuation beside its link', async () => {
    chooseLanguage(language)
    pageApi({ hasProfile: false })
    renderApp(`/app/bookings/${BOOKING_ID}`)
    const link = await screen.findByRole('link', {
      name: language === 'en' ? 'Set your time zone' : '设置时区',
    })
    expect(link.closest('p')?.textContent).toBe(
      language === 'en'
        ? 'Shown in this browser’s time zone. Set your time zone.'
        : '以此浏览器的时区显示。设置时区。',
    )
    expect(link.getAttribute('href')).toBe('/app/settings')
  })

  it('joins the past ordering note directly to Chinese time-zone guidance', async () => {
    chooseLanguage(language)
    pageApi({ hasProfile: false })
    renderApp('/app/bookings?tab=past')
    const link = await screen.findByRole('link', {
      name: language === 'en' ? 'Set your time zone' : '设置时区',
    })
    expect(link.closest('p')?.textContent).toBe(
      language === 'en'
        ? `Newest first. Times are in ${browserZone()}, this browser’s time zone. Set your time zone.`
        : `最新的排在前面。时间使用以下时区：${browserZone()}（此浏览器的时区）。设置时区。`,
    )
  })

  it('keeps editor helper sentences beside their URL, link and question limit', async () => {
    chooseLanguage(language)
    pageApi()
    renderApp('/app/event-types/new')
    const schedules = await screen.findByRole('link', {
      name: language === 'en' ? 'Manage schedules' : '管理日程',
    })
    expect(schedules.parentElement?.textContent).toBe(
      language === 'en'
        ? 'The weekly hours times are offered in. Manage schedules'
        : '用于提供每周时间段的时区。管理日程',
    )
    const hint = document.getElementById('slug-hint')
    expect(hint?.textContent).toMatch(
      language === 'en'
        ? /^Lowercase letters, digits and hyphens\. \/ada\//
        : /^使用小写字母、数字和连字符。\/ada\//,
    )
    expect(document.querySelector('.questions > .hint')?.textContent).toBe(
      language === 'en'
        ? 'Invitees always give their name and email. Add questions for anything else you need to know, up to 20.'
        : '受邀人始终需要提供姓名和邮箱。可添加其他问题，最多 20。',
    )
  })

  it('keeps the missing-schedule hint punctuation beside its link', async () => {
    chooseLanguage(language)
    pageApi({ schedules: [] })
    renderApp('/app/event-types/new')
    const link = await screen.findByRole('link', {
      name: language === 'en' ? 'Set your availability' : '设置可预约时间',
    })
    expect(link.parentElement?.textContent).toBe(
      language === 'en'
        ? 'You have no schedule yet, so no times are offered. Set your availability.'
        : '你尚无日程，因此没有可预约时间。设置可预约时间。',
    )
    expect(link.getAttribute('href')).toBe('/app/availability/new')
  })

  it('keeps the default-schedule deletion sentence around its link', async () => {
    chooseLanguage(language)
    pageApi({ schedules: [schedule(), schedule({ id: OTHER_SCHEDULE_ID, isDefault: false })] })
    renderApp(`/app/availability/${SCHEDULE_ID}`)
    const link = await screen.findByRole('link', {
      name: language === 'en' ? 'availability page' : '可预约时间页面',
    })
    expect(link.closest('p')?.textContent).toBe(
      language === 'en'
        ? 'This is your default schedule. To delete it, first make another schedule the default on the availability page.'
        : '这是你的默认日程。如需删除，请先在以下页面将其他日程设为默认：可预约时间页面。',
    )
    expect(link.getAttribute('href')).toBe('/app/availability')
  })

  it('keeps setup hint clauses and their links together without extra Chinese spaces', async () => {
    chooseLanguage(language)
    pageApi({ schedules: [], hasProfile: false })
    renderApp('/app/event-types')
    const handle = await screen.findByRole('link', {
      name: language === 'en' ? 'Choose your handle' : '选择用户名',
    })
    const hours = screen.getByRole('link', {
      name: language === 'en' ? 'Set your weekly hours' : '设置每周时间段',
    })
    expect(handle.closest('li')?.textContent).toBe(
      language === 'en' ? 'Choose your handle to get booking links.' : '选择用户名以获取预约链接。',
    )
    expect(hours.closest('li')?.textContent).toBe(
      language === 'en'
        ? 'Set your weekly hours, so there are times to book.'
        : '设置每周时间段，这样才会有可预约时间。',
    )
  })
})
