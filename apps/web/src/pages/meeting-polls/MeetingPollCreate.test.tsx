import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { chooseLanguage } from '../../i18n/store.ts'
import { meetingPollPath, PATHS } from '../../paths.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  organizations,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedIn,
  signedInAs,
} from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType } from '../../test/fixtures.ts'
import { pollDeadlineInstants } from './poll-deadline.ts'

const list = 'GET /api/v1/event-types'
const detail = `GET /api/v1/event-types/${EVENT_TYPE_ID}`
const create = 'POST /api/v1/meeting-polls'
const slots = 'GET /api/v1/public/ada/intro-call/slots'
const teamSlots = 'GET /api/v1/public/teams/design/intro-call/slots'
const pollId = '00000000-0000-7000-8000-000000000003'
const team = {
  id: '00000000-0000-7000-8000-000000000004',
  name: 'Design',
  slug: 'design',
  personal: false,
}
const publicLink = 'https://example.test/poll#fixture-public-link'
const starts = ['2030-01-08T09:00:00.000Z', '2030-01-08T10:00:00.000Z']
const deadline = '2030-01-07T12:00'

function offered(instants: string[], minutes = 30) {
  return instants.map((start) => ({
    start,
    end: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
  }))
}

function poll(overrides: Partial<Schemas['MeetingPollHost']> = {}): Schemas['MeetingPollHost'] {
  return {
    id: pollId,
    organizationId: ME.organization.id,
    eventTypeId: EVENT_TYPE_ID,
    title: 'Intro call',
    durationMinutes: 30,
    displayTimeZone: 'UTC',
    admissionMode: 'invited',
    visibility: 'private',
    deadlineAt: `${deadline}:00.000Z`,
    status: 'open',
    closedAt: null,
    canceledAt: null,
    scheduledAt: null,
    chosenSlotId: null,
    bookingId: null,
    hostRevision: 1,
    createdByUserId: ME.user.id,
    source: 'web',
    createdAt: '2030-01-07T10:00:00Z',
    updatedAt: '2030-01-07T10:00:00Z',
    candidates: [],
    ...overrides,
  }
}

function personalRoutes(): Routes {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-07T10:00:00Z'))
  const event = eventType({ allowedDurationsMinutes: [30, 60], minimumNoticeMinutes: 30 })
  return {
    ...signedIn,
    ...profile({ ...PROFILE, timeZone: 'UTC' }),
    [list]: () => json(200, { data: [event] }),
    [detail]: () => json(200, event),
    [slots]: ({ path }) =>
      json(200, {
        data: path.includes('2030-01-08')
          ? offered(
              starts,
              Number(new URL(path, location.origin).searchParams.get('durationMinutes')),
            )
          : [],
      }),
  }
}

async function selectCandidates(date = '2030-01-08', dateLabel = 'Availability date (UTC)') {
  fireEvent.change(await screen.findByLabelText(dateLabel), { target: { value: date } })
  const picker = within(document.getElementById('poll-create-candidates') as HTMLElement)
  const choices = await picker.findAllByRole<HTMLInputElement>('checkbox')
  expect(choices).toHaveLength(2)
  for (const choice of choices) fireEvent.click(choice)
  return choices
}

