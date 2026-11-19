import assert from 'node:assert/strict'
import { MAX_GUESTS } from '@hourmere/core/booking-limits'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n/admin.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { chooseLanguage } from '../../i18n/store.ts'
import { bookingPath } from '../../paths.ts'
import { type Call, fakeApi, json, later, ME } from '../../test/fake-api.tsx'
import { MeetingPollResults } from './MeetingPollResults.tsx'
import type { FinalizeBody, PollCandidate, PollResults, PollVoter } from './poll-results-api.ts'

const pollId = '28075c16-a535-49eb-bfba-744df6832e55'
const bookingId = '66459624-1b1f-4ffd-a46a-3924e34687b8'
const bookingSuccessorId = '5251d9a8-afe6-4c12-bdde-143d54c07839'
const organizationId = ME.organization.id
const pollEndpoint = `/api/v1/meeting-polls/${pollId}`
const getResults = `GET ${pollEndpoint}/results`
const postFinalize = `POST ${pollEndpoint}/finalize`
const times: [PollCandidate, PollCandidate, PollCandidate] = [
  {
    id: '4bdcfabd-702f-4e7d-be60-753aba2a8221',
    startAt: '2027-02-18T09:00:00Z',
    endAt: '2027-02-18T09:30:00Z',
    position: 0,
    yes: 1,
    ifNeedBe: 1,
    no: 1,
    availability: 'available',
  },
  {
    id: 'b04da447-6505-4320-b5e2-f02f09f76da3',
    startAt: '2027-02-18T10:00:00Z',
    endAt: '2027-02-18T10:30:00Z',
    position: 1,
    yes: 1,
    ifNeedBe: 0,
    no: 2,
    availability: 'unavailable',
  },
  {
    id: '2ba4748e-63c4-4cc9-bb06-84b0d31ad61b',
    startAt: '2027-02-18T11:00:00Z',
    endAt: '2027-02-18T11:30:00Z',
    position: 2,
    yes: 1,
    ifNeedBe: 0,
    no: 2,
    availability: 'unknown',
  },
]

function voter(
  number: number,
  name: string,
  vote: PollVoter['votes'][number]['value'] = 'yes',
  extras: Partial<PollVoter> = {},
): PollVoter {
  return {
    voterId: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    name,
    email: `voter-${number}@example.test`,
    status: 'verified',
    timeZone: 'UTC',
    locale: 'en',
    invitedAt: null,
    verifiedAt: '2027-02-01T12:00:00Z',
    withdrawnAt: null,
    pendingExpiresAt: null,
    ballotRevision: number,
    submittedAt: '2027-02-01T13:00:00Z',
    consentedAt: '2027-02-01T13:00:00Z',
    votes: times.map(({ id }, index) => ({
      slotId: id,
      value: index === 0 || vote === 'yes' ? vote : 'no',
    })),
    responses: {},
    ...extras,
  }
}

const alice = voter(1, 'Alice Example')
const ravi = voter(2, 'Ravi Example', 'if_need_be')
const declined = voter(3, 'Declined Voter', 'no')
const withdrawn = voter(4, 'Withdrawn Voter', 'yes', {
  status: 'withdrawn',
  withdrawnAt: '2027-02-01T14:00:00Z',
  submittedAt: null,
  consentedAt: null,
  votes: [],
})
const invited = voter(5, 'Invited Voter', 'yes', {
  status: 'invited',
  verifiedAt: null,
  submittedAt: null,
  consentedAt: null,
  votes: [],
})
const noConsent = voter(6, 'No Consent', 'yes', { consentedAt: null })

