import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { meetingPollPath, PATHS } from '../../paths.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  organizations,
  renderApp,
  signedIn,
} from '../../test/fake-api.tsx'

const pollId = '00000000-0000-7000-8000-000000000003'
const team = {
  id: '00000000-0000-7000-8000-000000000004',
  name: 'Design Team',
  slug: 'design',
  personal: false,
}
const list = 'GET /api/v1/meeting-polls'
const results = `GET /api/v1/meeting-polls/${pollId}/results`
const poll: Schemas['MeetingPollHost'] = {
  id: pollId,
  organizationId: ME.organization.id,
  eventTypeId: '00000000-0000-7000-8000-000000000005',
  title: 'Workshop planning / 工作坊筹备',
  durationMinutes: 30,
  displayTimeZone: 'Asia/Shanghai',
  admissionMode: 'invited',
  visibility: 'private',
  deadlineAt: '2030-01-08T18:00:00Z',
  status: 'open',
  closedAt: null,
  canceledAt: null,
  scheduledAt: null,
  chosenSlotId: null,
  bookingId: null,
  hostRevision: 1,
  createdByUserId: ME.user.id,
  source: 'mcp',
  createdAt: '2030-01-07T10:00:00Z',
  updatedAt: '2030-01-07T10:00:00Z',
  candidates: [],
}

describe('Meeting polls in the admin app', () => {
  it.each([
    ['en', 'Meeting polls', 'Voting open', 'Voting deadline:', 'No meeting polls yet.'],
    ['zh-CN', '会议投票', '投票进行中', '投票截止时间：', '暂无会议投票。'],
  ] as const)(
    'loads and pages organization-bound poll links in %s',
    async (locale, title, status, deadline, empty) => {
      chooseLanguage(locale)
      const api = fakeApi({
        ...signedIn,
        [list]: ({ path }) =>
          path.endsWith('?after=opaque-cursor')
            ? json(200, { data: [], nextAfter: null })
            : json(200, { data: [poll], nextAfter: 'opaque-cursor' }),
      })
      const user = userEvent.setup()
      renderApp(PATHS.meetingPolls)

      const heading = await screen.findByRole('heading', { name: title, level: 1 })
      const content = within(screen.getByRole('main'))
      expect(screen.getByRole('link', { name: title }).getAttribute('aria-current')).toBe('page')
      expect(
        (
          await content.findByRole('link', {
            name: locale === 'en' ? 'Create meeting poll' : '创建会议投票',
          })
        ).getAttribute('href'),
      ).toBe(PATHS.newMeetingPoll)
      expect((await content.findByRole('link', { name: poll.title })).getAttribute('href')).toBe(
        meetingPollPath(poll.id, poll.organizationId),
      )
      expect(content.getByText(status)).toBeTruthy()
      expect(
        content.getByText((text) => text.startsWith(deadline) && text.includes('Asia/Shanghai')),
      ).toBeTruthy()
      await user.click(
        content.getByRole('button', { name: locale === 'en' ? 'Next page' : '下一页' }),
      )
      expect(heading.parentElement?.parentElement?.parentElement).toBe(document.activeElement)
      expect(await content.findByText(empty)).toBeTruthy()
      expect(api.to(list).map((call) => call.path)).toEqual([
        '/api/v1/meeting-polls',
        '/api/v1/meeting-polls?after=opaque-cursor',
      ])
      await user.click(
        content.getByRole('button', { name: locale === 'en' ? 'Previous page' : '上一页' }),
      )
      expect(await content.findByRole('link', { name: poll.title })).toBeTruthy()
    },
  )

  it('keeps loading, forbidden, and failed reads distinct from an empty list', async () => {
    const pending = later()
    fakeApi({ ...signedIn, [list]: () => pending.response })
    renderApp(PATHS.meetingPolls)
    expect(await screen.findByRole('status', { name: 'Loading meeting polls…' })).toBeTruthy()
    expect(screen.queryByText('No meeting polls yet.')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Create meeting poll' })).toBeNull()
    await pending.answer(json(403, { error: 'team_management_access_denied' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Only team owners and admins can manage meeting polls in this space.',
    )
    expect(screen.queryByText('No meeting polls yet.')).toBeNull()
  })

  it('withholds a list from a different space and retries a failed read', async () => {
    let reads = 0
    fakeApi({
      ...signedIn,
      [list]: () => {
        reads++
        return json(200, {
          data: [reads === 1 ? { ...poll, organizationId: team.id } : poll],
          nextAfter: null,
        })
      },
    })
    renderApp(PATHS.meetingPolls)
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load meeting polls.',
    )
    expect(screen.queryByText(poll.title)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: poll.title })).toBeTruthy()
  })

  it('opens a deadline link only after the host explicitly switches to its space', async () => {
    let current = ME
    const user = userEvent.setup()
    const api = fakeApi({
      ...signedIn,
      ...organizations([ME.organization, team]),
      'GET /api/v1/me': () => json(200, current),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: team.id, userId: ME.user.id, role: 'admin' }),
      'POST /api/auth/organization/set-active': (call) => {
        expect(call.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
        expect(call.body).toEqual({ organizationId: team.id })
        current = { ...ME, organization: team }
        return json(200, team)
      },
      [results]: () => json(404, { error: 'poll_not_found' }),
    })
    const link = meetingPollPath(pollId, team.id)
    renderApp(link)
    const open = await screen.findByRole('button', { name: 'Switch to Design Team' })
    expect(api.to(results)).toHaveLength(0)
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
    await user.tab()
    open.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(api.to(results)).toHaveLength(1))
    expect(screen.getByTestId('location').textContent).toBe(link)
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(1)
  })

  it('offers neither a switch nor a read for an inaccessible linked space', async () => {
    const api = fakeApi(signedIn)
    renderApp(meetingPollPath(pollId, team.id))
    expect(await screen.findByText('This meeting poll is unavailable.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Switch to Design Team' })).toBeNull()
    expect(api.to(results)).toHaveLength(0)
    expect(api.to('POST /api/auth/organization/set-active')).toHaveLength(0)
  })
})
