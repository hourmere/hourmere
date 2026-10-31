import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { EventType, Profile, Schedule } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { eventType, schedule } from '../../test/fixtures.ts'

const GUIDE = 'Set up your booking page'
const USE_DEFAULT = 'Use Monday–Friday, 09:00–17:00'
const STEPS = ['Profile', 'Default availability', 'First event type', 'View and share']
const NO_NAME = { ...ME, user: { ...ME.user, name: '   ' } }

function account({
  me = ME,
  hostProfile = PROFILE,
  schedules = [schedule()],
  events = [eventType()],
  routes = {},
}: {
  me?: typeof ME
  hostProfile?: Profile | null
  schedules?: Schedule[]
  events?: EventType[]
  routes?: Routes
} = {}) {
  return fakeApi({
    ...signedInAs(me),
    ...profile(hostProfile),
    'GET /api/v1/schedules': () => json(200, { data: schedules }),
    'GET /api/v1/event-types': () => json(200, { data: events }),
    ...routes,
  })
}

function step(guide: HTMLElement, name: string) {
  const item = within(guide).getByRole('heading', { name }).closest('li')
  expect(item).not.toBeNull()
  return within(item as HTMLElement)
}

async function openGuide() {
  renderApp('/app/event-types')
  return screen.findByRole('region', { name: GUIDE }, { timeout: 3000 })
}