function enterDeadline(value = deadline, label = 'Voting deadline') {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('Create a meeting poll', () => {
  it('creates in the personal space with saved duration and explicit privacy choices', async () => {
    const routes = personalRoutes()
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const record = poll({
      durationMinutes: 60,
      admissionMode: 'public_link',
      visibility: 'aggregate',
    })
    const client = fakeApi({ ...routes, [create]: () => json(201, { poll: record, publicLink }) })
    renderApp(PATHS.newMeetingPoll)

    expect(
      (await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Visibility' })).value,
    ).toBe('private')
    expect(screen.getByText('Only the people you invite by email can join.')).toBeTruthy()
    expect(screen.getByText(/This poll has 40 places\./)).toBeTruthy()
    expect(screen.getByText(/unexpired public sign-ups each reserve a place/)).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Admission' }), {
      target: { value: 'public_link' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Visibility' }), {
      target: { value: 'aggregate' },
    })
    expect(screen.getByText(/They must verify their email address to vote/)).toBeTruthy()
    expect(screen.getByText(/totals can reveal another person’s choices/)).toBeTruthy()
    fireEvent.change(screen.getByRole('combobox', { name: 'Meeting length' }), {
      target: { value: '60' },
    })
    await selectCandidates()
    enterDeadline()
    await userEvent.click(screen.getByRole('button', { name: 'Create meeting poll' }))

    const disclosure = await screen.findByTestId('meeting-poll-public-link')
    expect(
      within(disclosure).getByText('Copy this link now. It will only be shown here once.'),
    ).toBeTruthy()
    expect(within(disclosure).getByText(publicLink)).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe(PATHS.newMeetingPoll)
    expect(document.querySelector(`[href="${publicLink}"]`)).toBeNull()
    expect(storage.mock.calls.flat()).not.toContain(publicLink)
    expect(client.to(create)).toHaveLength(1)
    expect(client.to(create)[0]?.headers.get('x-expected-organization-id')).toBe(ME.organization.id)
    expect(client.to(create)[0]?.body).toEqual({
      eventTypeId: EVENT_TYPE_ID,
      durationMinutes: 60,
      deadlineAt: `${deadline}:00.000Z`,
      candidateStarts: starts,
      displayTimeZone: 'UTC',
      admissionMode: 'public_link',
      visibility: 'aggregate',
    })
    await userEvent.click(within(disclosure).getByRole('button', { name: 'Hide voting link' }))
    expect(screen.queryByText(publicLink)).toBeNull()
    expect(screen.getByRole('link', { name: 'Open meeting poll' }).getAttribute('href')).toBe(
      meetingPollPath(pollId, ME.organization.id),
    )
  })

  it('creates a team poll in Chinese using distinct instants in the repeated DST hour', async () => {
    chooseLanguage('zh-CN')
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-11-02T12:00:00Z'))
    const teamEvent = eventType({ organizationId: team.id, ownerUserId: null })
    const localStarts = ['2030-11-03T05:30:00.000Z', '2030-11-03T06:30:00.000Z']
    const client = fakeApi({
      ...signedInAs({ ...ME, organization: team }),
      ...organizations([ME.organization, team]),
      ...profile({ ...PROFILE, timeZone: 'America/New_York' }),
      [list]: () => json(200, { data: [teamEvent, eventType({ title: 'Other space event' })] }),
      [detail]: () => json(200, teamEvent),
      [teamSlots]: ({ path }) =>
        json(200, { data: path.includes('2030-11-03') ? offered(localStarts) : [] }),
      [create]: () => json(201, { poll: poll({ organizationId: team.id }), publicLink: null }),
    })
    renderApp(PATHS.newMeetingPoll)
    expect(await screen.findByRole('heading', { name: '创建会议投票' })).toBeTruthy()
    expect(await screen.findByText('只有通过电子邮件收到邀请的人才能参与。')).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Other space event' })).toBeNull()
    const choices = await selectCandidates('2030-11-03', '可约日期（America/New_York）')
    expect(choices[0]?.parentElement?.textContent).toContain('GMT-4')
    expect(choices[1]?.parentElement?.textContent).toContain('GMT-5')
    expect(screen.getAllByRole('button', { name: /^移除时间：/ })).toHaveLength(2)
    enterDeadline('2030-11-02T12:00', '投票截止时间')
    await userEvent.click(screen.getByRole('button', { name: '创建会议投票' }))
    expect(await screen.findByRole('heading', { name: '会议投票已创建' })).toBeTruthy()
    expect(screen.queryByTestId('meeting-poll-public-link')).toBeNull()
    expect(client.to(create)[0]?.headers.get('x-expected-organization-id')).toBe(team.id)
    expect(client.to(create)[0]?.body).toMatchObject({
      admissionMode: 'invited',
      candidateStarts: localStarts,
      deadlineAt: '2030-11-02T16:00:00.000Z',
      displayTimeZone: 'America/New_York',
    })
  })

  it('does not duplicate a poll when the create reply is lost and an exact retry is rate limited', async () => {
    const routes = personalRoutes()
    const committed = new Set<string>()
    let requests = 0
    const client = fakeApi({
      ...routes,
      [create]: ({ headers }) => {
        requests++
        if (requests === 2) return json(429, { error: 'rate_limited' })
        const key = headers.get('idempotency-key') ?? ''
        if (committed.has(key)) return json(409, { error: 'poll_already_created', pollId })
        committed.add(key)
        throw new TypeError('Response lost')
      },
    })
    renderApp(PATHS.newMeetingPoll)
    await selectCandidates()
    fireEvent.change(screen.getByRole('combobox', { name: 'Admission' }), {
      target: { value: 'public_link' },
    })
    enterDeadline()
    await userEvent.click(screen.getByRole('button', { name: 'Create meeting poll' }))
    expect(
      await screen.findByText(
        'The poll may have been created. Retry this submission to recover it.',
      ),
    ).toBeTruthy()
    expect(
      (screen.getByRole('combobox', { name: 'Admission' }) as HTMLSelectElement).matches(
        ':disabled',
      ),
    ).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Retry creation' }))
    expect(
      await screen.findByText('Too many requests. Please wait and try again later.'),
    ).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Retry creation' }))
    expect(await screen.findByText('Your poll was already created.')).toBeTruthy()
    expect(
      screen.getByText(
        'The public link was shown only in the original response. Open the poll to rotate the link.',
      ),
    ).toBeTruthy()
    const attempts = client.to(create)
    expect(attempts).toHaveLength(3)
    expect(attempts[0]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f]{32}$/)
    expect(attempts.map(({ headers }) => headers.get('idempotency-key'))).toEqual(
      Array(3).fill(attempts[0]?.headers.get('idempotency-key')),
    )
    expect(attempts.map(({ body }) => body)).toEqual(Array(3).fill(attempts[0]?.body))
    expect(committed.size).toBe(1)
    expect(client.to(detail)).toHaveLength(1)
    expect(screen.queryByTestId('meeting-poll-public-link')).toBeNull()
  })

  it('blocks a stale event before posting and requires an explicit event refresh', async () => {
    const client = fakeApi({
      ...personalRoutes(),
      [detail]: () => json(200, eventType({ updatedAt: '2030-01-07T11:00:00Z' })),
    })
    renderApp(PATHS.newMeetingPoll)
    await selectCandidates()
    enterDeadline()
    await userEvent.click(screen.getByRole('button', { name: 'Create meeting poll' }))
    expect(await screen.findByText(/This event type changed/)).toBeTruthy()
    expect(client.to(create)).toHaveLength(0)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Create meeting poll' }).disabled,
    ).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Reload event types' }))
    expect((await screen.findByLabelText<HTMLInputElement>('Voting deadline')).value).toBe('')
    expect(client.to(list)).toHaveLength(2)
  })

  it('keeps the stale candidate visible and refuses another write until it is removed', async () => {
    const client = fakeApi({
      ...personalRoutes(),
      [create]: () =>
        json(409, {
          error: 'slot_unavailable',
          unavailableStarts: [starts[0]?.replace('.000Z', 'Z')],
        }),
    })
    renderApp(PATHS.newMeetingPoll)
    await selectCandidates()
    enterDeadline()
    await userEvent.click(screen.getByRole('button', { name: 'Create meeting poll' }))
    expect(await screen.findByText('No longer offered')).toBeTruthy()
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Create meeting poll' })
    expect(submit.disabled).toBe(true)
    expect(client.to(create)).toHaveLength(1)
    const marked = screen.getByText('No longer offered').closest('li') as HTMLLIElement
    await userEvent.click(within(marked).getByRole('button', { name: /^Remove time / }))
    expect(screen.queryByText('No longer offered')).toBeNull()
    expect(submit.disabled).toBe(false)
  })

  it('distinguishes an unchecked team role from denial and hides creation from ordinary members', async () => {
    const pending = later()
    const client = fakeApi({
      ...signedInAs({ ...ME, organization: team }),
      ...organizations([ME.organization, team]),
      'GET /api/auth/organization/get-active-member': () => pending.response,
    })
    renderApp(PATHS.newMeetingPoll)
    expect(await screen.findByRole('status', { name: 'Loading event types…' })).toBeTruthy()
    expect(screen.queryByText(/No active individual event types/)).toBeNull()
    await pending.answer(json(200, { organizationId: team.id, userId: ME.user.id, role: 'member' }))
    expect(
      await screen.findByText(
        'Only team owners and admins can manage meeting polls in this space.',
      ),
    ).toBeTruthy()
    expect(screen.queryByTestId('meeting-poll-create')).toBeNull()
    expect(client.to(list)).toHaveLength(0)
    expect(client.to(create)).toHaveLength(0)
  })

  it('rejects a deadline in a skipped clock hour and exposes both UTC instants in the repeated hour', () => {
    expect(pollDeadlineInstants('2030-03-10T02:30', 'America/New_York')).toEqual([])
    expect(pollDeadlineInstants('2030-11-03T01:30', 'America/New_York')).toEqual([
      '2030-11-03T05:30:00.000Z',
      '2030-11-03T06:30:00.000Z',
    ])
  })

  it('resolves deadlines around the Los Angeles spring change and Lord Howe half-hour changes', () => {
    const losAngeles = 'America/Los_Angeles'
    expect(pollDeadlineInstants('2030-03-10T01:59', losAngeles)).toEqual([
      '2030-03-10T09:59:00.000Z',
    ])
    expect(pollDeadlineInstants('2030-03-10T02:00', losAngeles)).toEqual([])
    expect(pollDeadlineInstants('2030-03-10T02:59', losAngeles)).toEqual([])
    expect(pollDeadlineInstants('2030-03-10T03:00', losAngeles)).toEqual([
      '2030-03-10T10:00:00.000Z',
    ])

    const lordHowe = 'Australia/Lord_Howe'
    expect(pollDeadlineInstants('2030-10-06T01:59', lordHowe)).toEqual(['2030-10-05T15:29:00.000Z'])
    expect(pollDeadlineInstants('2030-10-06T02:00', lordHowe)).toEqual([])
    expect(pollDeadlineInstants('2030-10-06T02:29', lordHowe)).toEqual([])
    expect(pollDeadlineInstants('2030-10-06T02:30', lordHowe)).toEqual(['2030-10-05T15:30:00.000Z'])
    expect(pollDeadlineInstants('2030-04-07T01:45', lordHowe)).toEqual([
      '2030-04-06T14:45:00.000Z',
      '2030-04-06T15:15:00.000Z',
    ])
  })
})
