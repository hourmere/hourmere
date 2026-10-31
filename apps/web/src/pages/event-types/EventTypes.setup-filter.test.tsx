import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../../i18n/store.ts'
import { fakeApi, json, ME, profile, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { eventType } from '../../test/fixtures.ts'

const PEER_ID = '00000000-0000-7000-8000-000000000009'

const COPY = {
  en: {
    guide: 'Set up your booking page',
    hours: 'Set your weekly hours',
    banner: 'Showing team events with this member as a host or pool candidate.',
    empty: 'This member does not host any team events.',
    all: 'Show all event types',
    create: 'Create your first event type',
  },
  'zh-CN': {
    guide: '设置你的预约页面',
    hours: '设置每周时间段',
    banner: '当前显示该成员主持或参与候选池的团队活动。',
    empty: '该成员未主持任何团队活动。',
    all: '显示全部活动类型',
    create: '创建第一个活动类型',
  },
} as const

describe.each(['en', 'zh-CN'] as const)('setup and team host filtering in %s', (language) => {
  it('shows only matching team events without treating the viewer as their host', async () => {
    chooseLanguage(language)
    const copy = COPY[language]
    const team = { ...ME, organization: { ...ME.organization, personal: false } }
    fakeApi({
      ...signedInAs(team),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [] }),
      'GET /api/v1/event-types': () =>
        json(200, {
          data: [
            eventType({
              id: 'matching',
              title: 'Peer meeting',
              ownerUserId: null,
              hosts: [{ userId: PEER_ID }],
            }),
            eventType({ id: 'unrelated', ownerUserId: null, hosts: [{ userId: ME.user.id }] }),
            eventType({ id: 'personal', title: 'Personal event', hosts: [{ userId: PEER_ID }] }),
          ],
        }),
    })
    renderApp(`/app/event-types?hostUserId=${PEER_ID}`)
    await screen.findByRole('rowheader', { name: 'Peer meeting' })
    expect(screen.getAllByRole('rowheader')).toHaveLength(1)
    expect(screen.getByText(copy.banner)).toBeDefined()
    expect(screen.queryByRole('link', { name: copy.hours })).toBeNull()
  })

  it('restores the team table without unrelated personal weekly hours guidance', async () => {
    chooseLanguage(language)
    const copy = COPY[language]
    const team = { ...ME, organization: { ...ME.organization, personal: false } }
    fakeApi({
      ...signedInAs(team),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [] }),
      'GET /api/v1/event-types': () =>
        json(200, { data: [eventType({ ownerUserId: null, hosts: [{ userId: ME.user.id }] })] }),
    })
    renderApp(`/app/event-types?hostUserId=${PEER_ID}`)
    await screen.findByText(copy.empty)
    expect(screen.getByText(copy.banner)).toBeDefined()
    expect(screen.queryByRole('link', { name: copy.hours })).toBeNull()
    expect(screen.queryByRole('region', { name: copy.guide })).toBeNull()
    expect(screen.queryByRole('link', { name: copy.create })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    await userEvent.click(screen.getByRole('link', { name: copy.all }))
    await screen.findByRole('rowheader', { name: 'Intro call' })
    expect(screen.queryByText(copy.banner)).toBeNull()
    expect(screen.queryByRole('link', { name: copy.hours })).toBeNull()
  })

  it('keeps one personal setup creation action when a team filter URL opens a personal space', async () => {
    chooseLanguage(language)
    const copy = COPY[language]
    fakeApi({
      ...signedInAs(ME),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [] }),
      'GET /api/v1/event-types': () => json(200, { data: [] }),
    })
    renderApp(`/app/event-types?hostUserId=${PEER_ID}`)
    const guide = await screen.findByRole('region', { name: copy.guide })
    expect(within(guide).getByRole('link', { name: copy.create })).toBeDefined()
    expect(screen.getAllByRole('link', { name: copy.create })).toHaveLength(1)
    expect(screen.queryByText(copy.banner)).toBeNull()
    expect(screen.queryByRole('link', { name: copy.hours })).toBeNull()
    expect(screen.queryByText(copy.empty)).toBeNull()
  })

  it('offers first event creation in an unfiltered empty team space', async () => {
    chooseLanguage(language)
    const copy = COPY[language]
    fakeApi({
      ...signedInAs({ ...ME, organization: { ...ME.organization, personal: false } }),
      ...profile(),
      'GET /api/v1/schedules': () => json(200, { data: [] }),
      'GET /api/v1/event-types': () => json(200, { data: [] }),
    })
    renderApp('/app/event-types')
    expect((await screen.findByRole('link', { name: copy.create })).getAttribute('href')).toBe(
      '/app/event-types/new',
    )
    expect(screen.queryByRole('link', { name: copy.hours })).toBeNull()
    expect(screen.queryByRole('region', { name: copy.guide })).toBeNull()
  })
})