describe('personal booking page setup', () => {
  it.each<[NonNullable<Parameters<typeof account>[0]>, string]>([
    [{ me: NO_NAME, hostProfile: null, schedules: [], events: [] }, 'Profile'],
    [{ schedules: [], events: [] }, 'Default availability'],
    [{ events: [] }, 'First event type'],
    [{ events: [eventType({ isActive: false })] }, 'View and share'],
  ])('marks only the first incomplete step as current: %s', async (changes, title) => {
    account(changes)
    const guide = await openGuide()
    const current = within(guide)
      .getAllByRole('listitem')
      .filter((item) => item.hasAttribute('aria-current'))
    expect(current).toHaveLength(1)
    expect(current[0]?.getAttribute('aria-current')).toBe('step')
    expect(within(current[0] as HTMLElement).getByRole('heading', { name: title })).toBeDefined()
    expect(within(current[0] as HTMLElement).getByText('Next step')).toBeDefined()
  })

  it.each([
    ['missing', []],
    ['non-default', [schedule({ isDefault: false })]],
    ['empty', [schedule({ weeklyHours: {} })]],
    ['invalid', [schedule({ timeZone: 'Invalid/TimeZone' })]],
  ])('withholds view and copy actions with %s default availability', async (_reason, schedules) => {
    account({ schedules })
    const guide = await openGuide()
    const share = step(guide, 'View and share')
    expect(share.getByText('To do')).toBeDefined()
    expect(share.queryByRole('link', { name: /View booking page/ })).toBeNull()
    expect(share.queryByRole('button', { name: 'Copy booking link' })).toBeNull()
    expect(
      share.getByText(
        'Your link will appear after you set up a profile, valid default availability and an active event type.',
      ),
    ).toBeDefined()
  })

  it.each([
    ['zh-CN', 'en', '使用周一至周五 09:00–17:00'],
    ['en', 'zh-CN', USE_DEFAULT],
  ])(
    'sends the current interface language %s despite profile locale %s',
    async (language, profileLocale, label) => {
      chooseLanguage(language as 'en' | 'zh-CN')
      const api = account({
        hostProfile: { ...PROFILE, locale: profileLocale },
        schedules: [],
        events: [],
        routes: { 'POST /api/v1/schedules/default': () => json(201, schedule()) },
      })
      renderApp('/app/event-types')
      await userEvent.click(await screen.findByRole('button', { name: label }))
      expect(api.to('POST /api/v1/schedules/default')[0]?.body).toEqual({ language })
    },
  )

  it('explains the starter hours naturally in Chinese with the saved profile time zone', async () => {
    chooseLanguage('zh-CN')
    account({ schedules: [], events: [] })
    renderApp('/app/event-types')
    const guide = await screen.findByRole('region', { name: '设置你的预约页面' })
    expect(
      within(guide).getByText(
        `先用周一至周五 09:00–17:00（个人资料时区：${PROFILE.timeZone}）作为默认可预约时间。`,
      ),
    ).toBeDefined()
    const current = within(guide)
      .getAllByRole('listitem')
      .find((item) => item.getAttribute('aria-current') === 'step')
    expect(within(current as HTMLElement).getByText('下一步')).toBeDefined()
  })

  it('keeps the setup instructions and optional calendar step in Simplified Chinese', async () => {
    chooseLanguage('zh-CN')
    account({ me: NO_NAME, hostProfile: null, schedules: [], events: [] })
    renderApp('/app/event-types')
    const guide = await screen.findByRole('region', { name: '设置你的预约页面' }, { timeout: 3000 })
    expect(
      within(guide)
        .getAllByRole('listitem')
        .map((item) => within(item).getByRole('heading').textContent),
    ).toEqual(['个人资料', '默认可预约时间', '首个活动类型', '查看与分享'])
    expect(
      within(guide).getByText('如果未填写显示名称，预约页面、邮件和日历邀请将显示你的用户名。'),
    ).toBeDefined()
    expect(within(guide).getByRole('heading', { name: '连接日历（可选）' })).toBeDefined()
    await userEvent.click(within(guide).getByRole('button', { name: '暂时跳过' }))
    expect(within(guide).getByText('已暂时跳过。之后随时可以连接日历。')).toBeDefined()
    expect(guide.textContent).not.toMatch(
      /Set up your booking page|Missing|Complete your profile|Skip for now/,
    )
  })

  it.each([
    ['setup_profile_required', '请先在设置中完善个人资料和显示名称。'],
    ['setup_default_schedule_required', '请在可预约时间页面检查已有日程，并选择有效的默认日程。'],
  ])('translates a stale setup refusal (%s) in Simplified Chinese', async (error, message) => {
    chooseLanguage('zh-CN')
    account({
      schedules: [],
      events: [],
      routes: {
        'POST /api/v1/schedules/default': () =>
          json(409, { error, message: 'Untranslated server wording must not be shown.' }),
      },
    })
    renderApp('/app/event-types')
    const guide = await screen.findByRole('region', { name: '设置你的预约页面' })
    await userEvent.click(within(guide).getByRole('button', { name: '使用周一至周五 09:00–17:00' }))
    const alert = await within(guide).findByRole('alert')
    expect(alert.textContent).toContain('无法确认你的默认可预约时间。')
    expect(alert.textContent).toContain(message)
    expect(alert.textContent).not.toContain('Untranslated server wording')
    expect(within(alert).getByRole('button', { name: '刷新设置状态' })).toBeDefined()
  })

  it('orders the real missing steps for an empty account and explains the username fallback', async () => {
    const api = account({ me: NO_NAME, hostProfile: null, schedules: [], events: [] })
    const guide = await openGuide()
    expect(
      within(guide)
        .getAllByRole('listitem')
        .map((item) => within(item).getByRole('heading').textContent),
    ).toEqual(STEPS)
    for (const name of STEPS)
      expect(step(guide, name).getByText(/^(To do|Next step)$/)).toBeDefined()
    expect(
      step(guide, 'Profile').getByText(
        'Without a display name, your booking page, emails and calendar invitations show your username instead.',
      ),
    ).toBeDefined()
    expect(
      step(guide, 'Profile')
        .getByRole('link', { name: 'Complete your profile' })
        .getAttribute('href'),
    ).toBe('/app/settings')
    expect(
      within(guide).getByRole<HTMLButtonElement>('button', { name: USE_DEFAULT }).disabled,
    ).toBe(true)
    expect(api.to('POST /api/v1/schedules/default')).toHaveLength(0)
    expect(
      within(guide).getByRole('heading', { name: 'Calendar connection (optional)' }),
    ).toBeDefined()
  })

  it('marks a usable booking link complete while an empty display name still needs attention', async () => {
    account({ me: NO_NAME })
    const guide = await openGuide()
    expect(step(guide, 'Profile').getByText(/^(To do|Next step)$/)).toBeDefined()
    expect(step(guide, 'Default availability').getByText('Complete')).toBeDefined()
    expect(step(guide, 'First event type').getByText('Complete')).toBeDefined()
    expect(step(guide, 'View and share').getByText('Complete')).toBeDefined()
    expect(
      step(guide, 'View and share')
        .getByRole('link', { name: /View booking page/ })
        .getAttribute('href'),
    ).toBe(`${window.location.origin}/ada/intro-call`)
    expect(
      step(guide, 'View and share').getByRole('button', { name: 'Copy booking link' }),
    ).toBeDefined()
  })

  it('requires a saved profile even when the display name and booking prerequisites exist', async () => {
    account({ hostProfile: null })
    const guide = await openGuide()
    expect(step(guide, 'Profile').getByText(/^(To do|Next step)$/)).toBeDefined()
    expect(step(guide, 'Default availability').getByText('Complete')).toBeDefined()
    expect(step(guide, 'First event type').getByText('Complete')).toBeDefined()
    expect(step(guide, 'View and share').getByText(/^(To do|Next step)$/)).toBeDefined()
    expect(
      step(guide, 'View and share').queryByRole('link', { name: 'Activate your first event type' }),
    ).toBeNull()
  })

  it('confirms weekday availability inside the guide and reloads the real schedule before completing it', async () => {
    const pending = later()
    let schedules: Schedule[] = []
    const api = account({
      schedules,
      events: [],
      routes: {
        'GET /api/v1/schedules': () => json(200, { data: schedules }),
        'POST /api/v1/schedules/default': async () => {
          await pending.response
          schedules = [schedule()]
          return json(201, schedules[0])
        },
      },
    })
    const guide = await openGuide()
    expect(step(guide, 'Profile').getByText('Complete')).toBeDefined()
    expect(step(guide, 'Default availability').getByText(/^(To do|Next step)$/)).toBeDefined()
    const useDefault = within(guide).getByRole<HTMLButtonElement>('button', { name: USE_DEFAULT })
    act(() => {
      fireEvent.click(useDefault)
      fireEvent.click(useDefault)
    })
    await waitFor(() => expect(api.to('POST /api/v1/schedules/default')).toHaveLength(1))
    expect(useDefault.disabled).toBe(true)
    expect(step(guide, 'Default availability').getByText(/^(To do|Next step)$/)).toBeDefined()
    expect(api.to('POST /api/v1/schedules/default')[0]?.body).toEqual({ language: 'en' })
    await pending.answer(json(200, {}))
    const refreshed = await screen.findByRole('region', { name: GUIDE })
    await waitFor(() =>
      expect(step(refreshed, 'Default availability').getByText('Complete')).toBeDefined(),
    )
    expect(api.to('GET /api/v1/schedules')).toHaveLength(2)
    expect(step(refreshed, 'First event type').getByText(/^(To do|Next step)$/)).toBeDefined()
    expect(within(refreshed).queryByRole('button', { name: USE_DEFAULT })).toBeNull()
  })

  it('keeps default availability missing after a failed confirmation and lets the host retry', async () => {
    let succeeds = false
    let schedules: Schedule[] = []
    const api = account({
      schedules,
      events: [],
      routes: {
        'GET /api/v1/schedules': () => json(200, { data: schedules }),
        'POST /api/v1/schedules/default': () => {
          if (!succeeds) return json(500, { error: 'internal_error' })
          schedules = [schedule()]
          return json(201, schedules[0])
        },
      },
    })
    const guide = await openGuide()
    const user = userEvent.setup()
    await user.click(within(guide).getByRole('button', { name: USE_DEFAULT }))
    expect(await within(guide).findByRole('alert')).toBeDefined()
    expect(step(guide, 'Default availability').getByText(/^(To do|Next step)$/)).toBeDefined()
    succeeds = true
    await user.click(within(guide).getByRole('button', { name: USE_DEFAULT }))
    await waitFor(() =>
      expect(
        step(screen.getByRole('region', { name: GUIDE }), 'Default availability').getByText(
          'Complete',
        ),
      ).toBeDefined(),
    )
    expect(api.to('POST /api/v1/schedules/default')).toHaveLength(2)
  })

  it('does not optimistically count a successful creation response as a configured default', async () => {
    account({
      schedules: [],
      events: [],
      routes: { 'POST /api/v1/schedules/default': () => json(201, schedule()) },
    })
    const guide = await openGuide()
    await userEvent.click(within(guide).getByRole('button', { name: USE_DEFAULT }))
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: GUIDE }))
          .getByRole('button', { name: USE_DEFAULT })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
    expect(
      step(screen.getByRole('region', { name: GUIDE }), 'Default availability').getByText(
        /^(To do|Next step)$/,
      ),
    ).toBeDefined()
  })

  it('clears an old confirmation failure when refreshed data has valid default availability', async () => {
    let schedules: Schedule[] = []
    account({
      schedules,
      events: [],
      routes: {
        'GET /api/v1/schedules': () => json(200, { data: schedules }),
        'POST /api/v1/schedules/default': () => json(500, { error: 'internal_error' }),
      },
    })
    const guide = await openGuide()
    await userEvent.click(within(guide).getByRole('button', { name: USE_DEFAULT }))
    expect(await within(guide).findByRole('alert')).toBeDefined()
    // A second tab configured the account while this page showed the failed attempt.
    schedules = [schedule()]
    await userEvent.click(within(guide).getByRole('button', { name: 'Refresh setup status' }))
    await waitFor(() =>
      expect(step(guide, 'Default availability').getByText('Complete')).toBeDefined(),
    )
    expect(within(guide).queryByRole('alert')).toBeNull()
    expect(within(guide).queryByRole('button', { name: 'Refresh setup status' })).toBeNull()
  })

  it('keeps a non-default-only schedule missing and offers to review it without overwriting it', async () => {
    const api = account({ schedules: [schedule({ isDefault: false })], events: [] })
    const guide = await openGuide()
    const availability = step(guide, 'Default availability')
    expect(availability.getByText(/^(To do|Next step)$/)).toBeDefined()
    expect(
      availability.getByRole('link', { name: 'Review default availability' }).getAttribute('href'),
    ).toBe('/app/availability')
    expect(within(guide).queryByRole('button', { name: USE_DEFAULT })).toBeNull()
    expect(api.to('POST /api/v1/schedules/default')).toHaveLength(0)
  })

  it.each([
    [
      'no open intervals',
      {
        weeklyHours: {
          monday: [],
          tuesday: [],
          wednesday: [],
          thursday: [],
          friday: [],
          saturday: [],
          sunday: [],
        },
      },
    ],
    [
      'an invalid interval',
      { weeklyHours: { ...schedule().weeklyHours, monday: [{ start: '17:00', end: '09:00' }] } },
    ],
    [
      'overlapping intervals',
      {
        weeklyHours: {
          ...schedule().weeklyHours,
          monday: [
            { start: '09:00', end: '12:00' },
            { start: '11:00', end: '17:00' },
          ],
        },
      },
    ],
    [
      'an unknown weekday',
      {
        weeklyHours: {
          ...schedule().weeklyHours,
          funday: [{ start: '09:00', end: '17:00' }],
        } as Schedule['weeklyHours'],
      },
    ],
    [
      'an API midnight end of 00:00',
      { weeklyHours: { ...schedule().weeklyHours, monday: [{ start: '09:00', end: '00:00' }] } },
    ],
    ['malformed weekly hours', { weeklyHours: null as unknown as Schedule['weeklyHours'] }],
    ['an invalid time zone', { timeZone: 'Invalid/TimeZone' }],
  ])('rejects a default schedule with %s', async (_reason, changes) => {
    account({ schedules: [schedule(changes)], events: [] })
    const guide = await openGuide()
    expect(step(guide, 'Default availability').getByText(/^(To do|Next step)$/)).toBeDefined()
    expect(
      step(guide, 'Default availability').getByRole('link', {
        name: 'Review default availability',
      }),
    ).toBeDefined()
  })

  it('accepts a valid default interval ending at API midnight 24:00', async () => {
    account({
      schedules: [
        schedule({
          weeklyHours: {
            ...schedule().weeklyHours,
            monday: [{ start: '09:00', end: '24:00' }],
          },
        }),
      ],
      events: [],
    })
    const guide = await openGuide()
    expect(step(guide, 'Default availability').getByText('Complete')).toBeDefined()
  })

  it('distinguishes creating a first event from activating its public page', async () => {
    account({ events: [eventType({ isActive: false })] })
    const guide = await openGuide()
    expect(step(guide, 'First event type').getByText('Complete')).toBeDefined()
    expect(step(guide, 'View and share').getByText(/^(To do|Next step)$/)).toBeDefined()
    expect(within(guide).queryByRole('link', { name: 'View booking page' })).toBeNull()
  })

  it('does not let team-owned or another host’s event types complete personal setup', async () => {
    account({
      events: [
        eventType({ ownerUserId: null }),
        eventType({
          id: 'e0000000-0000-7000-8000-000000000002',
          ownerUserId: '00000000-0000-7000-8000-000000000099',
        }),
      ],
    })
    const guide = await openGuide()
    expect(step(guide, 'First event type').getByText(/^(To do|Next step)$/)).toBeDefined()
    expect(step(guide, 'View and share').getByText(/^(To do|Next step)$/)).toBeDefined()
  })

  it('hides the guide for a complete account without requiring calendar connections', async () => {
    const api = account()
    renderApp('/app/event-types')
    await screen.findByRole('rowheader', { name: 'Intro call' }, { timeout: 3000 })
    expect(screen.queryByRole('region', { name: GUIDE })).toBeNull()
    expect(screen.getByRole('link', { name: /\/ada\/intro-call/ }).getAttribute('href')).toBe(
      `${window.location.origin}/ada/intro-call`,
    )
    expect(api.calls.some((call) => /calendar/.test(call.path))).toBe(false)
  })

  it('lets the host skip the optional calendar step while keeping the required missing step visible', async () => {
    const api = account({ events: [] })
    const guide = await openGuide()
    expect(
      within(guide).getByRole('link', { name: 'Connect a calendar' }).getAttribute('href'),
    ).toBe('/app/calendars')
    await userEvent.click(within(guide).getByRole('button', { name: 'Skip for now' }))
    expect(
      within(guide).getByText('Skipped for now. You can connect a calendar later.'),
    ).toBeDefined()
    expect(within(guide).queryByRole('link', { name: 'Connect a calendar' })).toBeNull()
    expect(step(guide, 'First event type').getByText(/^(To do|Next step)$/)).toBeDefined()
    expect(api.calls.some((call) => /calendar/.test(call.path))).toBe(false)
  })

  it.each(['profile', 'schedules', 'event-types'])(
    'does not infer completion when the %s list fails to load',
    async (resource) => {
      let recovers = false
      account({
        events: [],
        routes: {
          [`GET /api/v1/${resource}`]: () =>
            recovers
              ? json(200, resource === 'profile' ? PROFILE : { data: [] })
              : json(500, { error: 'internal_error' }),
        },
      })
      renderApp('/app/event-types')
      expect((await screen.findByRole('alert')).textContent).toContain(
        'Could not load your event types.',
      )
      expect(screen.queryByRole('region', { name: GUIDE })).toBeNull()
      expect(screen.queryByRole('button', { name: USE_DEFAULT })).toBeNull()
      recovers = true
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
      expect(await screen.findByRole('region', { name: GUIDE })).toBeDefined()
    },
  )

  it('never applies the personal guide to a team space with missing personal data', async () => {
    const team = {
      ...NO_NAME,
      organization: {
        ...ME.organization,
        id: '00000000-0000-7000-8000-000000000003',
        personal: false,
      },
    }
    const api = account({ me: team, hostProfile: null, schedules: [], events: [] })
    renderApp('/app/event-types')
    await screen.findByText(/You have no event types yet/, {}, { timeout: 3000 })
    expect(screen.queryByRole('region', { name: GUIDE })).toBeNull()
    expect(screen.queryByRole('button', { name: USE_DEFAULT })).toBeNull()
    expect(api.to('POST /api/v1/schedules/default')).toHaveLength(0)
  })
})
