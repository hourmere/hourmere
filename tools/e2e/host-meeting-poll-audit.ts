import type { Page, Route } from '@playwright/test'
import type { components } from '../../apps/web/src/api/schema.d.ts'
import { admin as english } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { meetingPollPath, PATHS } from '../../apps/web/src/paths.ts'
import { AUDIT_EMAIL, AUDIT_GUEST_NAME, AUDIT_NOW, AUDIT_TITLE } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'
import {
  hostPollCreateAuditPages,
  isHostPollCreateAuditPage,
  openHostPollCreateAuditPage,
} from './host-meeting-poll-create-audit.ts'

export const hostPollAuditPages = [
  ...hostPollCreateAuditPages,
  { id: 'host-poll-list', title: 'Host meeting poll list' },
  { id: 'host-poll-list-empty', title: 'Empty host meeting poll list' },
  { id: 'host-poll-list-loading', title: 'Loading host meeting poll list' },
  { id: 'host-poll-list-forbidden', title: 'Host meeting poll list without permission' },
  { id: 'host-poll-list-error', title: 'Host meeting poll list load error' },
  { id: 'host-poll-results', title: 'Host meeting poll results' },
  { id: 'host-poll-results-loading', title: 'Loading host meeting poll results' },
  { id: 'host-poll-results-forbidden', title: 'Host meeting poll results without permission' },
  { id: 'host-poll-results-error', title: 'Host meeting poll results load error' },
  { id: 'host-poll-results-missing', title: 'Unavailable host meeting poll' },
  { id: 'host-poll-other-space', title: 'Host meeting poll in another space' },
  { id: 'host-poll-no-available-times', title: 'Host meeting poll with no available times' },
  { id: 'host-poll-conditional', title: 'Conditional attendee acknowledgment' },
  { id: 'host-poll-stale', title: 'Stale host meeting poll results' },
  { id: 'host-poll-retry', title: 'Unconfirmed meeting poll scheduling' },
  { id: 'host-poll-close-confirm', title: 'Confirm closing meeting poll voting' },
  { id: 'host-poll-cancel-confirm', title: 'Confirm canceling a meeting poll' },
  { id: 'host-poll-delete-confirm', title: 'Confirm deleting a meeting poll' },
  { id: 'host-poll-closed', title: 'Closed meeting poll results' },
  { id: 'host-poll-canceled', title: 'Canceled meeting poll results' },
  { id: 'host-poll-scheduled', title: 'Scheduled meeting poll with booking link' },
  { id: 'host-poll-roster-empty', title: 'Meeting poll with an empty invitation roster' },
  { id: 'host-poll-roster-invite', title: 'Meeting poll invitation form' },
  { id: 'host-poll-roster-queued', title: 'Meeting poll invitations queued' },
  { id: 'host-poll-roster-full', title: 'Meeting poll invitation batch exceeds remaining places' },
  { id: 'host-poll-roster-limited', title: 'Meeting poll resend rate limit' },
  { id: 'host-poll-roster-stale', title: 'Stale meeting poll invitation roster' },
  { id: 'host-poll-roster-retry', title: 'Unconfirmed meeting poll invitation request' },
  { id: 'host-poll-roster-remove', title: 'Confirm removing a meeting poll voter' },
  {
    id: 'host-poll-roster-remove-unverified',
    title: 'Confirm removing unverified public sign-ups',
  },
  { id: 'host-poll-roster-rotate', title: 'Confirm replacing a public meeting poll link' },
  { id: 'host-poll-roster-link', title: 'One-time replacement meeting poll link' },
  { id: 'host-poll-roster-rotated', title: 'Recover an unconfirmed public poll link replacement' },
] as const

export type HostPollAuditPageId = (typeof hostPollAuditPages)[number]['id']

export function isHostPollAuditPage(id: string): id is HostPollAuditPageId {
  return hostPollAuditPages.some((entry) => entry.id === id)
}

const pending = new WeakMap<Page, () => Promise<void>>()

export async function leavePendingHostPollAudit(page: Page, origin: string) {
  const release = pending.get(page)
  if (!release) return
  await page.goto(`${origin}/favicon.svg`)
  await release()
  pending.delete(page)
}

