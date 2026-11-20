import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import '../../i18n/admin.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { chooseLanguage } from '../../i18n/store.ts'
import { bookingPath, PATHS } from '../../paths.ts'
import { fakeApi, json, ME } from '../../test/fake-api.tsx'
import { MeetingPollResults } from './MeetingPollResults.tsx'
import type { PollResults, PollVoter } from './poll-results-api.ts'

const id = '28075c16-a535-49eb-bfba-744df6832e55'
const organizationId = ME.organization.id
const endpoint = `/api/v1/meeting-polls/${id}`
const getResults = `GET ${endpoint}/results`
const invite = `POST ${endpoint}/invitations`
const rotate = `POST ${endpoint}/rotate-link`
const removePending = `POST ${endpoint}/remove-unverified`
const at = '2027-02-15T11:00:00Z'

function voter(number: number, status: PollVoter['status'] = 'invited'): PollVoter {
  return {
    voterId: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    name: `Voter ${number}`,
    email: `voter-${number}@example.test`,
    status,
    timeZone: 'UTC',
    locale: 'en',
    invitedAt: status === 'invited' ? at : null,
    verifiedAt: status === 'verified' ? at : null,
    withdrawnAt: status === 'withdrawn' ? at : null,
    pendingExpiresAt: status === 'pending' ? '2027-02-15T12:00:00Z' : null,
    ballotRevision: 0,
    submittedAt: null,
    consentedAt: null,
    votes: [],
    responses: {},
  }
}

const invited = voter(1)
const pending = voter(2, 'pending')
const resend = `POST ${endpoint}/invitations/${invited.voterId}/resend`
const remove = `DELETE ${endpoint}/voters/${invited.voterId}`

function results(
  roster = [invited, pending],
  poll: Partial<PollResults['poll']> = {},
): PollResults {
  return {
    poll: {
      id,
      organizationId,
      eventTypeId: '66bc3abb-0c2c-46ed-974b-90154a9cc941',
      title: 'Team check-in',
      durationMinutes: 30,
      displayTimeZone: 'UTC',
      admissionMode: 'public_link',
      visibility: 'private',
      deadlineAt: '2027-02-17T17:00:00Z',
      status: 'open',
      closedAt: null,
      canceledAt: null,
      scheduledAt: null,
      chosenSlotId: null,
      bookingId: null,
      hostRevision: 7,
      createdByUserId: ME.user.id,
      source: 'web',
      createdAt: at,
      updatedAt: at,
      candidates: [],
      ...poll,
    },
    resultsRevision: 10,
    countedBallots: 0,
    candidates: [],
    roster,
  }
}

function renderResults() {
  return render(
    <MemoryRouter>
      <InterfaceScope surface="admin">
        <MeetingPollResults
          id={id}
          organizationId={organizationId}
          backTo={PATHS.meetingPolls}
          bookingLink={bookingPath}
          onDeleted={() => {}}
        />
      </InterfaceScope>
    </MemoryRouter>,
  )
}

const roster = () => within(screen.getByTestId('meeting-poll-roster'))
const openInvitations = () => roster().getByTestId('meeting-poll-invite-open')
const invitationForm = () => within(roster().getByTestId('meeting-poll-invite-form'))
const rosterError = () => roster().findByTestId('meeting-poll-roster-error')
const rosterNotice = () => screen.findByTestId('meeting-poll-roster-notice')

async function enterInvitee(user: ReturnType<typeof userEvent.setup>, name: string, email: string) {
  await user.click(openInvitations())
  await user.type(invitationForm().getAllByRole('textbox')[0] as HTMLElement, name)
  await user.type(invitationForm().getAllByRole('textbox')[1] as HTMLElement, email)
}

