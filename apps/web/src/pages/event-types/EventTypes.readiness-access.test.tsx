import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

const TEAM = {
  ...ME,
  organization: {
    ...ME.organization,
    id: '00000000-0000-7000-8000-000000000003',
    name: 'Design team',
    slug: 'design-team',
    personal: false,
  },
}
const MEMBER_ROUTE = 'GET /api/auth/organization/get-active-member'
const READINESS_ROUTE = `GET /api/v1/teams/${TEAM.organization.id}/readiness`
const member = (role: string) => ({
  id: 'membership-1',
  organizationId: TEAM.organization.id,
  userId: TEAM.user.id,
  role,
  createdAt: '2026-10-01T09:00:00.000Z',
})
const readiness: Schemas['TeamReadinessPage'] = {
  organizationId: TEAM.organization.id,
  members: { data: [], nextCursor: null },
  eventTypes: {
    data: [
      {
        eventTypeId: EVENT_TYPE_ID,
        enablement: 'enabled',
        activation: 'not_applicable',
        summary: 'checks_passed',
        completeness: 'complete',
        evaluatedAt: '2026-10-28T12:00:00.000Z',
        reasonCodes: [],
        fixKinds: [],
      },
    ],
    nextCursor: null,
  },
}
const labels = {
  en: {
    checks: 'Configuration checks',
    failed: 'Configuration check failed',
    retry: 'Retry checks',
    passed: 'Configuration checks passed',
    copy: 'Copy link for Intro call',
    hours: 'Set your weekly hours',
    handle: 'Choose your handle',
  },
  'zh-CN': {
    checks: '配置检查',
    failed: '配置检查失败',
    retry: '重试检查',
    passed: '配置检查通过',
    copy: '复制链接：Intro call',
    hours: '设置每周时间段',
    handle: '选择用户名',
  },
}

function server(role: string, overrides: Routes = {}) {
  return fakeApi({
    ...signedInAs(TEAM),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-types': () =>
      json(200, { data: [eventType({ ownerUserId: null, organizationId: TEAM.organization.id })] }),
    [MEMBER_ROUTE]: () => json(200, member(role)),
    [READINESS_ROUTE]: () => json(200, readiness),
    ...overrides,
  })
}

async function open() {
  renderApp('/app/event-types')
  await screen.findByRole('rowheader', { name: 'Intro call' })
}

function expectChecksHidden(language: 'en' | 'zh-CN') {
  const text = labels[language]
  expect(screen.queryByRole('columnheader', { name: text.checks })).toBeNull()
  expect(document.querySelector(`[data-label="${text.checks}"]`)).toBeNull()
  expect(screen.queryByText(text.failed)).toBeNull()
  expect(screen.queryByRole('button', { name: text.retry })).toBeNull()
  expect(screen.getByRole('rowheader', { name: 'Intro call' })).toBeDefined()
  expect(document.querySelector('table caption')).toBeNull()
}

describe.each([
  { context: 'personal', me: ME },
  { context: 'team', me: TEAM },
])('$context event readiness without a browser session', ({ me: base }) => {
  // OAuth defensively covers the shared Me union; only sessions and API keys authenticate REST.
  it.each(['api_key', 'oauth'] as const)(
    'keeps the list, copying and editing usable for an %s principal',
    async (kind) => {
      const user = userEvent.setup()
      const me: Schemas['Me'] = {
        ...base,
        principal: {
          kind,
          apiKeyId: kind === 'api_key' ? '00000000-0000-7000-8000-000000000004' : null,
          ...(kind === 'oauth' && {
            oauthConsentId: '00000000-0000-7000-8000-000000000005',
          }),
        },
      }
      const record = eventType({
        organizationId: me.organization.id,
        ownerUserId: me.organization.personal ? me.user.id : null,
      })
      const membership = later()
      const teamReadiness = `GET /api/v1/teams/${me.organization.id}/readiness`
      const api = fakeApi({
        ...signedInAs(me),
        ...profile(),
        'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
        'GET /api/v1/event-types': () => json(200, { data: [record] }),
        [`GET /api/v1/event-types/${record.id}`]: () => json(200, record),
        [`PATCH /api/v1/event-types/${record.id}`]: ({ body }) =>
          json(200, { ...record, ...(body as { title: string }) }),
        'GET /api/v1/event-type-hosts': () =>
          json(200, { data: [{ id: me.user.id, name: me.user.name }], nextAfter: null }),
        [MEMBER_ROUTE]: () => membership.response,
        'GET /api/v1/readiness/self': () => json(403, { error: 'readiness_access_denied' }),
        [teamReadiness]: () => json(403, { error: 'team_management_access_denied' }),
      })
      await open()
      // A session-only role read can answer after the list initially appears. Its 401
      // must never be requested for a non-session principal.
      await membership.answer(json(401, { code: 'UNAUTHORIZED' }))
      await waitFor(() => expectChecksHidden('en'))
      expect(screen.getByRole('heading', { name: 'Event types', level: 1 })).toBeDefined()
      expect(screen.getByTestId('location').textContent).toBe('/app/event-types')
      expect(screen.queryByRole('heading', { name: 'Sign in to Hourmere' })).toBeNull()
      await user.click(screen.getByRole('button', { name: labels.en.copy }))
      expect(await navigator.clipboard.readText()).toBe(
        `${window.location.origin}${me.organization.personal ? '/ada' : '/team/design-team'}/intro-call`,
      )
      await user.click(screen.getByRole('link', { name: 'Edit Intro call' }))
      await screen.findByRole('heading', { name: 'Edit “Intro call”', level: 1 })
      await user.clear(screen.getByLabelText('Title', { exact: true }))
      await user.type(screen.getByLabelText('Title', { exact: true }), 'Updated call')
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      await screen.findByText('Saved.')
      expect(api.to(`PATCH /api/v1/event-types/${record.id}`)[0]?.body).toMatchObject({
        title: 'Updated call',
      })
      expect(api.to(MEMBER_ROUTE)).toHaveLength(0)
      expect(api.to('GET /api/v1/readiness/self')).toHaveLength(0)
      expect(api.to(teamReadiness)).toHaveLength(0)
    },
  )
})