const pollId = '72200000-0000-4000-8000-000000000001'
const bookerId = '72200000-0000-4000-8000-000000000002'
const guestId = '72200000-0000-4000-8000-000000000003'
const availableSlotId = '72200000-0000-4000-8000-000000000004'
const busySlotId = '72200000-0000-4000-8000-000000000005'
const pendingVoterId = '72200000-0000-4000-8000-000000000006'
const newVoterId = '72200000-0000-4000-8000-000000000007'
const deadline = '2030-01-08T14:00:00Z'
const candidates = [
  {
    id: availableSlotId,
    startAt: '2030-01-09T14:00:00Z',
    endAt: '2030-01-09T14:30:00Z',
    position: 0,
  },
  { id: busySlotId, startAt: '2030-01-09T15:00:00Z', endAt: '2030-01-09T15:30:00Z', position: 1 },
]
const voter = {
  status: 'verified',
  timeZone: 'America/New_York',
  locale: 'en',
  invitedAt: null,
  verifiedAt: AUDIT_NOW,
  withdrawnAt: null,
  pendingExpiresAt: null,
  ballotRevision: 1,
  submittedAt: AUDIT_NOW,
  consentedAt: AUDIT_NOW,
  responses: {},
} as const

/** Keep edge states deterministic while rendering the real admin pages and session. */
export async function openHostPollAuditPage(
  page: Page,
  app: FixtureApp,
  id: HostPollAuditPageId,
  locale: 'en' | 'zh-CN',
) {
  if (isHostPollCreateAuditPage(id)) {
    return openHostPollCreateAuditPage(page, app, id, locale, (release) => {
      pending.set(page, release)
    })
  }
  const fixture = await app.auditState()
  const copy = (key: keyof typeof english & keyof typeof chinese) =>
    locale === 'zh-CN' ? chinese[key] : english[key]
  const list = id.startsWith('host-poll-list')
  const loading = id.endsWith('-loading')
  const scheduled = id === 'host-poll-scheduled'
  const canceled = id === 'host-poll-canceled'
  const closed = id === 'host-poll-closed'
  const otherSpace = id === 'host-poll-other-space'
  const roster = id.startsWith('host-poll-roster')
  const path = list
    ? PATHS.meetingPolls
    : meetingPollPath(pollId, otherSpace ? fixture.teamOrganizationId : fixture.organizationId)
  const requestUrl = `${app.url}/api/v1/meeting-polls${list ? '' : `/${pollId}/results`}`
  const finalizeUrl = `${app.url}/api/v1/meeting-polls/${pollId}/finalize`
  const rosterUrl = `${app.url}/api/v1/meeting-polls/${pollId}`
  let rotationAttempts = 0
  const poll: components['schemas']['MeetingPollHost'] = {
    id: pollId,
    organizationId: fixture.organizationId,
    eventTypeId: fixture.eventTypeId,
    title: AUDIT_TITLE,
    durationMinutes: 30,
    displayTimeZone: 'America/New_York',
    admissionMode: roster ? 'public_link' : 'invited',
    visibility: 'aggregate',
    deadlineAt: deadline,
    status: scheduled ? 'scheduled' : canceled ? 'canceled' : closed ? 'closed' : 'open',
    closedAt: closed ? deadline : null,
    canceledAt: canceled ? deadline : null,
    scheduledAt: scheduled ? deadline : null,
    chosenSlotId: scheduled ? availableSlotId : null,
    bookingId: scheduled ? fixture.bookingId : null,
    hostRevision: 2,
    createdByUserId: null,
    source: 'mcp',
    createdAt: AUDIT_NOW,
    updatedAt: AUDIT_NOW,
    candidates,
  }
  const results: components['schemas']['MeetingPollHostResults'] = {
    poll,
    resultsRevision: 2,
    countedBallots: 2,
    candidates: candidates.map((candidate, index) => ({
      ...candidate,
      yes: index === 0 ? 1 : 0,
      ifNeedBe: index === 0 ? 1 : 0,
      no: index === 0 ? 0 : 2,
      availability:
        index === 0 && id !== 'host-poll-no-available-times' ? 'available' : 'unavailable',
    })),
    roster: [
      {
        ...voter,
        voterId: bookerId,
        name: AUDIT_GUEST_NAME,
        email: AUDIT_EMAIL,
        invitedAt: roster ? AUDIT_NOW : null,
        votes: [
          { slotId: availableSlotId, value: 'if_need_be' },
          { slotId: busySlotId, value: 'no' },
        ],
      },
      {
        ...voter,
        voterId: guestId,
        name: 'Synthetic poll guest / 投票访客',
        email: 'poll-guest@hourmere.invalid',
        votes: [
          { slotId: availableSlotId, value: 'yes' },
          { slotId: busySlotId, value: 'no' },
        ],
      },
    ],
  }
  if (id === 'host-poll-roster-empty') {
    results.roster = []
    results.countedBallots = 0
    results.candidates = results.candidates.map((candidate) => ({
      ...candidate,
      yes: 0,
      ifNeedBe: 0,
      no: 0,
    }))
  } else if (roster)
    results.roster.push({
      ...voter,
      voterId: pendingVoterId,
      name: 'Synthetic public sign-up / 公开报名者',
      email: 'pending-poll-guest@hourmere.invalid',
      status: 'pending',
      ballotRevision: 0,
      verifiedAt: null,
      submittedAt: null,
      consentedAt: null,
      pendingExpiresAt: '2030-01-07T11:00:00Z',
      votes: [],
    })
  const read = async (route: Route) => {
    if (loading) return
    if (id.endsWith('-forbidden'))
      return route.fulfill({ status: 403, json: { error: 'team_management_access_denied' } })
    if (id.endsWith('-missing'))
      return route.fulfill({ status: 404, json: { error: 'poll_not_found' } })
    if (id.endsWith('-error')) return route.abort()
    return route.fulfill({
      json: list ? { data: id === 'host-poll-list-empty' ? [] : [poll], nextAfter: null } : results,
      headers: { 'cache-control': 'no-store' },
    })
  }
  const submit = (route: Route) =>
    id === 'host-poll-stale'
      ? route.fulfill({ status: 409, json: { error: 'poll_changed' } })
      : route.abort()
  const invitation = (route: Route) => {
    if (id === 'host-poll-roster-retry') return route.abort()
    if (id === 'host-poll-roster-full')
      return route.fulfill({ status: 409, json: { error: 'poll_full' } })
    poll.hostRevision++
    results.resultsRevision++
    results.roster.push({
      ...voter,
      voterId: newVoterId,
      name: 'Synthetic new invitee / 新受邀者',
      email: 'new-poll-guest@hourmere.invalid',
      status: 'invited',
      ballotRevision: 0,
      invitedAt: AUDIT_NOW,
      verifiedAt: null,
      submittedAt: null,
      consentedAt: null,
      votes: [],
    })
    return route.fulfill({
      status: 202,
      json: {
        poll,
        replayed: false,
        entries: [
          {
            email: 'new-poll-guest@hourmere.invalid',
            voterId: newVoterId,
            status: 'invited',
            outcome: 'invited',
          },
        ],
      },
    })
  }
  const resend = (route: Route) =>
    id === 'host-poll-roster-stale'
      ? route.fulfill({ status: 409, json: { error: 'poll_changed' } })
      : route.fulfill({
          status: 429,
          json: { error: 'rate_limited' },
          headers: { 'Retry-After': '20' },
        })
  const rotate = (route: Route) => {
    if (id === 'host-poll-roster-rotated') {
      if (++rotationAttempts === 1) return route.abort()
      return route.fulfill({ status: 409, json: { error: 'poll_link_already_rotated' } })
    }
    return route.fulfill({
      json: {
        poll,
        publicLink: `https://hourmere.invalid/poll#${'synthetic-replacement-vote'.repeat(3)}`,
      },
    })
  }
  const release = async () => {
    await page.unroute(requestUrl, read)
    await page.unroute(finalizeUrl, submit)
    if (roster) {
      await page.unroute(`${rosterUrl}/invitations`, invitation)
      await page.unroute(`${rosterUrl}/invitations/${bookerId}/resend`, resend)
      await page.unroute(`${rosterUrl}/rotate-link`, rotate)
    }
  }

  try {
    await page.route(requestUrl, read)
    await page.route(finalizeUrl, submit)
    if (roster) {
      await page.route(`${rosterUrl}/invitations`, invitation)
      await page.route(`${rosterUrl}/invitations/${bookerId}/resend`, resend)
      await page.route(`${rosterUrl}/rotate-link`, rotate)
    }
    await page.goto(app.url + path)
    const main = page.getByRole('main')
    if (otherSpace) {
      await main.getByText(copy('This poll belongs to another space.')).waitFor()
      await main
        .getByRole('button', { name: copy('Switch to {space}').split('{space}')[0] })
        .waitFor()
    } else if (loading) {
      await main
        .getByRole('status', {
          name: copy(list ? 'Loading meeting polls…' : 'Loading poll results…'),
        })
        .waitFor()
      pending.set(page, release)
    } else if (id.endsWith('-forbidden')) {
      await main
        .getByText(copy('Only team owners and admins can manage meeting polls in this space.'))
        .waitFor()
    } else if (id.endsWith('-error')) {
      await main
        .getByText(
          copy(list ? 'Could not load meeting polls.' : 'Could not load the poll results.'),
          { exact: list },
        )
        .waitFor()
    } else if (id.endsWith('-missing')) {
      await main.getByText(copy('This meeting poll is unavailable.')).waitFor()
    } else if (list) {
      if (id === 'host-poll-list-empty')
        await main.getByText(copy('No meeting polls yet.')).waitFor()
      else await main.getByRole('link', { name: AUDIT_TITLE }).waitFor()
    } else {
      await main.getByTestId('meeting-poll-matrix').waitFor()
      if (roster) await openRosterState(page, id, copy)
      if (scheduled) await main.getByTestId('meeting-poll-booking-link').waitFor()
      if (id === 'host-poll-no-available-times')
        await main.getByText(copy('No candidate time can be selected right now.')).waitFor()
      const confirmation = {
        'host-poll-close-confirm': 'Close voting…',
        'host-poll-cancel-confirm': 'Cancel poll…',
        'host-poll-delete-confirm': 'Delete poll…',
      } as const
      if (
        id === 'host-poll-close-confirm' ||
        id === 'host-poll-cancel-confirm' ||
        id === 'host-poll-delete-confirm'
      ) {
        await main.getByRole('button', { name: copy(confirmation[id]), exact: true }).press('Enter')
        await main.getByTestId('meeting-poll-confirmation').waitFor()
      }
      if (id === 'host-poll-conditional' || id === 'host-poll-stale' || id === 'host-poll-retry') {
        const form = main.getByTestId('meeting-poll-finalize')
        await form
          .getByRole('combobox', { name: copy('Meeting time'), exact: true })
          .selectOption(availableSlotId)
        await form
          .getByRole('combobox', { name: copy('Booker'), exact: true })
          .selectOption(bookerId)
        const acknowledgment = form.getByRole('checkbox', {
          name: copy('I acknowledge the selected conditional votes.'),
        })
        await acknowledgment.waitFor()
        if (id !== 'host-poll-conditional') {
          await acknowledgment.press('Space')
          await form
            .getByRole('button', { name: copy('Schedule meeting'), exact: true })
            .press('Enter')
          await main
            .getByRole('alert')
            .filter({
              hasText: copy(
                id === 'host-poll-stale'
                  ? 'This poll changed. Refresh results and review them before continuing.'
                  : 'The booking may have been created. Retry to recover the result.',
              ),
            })
            .waitFor()
        }
      }
    }
    return path
  } finally {
    if (!pending.has(page)) await release()
  }
}

