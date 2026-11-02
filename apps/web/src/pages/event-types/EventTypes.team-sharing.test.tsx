import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import type { EventType } from '../../api/resources.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, later, ME, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType } from '../../test/fixtures.ts'

const TEAM = {
  ...ME,
  organization: { ...ME.organization, slug: 'Design-TEAM', personal: false },
}
const PEER = '00000000-0000-7000-8000-000000000004'
const READINESS = `GET /api/v1/teams/${TEAM.organization.id}/readiness`
type Check = Schemas['TeamReadinessPage']['eventTypes']['data'][number]
const types = ['individual', 'collective', 'round_robin'] as const

function teamEvent(schedulingType: EventType['schedulingType'], over: Partial<EventType> = {}) {
  return eventType({
    ownerUserId: null,
    schedulingType,
    roundRobinActive: schedulingType === 'round_robin',
    hosts:
      schedulingType === 'collective'
        ? [{ userId: PEER }, { userId: ME.user.id }]
        : [{ userId: PEER }],
    ...over,
  })
}

function check(over: Partial<Check> = {}): Check {
  return {
    eventTypeId: EVENT_TYPE_ID,
    enablement: 'enabled',
    activation: 'not_applicable',
    summary: 'checks_passed',
    completeness: 'complete',
    evaluatedAt: '2026-10-31T12:00:00.000Z',
    reasonCodes: [],
    fixKinds: [],
    ...over,
  }
}

function server(event: EventType, item = check(), pending?: ReturnType<typeof later>) {
  return fakeApi({
    ...signedInAs(TEAM),
    'GET /api/v1/schedules': () => json(200, { data: [] }),
    'GET /api/v1/event-types': () => json(200, { data: [event] }),
    [`GET /api/v1/event-types/${event.id}`]: () => json(200, event),
    'GET /api/v1/event-type-hosts': () =>
      json(200, {
        data: [
          { id: PEER, name: 'Peer' },
          { id: ME.user.id, name: 'Ada' },
        ],
        nextAfter: null,
      }),
    [READINESS]: () =>
      pending?.response ??
      json(200, {
        organizationId: TEAM.organization.id,
        members: { data: [], nextCursor: null },
        eventTypes: { data: [item], nextCursor: null },
      }),
  })
}

const row = () => screen.getByRole('rowheader', { name: 'Intro call' }).closest('tr') as HTMLElement
const url = () => `${window.location.origin}/team/Design-TEAM/intro-call`