describe('team event readiness access', () => {
  it.each(['en', 'zh-CN'] as const)(
    'skips readiness for a member and leaves the list usable without retry in %s',
    async (language) => {
      chooseLanguage(language)
      const user = userEvent.setup()
      const membership = later()
      const api = server('member', { [MEMBER_ROUTE]: () => membership.response })
      await open()
      await waitFor(() => expect(api.to(MEMBER_ROUTE)).toHaveLength(1))
      expect(api.to(READINESS_ROUTE)).toHaveLength(0)
      await membership.answer(json(200, member('member')))
      expect(api.to(READINESS_ROUTE)).toHaveLength(0)
      await waitFor(() => expectChecksHidden(language))
      await user.click(screen.getByRole('button', { name: labels[language].copy }))
      expectChecksHidden(language)
      expect(api.to(MEMBER_ROUTE)).toHaveLength(1)
      expect(api.to(READINESS_ROUTE)).toHaveLength(0)
      expect(api.to('GET /api/v1/readiness/self')).toHaveLength(0)
      expect(api.to('GET /api/v1/event-types')).toHaveLength(1)
    },
  )

  it.each(['en', 'zh-CN'] as const)(
    'hides checks without a retry after a stale manager role is denied in %s',
    async (language) => {
      chooseLanguage(language)
      const user = userEvent.setup()
      const check = later()
      const api = server('admin', { [READINESS_ROUTE]: () => check.response })
      await open()
      await waitFor(() => expect(api.to(READINESS_ROUTE)).toHaveLength(1))
      await check.answer(json(403, { error: 'team_management_access_denied' }))
      expect(screen.queryByText(labels[language].failed)).toBeNull()
      await waitFor(() => expectChecksHidden(language))
      await user.click(screen.getByRole('button', { name: labels[language].copy }))
      expectChecksHidden(language)
      expect(api.to(MEMBER_ROUTE)).toHaveLength(1)
      expect(api.to(READINESS_ROUTE)).toHaveLength(1)
    },
  )

  it.each([
    ['owner', 'en'],
    ['owner', 'zh-CN'],
    ['admin', 'en'],
    ['admin', 'zh-CN'],
    ['member, admin', 'en'],
  ] as const)('keeps checks available for %s in %s', async (role, language) => {
    chooseLanguage(language)
    const api = server(role)
    await open()
    await screen.findByText(labels[language].passed)
    expect(screen.getByRole('columnheader', { name: labels[language].checks })).toBeDefined()
    const row = screen.getByRole('rowheader', { name: 'Intro call' }).closest('tr') as HTMLElement
    expect(within(row).getByText(labels[language].passed)).toBeDefined()
    expect(screen.queryByRole('button', { name: labels[language].retry })).toBeNull()
    expect(api.to(MEMBER_ROUTE)).toHaveLength(1)
    expect(api.to(READINESS_ROUTE)).toHaveLength(1)
  })

  it.each([
    [403, 'forbidden'],
    [503, 'internal_error'],
    [500, 'team_management_access_denied'],
  ] as const)('keeps %s %s retryable', async (status, error) => {
    const user = userEvent.setup()
    let attempts = 0
    const api = server('owner', {
      [READINESS_ROUTE]: () => (++attempts === 1 ? json(status, { error }) : json(200, readiness)),
    })
    await open()
    await screen.findByText('Configuration check failed')
    await user.click(screen.getByRole('button', { name: 'Retry checks' }))
    await screen.findByText('Configuration checks passed')
    expect(api.to(READINESS_ROUTE)).toHaveLength(2)
  })

  it('keeps a failed role read retryable without prematurely requesting readiness', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const api = server('owner', {
      [MEMBER_ROUTE]: () =>
        ++attempts === 1 ? json(503, { error: 'unavailable' }) : json(200, member('owner')),
    })
    await open()
    await screen.findByText('Configuration check failed')
    expect(api.to(READINESS_ROUTE)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Retry checks' }))
    await screen.findByText('Configuration checks passed')
    expect(api.to(MEMBER_ROUTE)).toHaveLength(2)
    expect(api.to(READINESS_ROUTE)).toHaveLength(1)
  })

  it.each([{ organizationId: 'another-team' }, { userId: 'another-user' }])(
    'rejects mismatched membership context before requesting readiness: %j',
    async (changed) => {
      const api = server('owner', {
        [MEMBER_ROUTE]: () => json(200, { ...member('owner'), ...changed }),
      })
      await open()
      await screen.findByText('Configuration check failed')
      expect(api.to(READINESS_ROUTE)).toHaveLength(0)
      expect(screen.getByRole('button', { name: 'Retry checks' })).toBeDefined()
    },
  )
})

describe('team event setup hints', () => {
  it.each(['en', 'zh-CN'] as const)(
    'retains weekly hours guidance without a personal handle hint in %s',
    async (language) => {
      chooseLanguage(language)
      server('member', {
        ...profile(null),
        'GET /api/v1/schedules': () => json(200, { data: [] }),
      })
      await open()
      expect(screen.getByRole('link', { name: labels[language].hours }).getAttribute('href')).toBe(
        '/app/availability/new',
      )
      expect(screen.queryByRole('link', { name: labels[language].handle })).toBeNull()
    },
  )
})