function sampleResults(
  poll: Partial<PollResults['poll']> = {},
  rest: Partial<Omit<PollResults, 'poll'>> = {},
): PollResults {
  return {
    poll: {
      id: pollId,
      organizationId,
      eventTypeId: '66bc3abb-0c2c-46ed-974b-90154a9cc941',
      title: 'Project check-in',
      durationMinutes: 30,
      displayTimeZone: 'UTC',
      admissionMode: 'public_link',
      visibility: 'aggregate',
      deadlineAt: '2027-02-17T17:00:00Z',
      status: 'open',
      closedAt: null,
      canceledAt: null,
      scheduledAt: null,
      chosenSlotId: null,
      bookingId: null,
      hostRevision: 5,
      createdByUserId: ME.user.id,
      source: 'mcp',
      createdAt: '2027-02-01T09:00:00Z',
      updatedAt: '2027-02-01T09:00:00Z',
      candidates: times.map(({ id, startAt, endAt, position }) => ({
        id,
        startAt,
        endAt,
        position,
      })),
      ...poll,
    },
    resultsRevision: 17,
    countedBallots: 4,
    candidates: times,
    roster: [alice, ravi, declined, withdrawn, invited, noConsent],
    ...rest,
  }
}

function scheduled(results: PollResults, body: unknown, id = bookingId, replayed = false) {
  const request = body as FinalizeBody
  const slot = times.find(({ id }) => id === request.slotId) ?? times[0]
  const current = replayed && id === bookingSuccessorId ? times[2] : slot
  return {
    poll: {
      ...results.poll,
      status: 'scheduled',
      scheduledAt: '2027-02-17T09:00:00Z',
      chosenSlotId: slot.id,
      bookingId,
      hostRevision: results.poll.hostRevision + 1,
    },
    booking: {
      id,
      eventTypeId: results.poll.eventTypeId,
      status: 'confirmed',
      start: current.startAt,
      end: current.endAt,
      source: 'web',
    },
    replayed,
  }
}

function renderResults(onDeleted = vi.fn()) {
  return render(
    <MemoryRouter>
      <InterfaceScope surface="admin">
        <MeetingPollResults
          id={pollId}
          organizationId={organizationId}
          backTo="/app/meeting-polls"
          bookingLink={bookingPath}
          onDeleted={onDeleted}
        />
      </InterfaceScope>
    </MemoryRouter>,
  )
}

const time = () => screen.findByRole<HTMLSelectElement>('combobox', { name: 'Meeting time' })
const booker = () => screen.getByRole('combobox', { name: 'Booker' })
const schedule = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Schedule meeting' })

async function chooseAlice(user: ReturnType<typeof userEvent.setup>, slotId = times[0].id) {
  await user.selectOptions(await time(), slotId)
  await user.selectOptions(booker(), alice.voterId)
}