async function openRosterState(
  page: Page,
  id: HostPollAuditPageId,
  copy: (key: keyof typeof english & keyof typeof chinese) => string,
) {
  const roster = page.getByTestId('meeting-poll-roster')
  await roster.waitFor()
  if (id === 'host-poll-roster-empty') {
    await roster.getByText(copy('There are no voters on this poll yet.')).waitFor()
    return
  }
  if (id === 'host-poll-roster-limited' || id === 'host-poll-roster-stale') {
    await roster.getByTestId('meeting-poll-resend-invitation').first().press('Enter')
    await roster.getByTestId('meeting-poll-roster-error').waitFor()
    return
  }
  const control =
    id === 'host-poll-roster-remove'
      ? 'meeting-poll-remove-voter'
      : id === 'host-poll-roster-remove-unverified'
        ? 'meeting-poll-remove-unverified'
        : id === 'host-poll-roster-rotate' ||
            id === 'host-poll-roster-link' ||
            id === 'host-poll-roster-rotated'
          ? 'meeting-poll-rotate-link'
          : undefined
  if (control) {
    await roster.getByTestId(control).first().press('Enter')
    await roster.getByTestId('meeting-poll-roster-confirmation').waitFor()
    if (id === 'host-poll-roster-link' || id === 'host-poll-roster-rotated') {
      await roster.getByTestId('meeting-poll-roster-confirm').press('Enter')
      if (id === 'host-poll-roster-link')
        await roster.getByTestId('meeting-poll-public-link').waitFor()
      else {
        await roster.getByTestId('meeting-poll-roster-retry').press('Enter')
        await roster.getByTestId('meeting-poll-roster-refresh').waitFor()
      }
    }
    return
  }
  await roster.getByTestId('meeting-poll-invite-open').press('Enter')
  const form = roster.getByTestId('meeting-poll-invite-form')
  await form.waitFor()
  await form.locator('input[type="email"]').first().fill('new-poll-guest@hourmere.invalid')
  await form.locator('input:not([type="email"])').first().fill(AUDIT_GUEST_NAME)
  if (id === 'host-poll-roster-invite') {
    await form
      .getByRole('button', { name: copy('Add another invitee'), exact: true })
      .press('Enter')
    await form.locator('input[type="email"]').nth(1).waitFor()
    return
  }
  await form.getByRole('button', { name: copy('Send invitations'), exact: true }).press('Enter')
  await roster
    .getByTestId(
      id === 'host-poll-roster-queued' ? 'meeting-poll-roster-notice' : 'meeting-poll-roster-error',
    )
    .waitFor()
}