describe('team list readiness and saved sharing', () => {
  it.each(
    (['en', 'zh-CN'] as const).flatMap((language) => [
      { language, state: 'inactive', isActive: false, roundRobinActive: true },
      { language, state: 'dormant', isActive: true, roundRobinActive: false },
    ]),
  )(
    'does not promise bookings for an unlisted $state team pool in $language',
    async ({ language, isActive, roundRobinActive }) => {
      chooseLanguage(language)
      server(teamEvent('round_robin', { isHidden: true, isActive, roundRobinActive }))
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const share = await screen.findByRole('region', {
        name: language === 'en' ? 'View and share' : '查看与分享',
      })
      const hint =
        language === 'en'
          ? 'Unlisted is not access control. Once this event type is bookable, anyone who knows or guesses its direct link can book it.'
          : '仅限链接不代表访问控制。此活动类型开放预约后，任何知道或猜到直接链接的人都可以预约。'
      expect(within(share).getByText(hint)).toBeDefined()
      expect(screen.getAllByText(hint)).toHaveLength(2)
      expect(
        within(share).queryByRole('link', { name: /View booking page|查看预约页面/ }),
      ).toBeNull()
      expect(
        within(share).getByRole('link', {
          name: language === 'en' ? 'Review visibility' : '查看可见性设置',
        }),
      ).toBeDefined()
      expect(document.body.textContent).not.toContain('can still book it')
    },
  )

  it.each([
    {
      type: 'round_robin' as const,
      event: { roundRobinActive: false },
      item: check({
        summary: 'needs_activation',
        activation: 'inactive',
        reasonCodes: ['activation_required'],
        fixKinds: ['edit_event'],
      }),
      repair: 'Review round-robin activation',
    },
    {
      type: 'individual' as const,
      event: { isActive: false },
      item: check({ summary: 'disabled', enablement: 'disabled' }),
      repair: 'Review enablement',
    },
  ])(
    'shows only the $repair next step when configuration is complete',
    async ({ type, event, item, repair }) => {
      server(teamEvent(type, event), item)
      renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
      const share = await screen.findByRole('region', { name: 'View and share' })
      await within(screen.getByRole('region', { name: 'Saved event checks' })).findByText(
        'Configuration checks passed',
      )
      expect(within(share).getByRole('link', { name: repair })).toBeDefined()
      expect(within(share).queryByText('Configuration needs attention')).toBeNull()
      expect(within(share).queryByText('Configuration not checked')).toBeNull()
      expect(document.getElementById('booking-link-status')?.textContent).not.toContain(
        'Configuration not checked',
      )
      expect(within(share).queryByRole('button', { name: 'Retry checks' })).toBeNull()
      expect(within(share).queryByRole('link', { name: /View booking page/ })).toBeNull()
    },
  )

  it.each(
    types.flatMap((type) => (['en', 'zh-CN'] as const).map((language) => ({ type, language }))),
  )(
    'uses shared readiness for the $type next step beside the viewer’s weekly hours in $language',
    async ({ type, language }) => {
      chooseLanguage(language)
      server(
        teamEvent(type),
        check({
          summary: 'configuration_blocked',
          reasonCodes: ['default_schedule_required'],
          fixKinds: ['ask_member'],
        }),
      )
      renderApp('/app/event-types')
      const review = await screen.findByRole('link', {
        name: language === 'en' ? 'Review hosts' : '检查主持人',
      })
      expect(review.getAttribute('href')).toBe(`/app/event-types/${EVENT_TYPE_ID}#hosts-heading`)
      expect(row().textContent).toContain(
        language === 'en' ? 'Configuration needs attention' : '配置需要处理',
      )
      expect(within(row()).queryByRole('button', { name: /Copy link|复制.*链接/ })).toBeNull()
      expect(within(row()).queryByRole('link', { name: /\/team\// })).toBeNull()
      expect(
        screen.getByRole('link', {
          name: language === 'en' ? 'Set your weekly hours' : '设置每周时间段',
        }),
      ).toBeDefined()
    },
  )

  it.each([
    { name: 'disabled', event: { isActive: false }, item: check() },
    { name: 'dormant', event: { roundRobinActive: false }, item: check() },
    {
      name: 'disabled readiness after an active event snapshot',
      event: {},
      item: check({ summary: 'disabled', enablement: 'disabled' }),
    },
    {
      name: 'inactive readiness after an activated event snapshot',
      event: {},
      item: check({
        summary: 'needs_activation',
        activation: 'inactive',
        reasonCodes: ['activation_required'],
      }),
    },
    {
      name: 'no eligible hosts',
      event: {},
      item: check({
        summary: 'configuration_blocked',
        reasonCodes: ['host_configuration_required'],
        fixKinds: ['edit_event'],
      }),
    },
    {
      name: 'known missing hours alongside a failed check',
      event: {},
      item: check({
        summary: 'check_failed',
        completeness: 'partial',
        reasonCodes: ['default_schedule_required', 'check_failed'],
        fixKinds: ['ask_member', 'retry_summary'],
      }),
    },
  ])('withholds list and share actions for a $name round-robin pool', async ({ event, item }) => {
    const user = userEvent.setup()
    server(teamEvent('round_robin', event), item)
    renderApp('/app/event-types')
    await screen.findByRole('rowheader', { name: 'Intro call' })
    await screen.findByText(
      item.summary === 'check_failed'
        ? 'Configuration check failed'
        : item.completeness === 'partial'
          ? 'Configuration not checked'
          : item.summary === 'configuration_blocked'
            ? 'Configuration needs attention'
            : 'Configuration checks passed',
    )
    expect(within(row()).queryByRole('link', { name: /\/team\// })).toBeNull()
    expect(within(row()).queryByRole('button', { name: 'Copy link for Intro call' })).toBeNull()
    if (event.isActive === false)
      expect(within(row()).getByRole('link', { name: 'Inactive' }).getAttribute('href')).toBe(
        `/app/event-types/${EVENT_TYPE_ID}#event-enablement`,
      )
    await user.click(within(row()).getByRole('link', { name: 'Edit Intro call' }))
    const share = await screen.findByRole('region', { name: 'View and share' })
    await screen.findByRole('heading', { name: 'Saved event checks' })
    expect(within(share).queryByRole('link', { name: /View booking page/ })).toBeNull()
    expect(within(share).queryByRole('button', { name: 'Copy booking link' })).toBeNull()
    expect(share.querySelector('a[href^="#"]')).not.toBeNull()
  })

  it.each([
    {
      label: 'Configuration check failed',
      item: check({ summary: 'check_failed', fixKinds: ['retry_summary'] }),
    },
    { label: 'Configuration not checked', item: check({ completeness: 'partial' }) },
    { label: 'Configuration not checked', item: check({ summary: 'not_checked' }) },
  ])('keeps activated links copyable when readiness says $label', async ({ label, item }) => {
    const user = userEvent.setup()
    server(teamEvent('round_robin'), item)
    renderApp('/app/event-types')
    await screen.findByText(label)
    expect(within(row()).queryByText('Configuration needs attention')).toBeNull()
    expect(within(row()).queryByText('No public booking link')).toBeNull()
    await user.click(within(row()).getByRole('button', { name: 'Copy link for Intro call' }))
    expect(await navigator.clipboard.readText()).toBe(url())
    await user.click(within(row()).getByRole('link', { name: 'Edit Intro call' }))
    const share = await screen.findByRole('region', { name: 'View and share' })
    await within(share).findByRole('button', { name: 'Copy booking link' })
    expect(within(share).queryByText('Configuration needs attention')).toBeNull()
  })

  it.each(types)(
    'copies the stored team address case in the %s list and saved editor',
    async (type) => {
      const user = userEvent.setup()
      server(teamEvent(type))
      renderApp('/app/event-types')
      const copy = await screen.findByRole('button', { name: 'Copy link for Intro call' })
      expect(
        within(row())
          .getByRole('link', { name: /\/team\// })
          .getAttribute('href'),
      ).toBe(url())
      await user.click(copy)
      expect(await navigator.clipboard.readText()).toBe(url())
      await user.click(within(row()).getByRole('link', { name: 'Edit Intro call' }))
      const share = await screen.findByRole('region', { name: 'View and share' })
      expect(
        (await within(share).findByRole('link', { name: /View booking page/ })).getAttribute(
          'href',
        ),
      ).toBe(url())
      await user.click(within(share).getByRole('button', { name: 'Copy booking link' }))
      expect(await navigator.clipboard.readText()).toBe(url())
    },
  )

  it('keeps an activated partial pool shareable using the service’s eligible-candidate result', async () => {
    server(
      teamEvent('round_robin'),
      check({
        summary: 'partial_pool',
        reasonCodes: ['default_schedule_required'],
        fixKinds: ['ask_member'],
      }),
    )
    renderApp('/app/event-types')
    expect(
      (await screen.findByRole('button', { name: 'Copy link for Intro call' })).textContent,
    ).toContain('Copy link')
    expect(await within(row()).findByText('Some hosts need attention')).toBeDefined()
  })

  it('keeps the team list link copyable while readiness loads', async () => {
    const pending = later()
    server(teamEvent('round_robin'), check(), pending)
    renderApp('/app/event-types')
    await screen.findByRole('rowheader', { name: 'Intro call' })
    expect(within(row()).getByRole('button', { name: 'Copy link for Intro call' })).toBeDefined()
    expect(within(row()).getByText('Checking configuration…')).toBeDefined()
    expect(within(row()).queryByText('No public booking link')).toBeNull()
    await pending.answer(
      json(200, {
        organizationId: TEAM.organization.id,
        members: { data: [], nextCursor: null },
        eventTypes: { data: [check()], nextCursor: null },
      }),
    )
    expect(await screen.findByRole('button', { name: 'Copy link for Intro call' })).toBeDefined()
  })
})
