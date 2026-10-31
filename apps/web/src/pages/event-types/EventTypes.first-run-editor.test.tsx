import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { EventType, Schedule } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, profile, type Routes, renderApp, signedIn } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

const CREATE = 'POST /api/v1/event-types'

function server(schedules: Schedule[] = [schedule()], overrides: Routes = {}) {
  let saved = eventType()
  return fakeApi({
    ...signedIn,
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: schedules }),
    'GET /api/v1/event-types': () => json(200, { data: [saved] }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    [CREATE]: ({ body }) => {
      saved = eventType(body as Partial<EventType>)
      return json(201, saved)
    },
    ...overrides,
  })
}

const copy = {
  en: {
    title: 'Title',
    link: 'Booking link',
    newHeading: 'New event type',
    create: 'Create event type',
    checks: 'Saved event checks',
    linkHint: 'Lowercase letters, digits and hyphens. You can change this link.',
    questions: 'Invitees always give their name and email. You can add up to 20 extra questions.',
    share: 'View and share',
    noSchedule: 'You have no working hours yet. Use the setup guide to add a default schedule.',
    guide: 'Set working hours with the setup guide',
    hours: 'Use Monday–Friday, 09:00–17:00',
    handle: 'Set a handle in Settings before sharing this event type.',
  },
  'zh-CN': {
    title: '标题',
    link: '预约链接',
    newHeading: '新活动类型',
    create: '创建活动类型',
    checks: '保存后的配置检查',
    linkHint: '使用小写字母、数字和连字符。你可以修改此链接。',
    questions: '受邀人始终需要提供姓名和邮箱。你还可以添加最多 20 个问题。',
    share: '查看与分享',
    noSchedule: '你尚未设置工作时间。请通过设置引导添加默认日程。',
    guide: '通过设置引导添加工作时间',
    hours: '使用周一至周五 09:00–17:00',
    handle: '分享此活动类型前，请先在设置中填写你的用户名。',
  },
}

describe.each(['en', 'zh-CN'] as const)('first-run editor in %s', (language) => {
  it.each([
    ['Intro call', 'intro-call'],
    ['初次沟通', '30-min'],
  ])('creates a link for %s without a separate naming step', async (title, slug) => {
    chooseLanguage(language)
    const user = userEvent.setup()
    const api = server()
    renderApp('/app/event-types/new')
    const words = copy[language]
    await screen.findByRole('heading', { name: words.newHeading, level: 1 })
    expect(screen.queryByRole('region', { name: words.checks })).toBeNull()
    expect(screen.getByText(words.questions)).toBeDefined()
    await user.type(screen.getByLabelText(words.title, { exact: true }), title)
    const input = screen.getByLabelText<HTMLInputElement>(words.link, { exact: true })
    expect(input.value).toBe(slug)
    expect(screen.getByText(words.linkHint)).toBeDefined()
    await user.click(screen.getByRole('button', { name: words.create }))
    await screen.findByRole('region', { name: words.checks })
    expect(api.to(CREATE)).toHaveLength(1)
    expect(api.to(CREATE)[0]?.body).toMatchObject({ title, slug })
    expect(screen.getByLabelText<HTMLInputElement>(words.link, { exact: true }).value).toBe(slug)
  })

  it('directs an empty schedule to the one-step setup guide', async () => {
    chooseLanguage(language)
    server([])
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const words = copy[language]
    const share = await screen.findByRole('region', { name: words.share })
    expect(within(share).getByText(words.noSchedule)).toBeDefined()
    const link = within(share).getByRole('link', { name: words.guide })
    expect(link.getAttribute('href')).toBe('/app/event-types#personal-setup-heading')
    expect(share.textContent).not.toMatch(/Other schedules|其他日程/)
    await userEvent.click(link)
    expect(await screen.findByRole('button', { name: words.hours })).toBeDefined()
    expect(document.getElementById('personal-setup-heading')).not.toBeNull()
  })

  it('uses the Settings handle term when identity is missing', async () => {
    chooseLanguage(language)
    server([schedule()], profile(null))
    renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
    const share = await screen.findByRole('region', { name: copy[language].share })
    expect(within(share).getByText(copy[language].handle)).toBeDefined()
  })
})

describe('suggested booking links', () => {
  it('follows duration changes for a non-Latin title until the link is edited', async () => {
    const user = userEvent.setup()
    server()
    renderApp('/app/event-types/new')
    await screen.findByRole('heading', { name: 'New event type', level: 1 })
    await user.type(screen.getByLabelText('Title', { exact: true }), '初次沟通')
    const duration = screen.getByLabelText('Duration (minutes)')
    const link = screen.getByLabelText<HTMLInputElement>('Booking link')
    await user.clear(duration)
    await user.type(duration, '45')
    expect(link.value).toBe('45-min')
    await user.clear(link)
    await user.type(link, 'my-call')
    await user.clear(duration)
    await user.type(duration, '60')
    expect(link.value).toBe('my-call')
    await user.type(screen.getByLabelText('Title', { exact: true }), '预约')
    expect(link.value).toBe('my-call')
  })

  it('retries a collision for an untouched duration link before completing the first save', async () => {
    const user = userEvent.setup()
    let attempts = 0
    let saved = eventType()
    const api = server([], {
      [CREATE]: ({ body }) => {
        if (++attempts === 1) return json(409, { error: 'slug_taken' })
        saved = eventType(body as Partial<EventType>)
        return json(201, saved)
      },
      [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, saved),
    })
    renderApp('/app/event-types/new')
    await screen.findByRole('heading', { name: 'New event type', level: 1 })
    await user.type(screen.getByLabelText('Title', { exact: true }), '初次沟通')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await screen.findByRole('region', { name: 'Saved event checks' })
    expect(screen.getByLabelText<HTMLInputElement>('Booking link').value).toMatch(
      /^30-min-[a-f0-9]{8}$/,
    )
    expect(api.to(CREATE)).toHaveLength(2)
    expect(api.to(CREATE)[0]?.body).toMatchObject({ slug: '30-min' })
    expect(api.to(CREATE)[1]?.body).toMatchObject({
      slug: expect.stringMatching(/^30-min-[a-f0-9]{8}$/),
    })
  })

  it('keeps the typed address descriptive without a live region on each keystroke', async () => {
    const user = userEvent.setup()
    server()
    renderApp('/app/event-types/new')
    await screen.findByRole('heading', { name: 'New event type', level: 1 })
    const link = screen.getByLabelText<HTMLInputElement>('Booking link')
    await user.type(link, 'my-call')
    const preview = document.getElementById('booking-link-status')
    expect(preview?.textContent).toContain('/ada/my-call')
    expect(preview?.getAttribute('role')).toBeNull()
    expect(preview?.closest('[aria-live]')).toBeNull()
    expect(link.getAttribute('aria-describedby')?.split(' ')).toContain('booking-link-status')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    expect(await screen.findByRole('alert')).toBeDefined()
  })
})