describe('meeting poll results', () => {
  it.each([
    {
      locale: 'en',
      title: 'Poll results',
      caption: 'Votes by voter and time',
      time: 'Meeting time',
      booker: 'Booker',
      schedule: 'Schedule meeting',
      acknowledge: 'I acknowledge the selected conditional votes.',
      unavailable: 'Currently unavailable',
      inference:
        'Verified voters can see totals. In a small poll, subtracting their own vote can reveal how someone else voted.',
      booking: 'View booking',
    },
    {
      locale: 'zh-CN',
      title: '投票结果',
      caption: '各投票人在不同时段的选择',
      time: '会议时间',
      booker: '预约人',
      schedule: '安排会议',
      acknowledge: '我确认所选参会者中有人仅在有需要时可以参会。',
      unavailable: '当前不可用',
      inference:
        '已验证的投票人可以查看票数。在参与人数较少的投票中，扣除自己的一票后，可能推断出他人的选择。',
      booking: '查看预约',
    },
  ] as const)(
    'shows the private matrix and schedules a consented subset in $locale',
    async (labels) => {
      chooseLanguage(labels.locale)
      const user = userEvent.setup()
      const results = sampleResults()
      const server = fakeApi({
        [getResults]: () => json(200, results),
        [postFinalize]: ({ body }) => json(201, scheduled(results, body)),
      })
      renderResults()
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(labels.title)
      const matrix = await screen.findByRole('table', { name: labels.caption })
      expect(screen.getByText(labels.inference)).toBeTruthy()
      expect(within(matrix).getByText(labels.unavailable)).toBeTruthy()
      expect(within(matrix).getByRole('rowheader', { name: /Declined Voter/ })).toBeTruthy()
      expect(within(matrix).getByRole('rowheader', { name: /Withdrawn Voter/ })).toBeTruthy()
      expect(within(matrix).getByRole('rowheader', { name: /Invited Voter/ })).toBeTruthy()
      const choices = screen.getByRole('combobox', { name: labels.time })
      expect(
        within(choices).getByRole<HTMLOptionElement>('option', {
          name: new RegExp(labels.unavailable),
        }).disabled,
      ).toBe(true)
      await user.selectOptions(choices, times[0].id)
      const bookerChoices = screen.getByRole('combobox', { name: labels.booker })
      expect(within(bookerChoices).getAllByRole('option')).toHaveLength(3)
      expect(
        within(bookerChoices).queryByRole('option', {
          name: /Declined|Withdrawn|Invited|No Consent/,
        }),
      ).toBeNull()
      await user.selectOptions(bookerChoices, alice.voterId)
      await user.click(screen.getByRole('checkbox', { name: /Ravi Example/ }))
      const submit = screen.getByRole<HTMLButtonElement>('button', { name: labels.schedule })
      expect(submit.disabled).toBe(true)
      await user.click(screen.getByRole('checkbox', { name: labels.acknowledge }))
      await user.click(submit)
      const link = await screen.findByRole('link', { name: labels.booking })
      expect(link.getAttribute('href')).toBe(bookingPath(bookingId))
      expect(document.activeElement).toBe(link)
      expect(server.to(postFinalize)).toHaveLength(1)
      const [call] = server.to(postFinalize)
      assert(call)
      expect(call.headers.get('x-expected-organization-id')).toBe(organizationId)
      expect(call.headers.get('idempotency-key')).toMatch(/^[0-9a-f]{32}$/)
      expect(call.body).toEqual({
        slotId: times[0].id,
        bookerVoterId: alice.voterId,
        attendeeVoterIds: [alice.voterId, ravi.voterId],
        expectedResultsRevision: 17,
        expectedBallotRevisions: { [alice.voterId]: 1, [ravi.voterId]: 2 },
        acknowledgeConditional: true,
      })
    },
  )

  it('retains the exact intent and key when a committed response is lost', async () => {
    const user = userEvent.setup()
    const results = sampleResults()
    let committed: Call | undefined
    const server = fakeApi({
      [getResults]: () => json(200, results),
      [postFinalize]: (call) => {
        if (!committed) {
          committed = call
          throw new TypeError('Finalization response was lost')
        }
        if (
          committed.headers.get('idempotency-key') !== call.headers.get('idempotency-key') ||
          JSON.stringify(committed.body) !== JSON.stringify(call.body)
        )
          return json(409, { error: 'poll_already_scheduled' })
        return json(200, scheduled(results, call.body, bookingSuccessorId, true))
      },
    })
    renderResults()
    await chooseAlice(user)
    await user.click(schedule())
    const retry = await screen.findByRole('button', { name: 'Retry scheduling' })
    expect(screen.getByRole('alert').textContent).toContain('The booking may have been created.')
    expect((await time()).matches(':disabled')).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel poll…' }).disabled).toBe(
      true,
    )
    await user.click(retry)
    await vi.waitFor(() => expect(server.to(postFinalize)).toHaveLength(2))
    const [first, replay] = server.to(postFinalize)
    assert(first && replay)
    expect(replay.body).toEqual(first.body)
    expect(replay.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'))
    expect(server.to(getResults)).toHaveLength(1)
    expect((await screen.findByRole('link', { name: 'View booking' })).getAttribute('href')).toBe(
      bookingPath(bookingSuccessorId),
    )
    expect(screen.getByText(/^Original scheduled time:/)).toBeTruthy()
    expect(screen.getByText(/^Current booking time:/)).toBeTruthy()
  })

  it('requires review and a new intent after a stale results conflict', async () => {
    const user = userEvent.setup()
    let results = sampleResults()
    const server = fakeApi({
      [getResults]: () => json(200, results),
      [postFinalize]: ({ body }) => {
        if ((body as FinalizeBody).expectedResultsRevision === 17) {
          results = sampleResults(
            { status: 'closed', hostRevision: 6 },
            {
              resultsRevision: 18,
              roster: [{ ...alice, ballotRevision: 7 }, ravi],
            },
          )
          return json(409, { error: 'poll_changed' })
        }
        return json(201, scheduled(results, body))
      },
    })
    renderResults()
    await chooseAlice(user)
    await user.click(schedule())
    const refresh = await screen.findByRole('button', { name: 'Refresh results' })
    expect(screen.getByRole('alert').textContent).toContain('This poll changed.')
    expect(schedule().matches(':disabled')).toBe(true)
    await user.click(refresh)
    expect((await time()).value).toBe('')
    await chooseAlice(user)
    await user.click(schedule())
    await screen.findByRole('link', { name: 'View booking' })
    const [first, second] = server.to(postFinalize)
    assert(first && second)
    expect(second.headers.get('idempotency-key')).not.toBe(first.headers.get('idempotency-key'))
    expect(second.body).toMatchObject({
      expectedResultsRevision: 18,
      expectedBallotRevisions: { [alice.voterId]: 7 },
    })
  })

  it('withholds busy and unknown times and allows a new choice after refreshing', async () => {
    const user = userEvent.setup()
    const results = sampleResults({ visibility: 'private' })
    const refreshed = {
      ...results,
      candidates: [
        { ...times[0], availability: 'unavailable' },
        times[1],
        { ...times[2], availability: 'available' },
      ],
    }
    let reads = 0
    const server = fakeApi({
      [getResults]: () => json(200, ++reads === 1 ? results : refreshed),
      [postFinalize]: ({ body }) =>
        (body as FinalizeBody).slotId === times[0].id
          ? json(409, { error: 'slot_taken' })
          : json(201, scheduled(results, body)),
    })
    renderResults()
    const choices = await time()
    expect(choices.options.item(1)?.disabled).toBe(false)
    expect(choices.options.item(2)?.disabled).toBe(true)
    expect(choices.options.item(3)?.disabled).toBe(true)
    expect(choices.options.item(3)?.text).toContain('Availability unknown')
    await chooseAlice(user)
    expect(
      screen.getByText(
        'Voters can see only their own votes. This results page is private to poll managers.',
      ),
    ).toBeTruthy()
    await user.click(schedule())
    await screen.findByText(
      'This time is no longer available. Choose another time or refresh results.',
    )
    expect(screen.getByText('No candidate time can be selected right now.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Refresh results' }))
    await chooseAlice(user, times[2].id)
    await user.click(schedule())
    await screen.findByRole('link', { name: 'View booking' })
    expect(server.to(postFinalize)[1]?.body).toMatchObject({ slotId: times[2].id })
  })

  it('distinguishes repeated local times in the matrix and picker', async () => {
    const first = { ...times[0], startAt: '2027-11-07T05:00:00Z', endAt: '2027-11-07T05:30:00Z' }
    const second = {
      ...times[1],
      startAt: '2027-11-07T06:00:00Z',
      endAt: '2027-11-07T06:30:00Z',
      availability: 'available',
    } as const
    const results = sampleResults(
      { displayTimeZone: 'America/New_York' },
      { candidates: [first, second] },
    )
    fakeApi({ [getResults]: () => json(200, results) })
    renderResults()
    const choices = await time()
    expect(choices.options.item(1)?.text).toContain('GMT-4')
    expect(choices.options.item(2)?.text).toContain('GMT-5')
    expect(screen.getByRole('columnheader', { name: /GMT-4/ })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: /GMT-5/ })).toBeTruthy()
  })

  it('caps the selection at the booker plus the allowed additional attendees', async () => {
    const user = userEvent.setup()
    const extras = Array.from({ length: MAX_GUESTS + 1 }, (_, index) =>
      voter(20 + index, `Extra attendee ${index + 1}`),
    )
    const results = sampleResults({}, { roster: [alice, ...extras] })
    const server = fakeApi({
      [getResults]: () => json(200, results),
      [postFinalize]: ({ body }) => json(201, scheduled(results, body)),
    })
    renderResults()
    await chooseAlice(user)
    const checkboxes = screen.getAllByRole<HTMLInputElement>('checkbox')
    for (const checkbox of checkboxes.slice(0, MAX_GUESTS)) await user.click(checkbox)
    const [first] = checkboxes
    const last = checkboxes[MAX_GUESTS]
    assert(first && last)
    expect(last.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain(
      `Attendee limit reached (${MAX_GUESTS + 1} including the booker).`,
    )
    await user.click(first)
    expect(last.disabled).toBe(false)
    await user.click(last)
    await user.click(schedule())
    await screen.findByRole('link', { name: 'View booking' })
    const body = server.to(postFinalize)[0]?.body as FinalizeBody
    expect(body.attendeeVoterIds).toEqual([
      alice.voterId,
      ...extras.slice(1).map(({ voterId }) => voterId),
    ])
  })

  it('confirms close, cancel and delete with the current host revision', async () => {
    const user = userEvent.setup()
    let results = sampleResults()
    const close = `POST ${pollEndpoint}/close`
    const cancel = `POST ${pollEndpoint}/cancel`
    const deletePoll = `DELETE ${pollEndpoint}`
    const server = fakeApi({
      [getResults]: () => json(200, results),
      [close]: () => {
        results = sampleResults({ status: 'closed', hostRevision: 6 })
        return json(200, results.poll)
      },
      [cancel]: () => {
        results = sampleResults({ status: 'canceled', hostRevision: 7 })
        return json(200, results.poll)
      },
      [deletePoll]: () => new Response(null, { status: 204 }),
    })
    const deleted = vi.fn()
    renderResults(deleted)
    const closeButton = await screen.findByRole('button', { name: 'Close voting…' })
    await user.click(closeButton)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Go back' }))
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close voting…' }))
    expect(server.to(close)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Close voting…' }))
    await user.click(screen.getByRole('button', { name: 'Close voting' }))
    await screen.findByText('Voting closed')
    expect(schedule()).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Cancel poll…' }))
    await user.click(screen.getByRole('button', { name: 'Cancel poll' }))
    await screen.findByText('Canceled')
    expect(screen.queryByRole('button', { name: 'Schedule meeting' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Delete poll…' }))
    await user.click(screen.getByRole('button', { name: 'Delete poll' }))
    await vi.waitFor(() => expect(deleted).toHaveBeenCalledOnce())
    for (const [route, revision] of [
      [close, 5],
      [cancel, 6],
      [deletePoll, 7],
    ] as const) {
      const [call] = server.to(route)
      assert(call)
      expect(call.headers.get('x-expected-organization-id')).toBe(organizationId)
      expect(call.body).toEqual({ expectedHostRevision: revision })
    }
  })

  it('keeps voter content and actions hidden while loading or after a forbidden read', async () => {
    const result = later()
    fakeApi({ [getResults]: () => result.response })
    renderResults()
    expect(screen.getByRole('status', { name: 'Loading poll results…' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    await result.answer(json(403, { error: 'team_management_access_denied' }))
    expect(screen.getByRole('alert').textContent).toBe(
      'Only team owners and admins can manage meeting polls in this space.',
    )
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Schedule meeting' })).toBeNull()
  })

  it('removes previously loaded voter content when its write access is denied', async () => {
    const user = userEvent.setup()
    fakeApi({
      [getResults]: () => json(200, sampleResults()),
      [postFinalize]: () => json(403, { error: 'team_management_access_denied' }),
    })
    renderResults()
    await chooseAlice(user)
    await user.click(schedule())
    await screen.findByText('Only team owners and admins can manage meeting polls in this space.')
    expect(screen.queryByText(alice.name)).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Schedule meeting' })).toBeNull()
  })
})