describe('meeting poll invitation roster', () => {
  it('retries a lost invitation with the same key and payload, even after a rate limit', async () => {
    chooseLanguage('en')
    const user = userEvent.setup()
    const entry = voter(3)
    let current = results()
    let queued = 0
    const receipts = new Set<string>()
    let firstReplay = true
    const server = fakeApi({
      [getResults]: () => json(200, current),
      [invite]: ({ headers }) => {
        const key = headers.get('idempotency-key') ?? ''
        const replayed = receipts.has(key)
        if (!replayed) {
          receipts.add(key)
          queued += 1
          current = results([invited, pending, entry], { hostRevision: 8 })
          throw new TypeError('Connection reset after commit')
        }
        if (firstReplay) {
          firstReplay = false
          return new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
          })
        }
        return json(202, {
          poll: current.poll,
          replayed,
          entries: [
            { email: entry.email, voterId: entry.voterId, outcome: 'unchanged', status: 'invited' },
          ],
        })
      },
    })
    renderResults()
    await screen.findByTestId('meeting-poll-roster')
    await enterInvitee(user, entry.name, entry.email)
    await user.click(invitationForm().getByRole('button', { name: 'Send invitations' }))

    expect((await rosterError()).textContent).toContain('Retry the same request')
    expect(invitationForm().getAllByRole('textbox')[1]?.matches(':disabled')).toBe(true)
    await user.click(roster().getByTestId('meeting-poll-roster-retry'))
    expect((await rosterError()).textContent).toContain('Try again in 30 seconds.')
    await user.click(roster().getByTestId('meeting-poll-roster-retry'))
    expect((await rosterNotice()).textContent).toBe(
      'Invitation request recovered. No additional emails were queued.',
    )
    expect(roster().getByText(entry.name)).toBeTruthy()
    const calls = server.to(invite)
    expect(calls).toHaveLength(3)
    expect(calls[0]?.headers.get('idempotency-key')).toMatch(/^[a-f0-9]{32}$/)
    expect(
      calls.every(({ headers }) => headers.get('x-expected-organization-id') === organizationId),
    ).toBe(true)
    expect(new Set(calls.map(({ headers }) => headers.get('idempotency-key'))).size).toBe(1)
    expect(calls.map(({ body }) => body)).toEqual(
      Array.from({ length: 3 }, () => ({ invitees: [{ name: entry.name, email: entry.email }] })),
    )
    expect(queued).toBe(1)
    expect(server.calls.every(({ path }) => !path.includes(entry.email))).toBe(true)
    expect(window.location.href).not.toContain(entry.email)
  })

  it('explains capacity, caps a batch at 40 and keeps a refused Chinese draft editable', async () => {
    chooseLanguage('zh-CN')
    const user = userEvent.setup()
    const withdrawn = voter(3, 'withdrawn')
    const server = fakeApi({
      [getResults]: () => json(200, results([invited, pending, withdrawn])),
      [invite]: () => json(409, { error: 'poll_full' }),
    })
    renderResults()
    await screen.findByRole('heading', { name: '邀请名单' })
    expect(roster().getByText('名额占用：2／40')).toBeTruthy()
    expect(
      roster().getByText('已验证的投票者、有效邀请和未过期的公开报名各占一个名额。'),
    ).toBeTruthy()
    await enterInvitee(user, '示例受邀者', 'invitee@example.test')
    expect(invitationForm().getByText(/每批最多可邀请 40 人。/)).toBeTruthy()
    await user.click(invitationForm().getByRole('button', { name: '发送邀请' }))
    expect((await rosterError()).textContent).toBe(
      '剩余名额不足以容纳本批所有新投票者。本批邀请均未加入发送队列。',
    )
    expect(invitationForm().getAllByRole<HTMLInputElement>('textbox')[1]?.value).toBe(
      'invitee@example.test',
    )
    const add = invitationForm().getByRole<HTMLButtonElement>('button', { name: '添加受邀者' })
    for (let count = 1; count < 40; count++) fireEvent.click(add)
    expect(add.disabled).toBe(true)
    expect(invitationForm().getAllByRole('textbox')).toHaveLength(80)
    expect(server.to(invite)).toHaveLength(1)
  })

  it('refreshes a stale resend and uses the current revision after host review', async () => {
    chooseLanguage('en')
    const user = userEvent.setup()
    let current = results([invited], { admissionMode: 'invited' })
    const server = fakeApi({
      [getResults]: () => json(200, current),
      [resend]: ({ body }) => {
        if ((body as { expectedHostRevision: number }).expectedHostRevision === 7) {
          current = results([invited], { hostRevision: 8, admissionMode: 'invited' })
          return json(409, { error: 'poll_changed' })
        }
        return json(202, { poll: current.poll, voterId: invited.voterId, replayed: false })
      },
    })
    renderResults()
    await screen.findByTestId('meeting-poll-roster')
    expect(roster().queryByTestId('meeting-poll-rotate-link')).toBeNull()
    expect(roster().getByText(/once every 15 minutes, up to three times/)).toBeTruthy()
    const resendButton = () =>
      roster().getByTestId<HTMLButtonElement>('meeting-poll-resend-invitation')
    await user.click(resendButton())
    expect((await rosterError()).textContent).toContain('This poll or roster changed.')
    expect(resendButton().disabled).toBe(true)
    await user.click(roster().getByTestId('meeting-poll-roster-refresh'))
    await screen.findByTestId('meeting-poll-resend-invitation')
    await user.click(resendButton())
    expect((await rosterNotice()).textContent).toBe('Invitation queued for delivery.')
    expect(server.to(resend).map(({ body }) => body)).toEqual([
      { expectedHostRevision: 7 },
      { expectedHostRevision: 8 },
    ])
    expect(
      new Set(server.to(resend).map(({ headers }) => headers.get('idempotency-key'))).size,
    ).toBe(2)
  })

  it('hides private roster data when write access is refused', async () => {
    chooseLanguage('en')
    const user = userEvent.setup()
    fakeApi({
      [getResults]: () => json(200, results()),
      [resend]: () => json(403, { error: 'team_management_access_denied', message: invited.email }),
    })
    const { container } = renderResults()
    await user.click(await screen.findByTestId('meeting-poll-resend-invitation'))
    await screen.findByText('Only team owners and admins can manage meeting polls in this space.')
    expect(screen.queryByTestId('meeting-poll-roster')).toBeNull()
    expect(container.textContent).not.toContain(invited.email)
  })

  it.each([
    {
      button: 'meeting-poll-remove-voter',
      route: remove,
      effect: 'deletes their details and ballot',
    },
    {
      button: 'meeting-poll-remove-unverified',
      route: removePending,
      effect: 'Voters invited by the host are kept.',
    },
    {
      button: 'meeting-poll-rotate-link',
      route: rotate,
      effect: 'The old link stops working immediately.',
    },
  ])('requires destructive confirmation for $button', async ({ button, route, effect }) => {
    chooseLanguage('en')
    const user = userEvent.setup()
    const publicLink = 'https://example.test/poll#synthetic-new-link'
    let current = results()
    const server = fakeApi({
      [getResults]: () => json(200, current),
      [route]: () => {
        if (route === rotate) return json(200, { poll: current.poll, publicLink })
        const removedVoterIds = [route === remove ? invited.voterId : pending.voterId]
        current = results(route === remove ? [pending] : [invited], { hostRevision: 8 })
        return json(200, { poll: current.poll, resultsRevision: 11, removedVoterIds })
      },
    })
    renderResults()
    const opener = (await screen.findAllByTestId(button))[0] as HTMLButtonElement
    await user.click(opener)
    const confirmation = screen.getByTestId('meeting-poll-roster-confirmation')
    expect(confirmation.textContent).toContain(effect)
    expect(server.to(route)).toHaveLength(0)
    expect(document.activeElement?.textContent).toBe('Go back')
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('meeting-poll-roster-confirmation')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(server.to(route)).toHaveLength(0)
    await user.click(opener)
    await user.click(screen.getByTestId('meeting-poll-roster-confirm'))
    if (route === rotate) {
      const disclosure = within(await screen.findByTestId('meeting-poll-public-link'))
      expect(disclosure.getByText(publicLink)).toBeTruthy()
      expect(
        disclosure.getByText('Copy this link now. It will only be shown here once.'),
      ).toBeTruthy()
      expect(window.location.href).not.toContain(publicLink)
      await user.click(disclosure.getByRole('button', { name: 'Hide voting link' }))
      await screen.findByTestId('meeting-poll-roster')
      expect(screen.queryByText(publicLink)).toBeNull()
    } else {
      await rosterNotice()
      expect(roster().queryByText(route === remove ? invited.name : pending.name)).toBeNull()
      expect(roster().getByText(route === remove ? pending.name : invited.name)).toBeTruthy()
    }
    expect(server.to(route)).toHaveLength(1)
    expect(server.to(route)[0]?.body).toEqual({ expectedHostRevision: 7 })
    expect(server.to(route)[0]?.headers.get('x-expected-organization-id')).toBe(organizationId)
  })

  it('recovers a lost rotation without revealing a saved link or sending a second rotation', async () => {
    chooseLanguage('en')
    const user = userEvent.setup()
    let rotations = 0
    const receipts = new Set<string>()
    const server = fakeApi({
      [getResults]: () => json(200, results()),
      [rotate]: ({ headers }) => {
        const key = headers.get('idempotency-key') ?? ''
        if (receipts.has(key)) return json(409, { error: 'poll_link_already_rotated' })
        receipts.add(key)
        rotations += 1
        throw new TypeError('Connection reset after rotation')
      },
    })
    renderResults()
    await user.click(await screen.findByTestId('meeting-poll-rotate-link'))
    await user.click(screen.getByTestId('meeting-poll-roster-confirm'))
    await user.click(await screen.findByTestId('meeting-poll-roster-retry'))
    expect((await rosterError()).textContent).toContain('The public link was already replaced.')
    expect(rotations).toBe(1)
    expect(server.to(rotate)).toHaveLength(2)
    expect(screen.queryByTestId('meeting-poll-public-link')).toBeNull()
    expect(screen.queryByTestId('meeting-poll-roster-retry')).toBeNull()
  })
})
