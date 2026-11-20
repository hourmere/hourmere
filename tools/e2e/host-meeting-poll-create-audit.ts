import type { Page, Route } from '@playwright/test'
import type { components } from '../../apps/web/src/api/schema.d.ts'
import { admin as english } from '../../apps/web/src/i18n/catalogues/en/admin.ts'
import { admin as chinese } from '../../apps/web/src/i18n/catalogues/zh-CN/admin.ts'
import { PATHS } from '../../apps/web/src/paths.ts'
import { AUDIT_NOW, AUDIT_TITLE } from './audit-data.ts'
import type { FixtureApp } from './fixtures.ts'

export const hostPollCreateAuditPages = [
  { id: 'host-poll-create', title: 'Create a personal meeting poll' },
  { id: 'host-poll-create-team', title: 'Create a team meeting poll with a public link' },
  { id: 'host-poll-create-loading', title: 'Loading event types for a meeting poll' },
  { id: 'host-poll-create-empty', title: 'Meeting poll with no eligible event types' },
  { id: 'host-poll-create-error', title: 'Meeting poll event types load error' },
  { id: 'host-poll-create-forbidden', title: 'Create a poll without permission' },
  { id: 'host-poll-create-no-address', title: 'Poll event has no public booking address' },
  { id: 'host-poll-create-times-loading', title: 'Loading offered meeting poll candidate times' },
  { id: 'host-poll-create-unavailable', title: 'No offered candidate times for a meeting poll' },
  { id: 'host-poll-create-times-error', title: 'Could not load meeting poll candidate times' },
  { id: 'host-poll-create-deadline', title: 'Meeting poll deadline validation' },
  {
    id: 'host-poll-create-repeated-deadline',
    title: 'Choose between repeated local deadline times',
  },
  { id: 'host-poll-create-stale', title: 'Stale meeting poll creation form' },
  {
    id: 'host-poll-create-stale-times',
    title: 'Selected meeting poll candidate time is no longer offered',
  },
  { id: 'host-poll-create-retry', title: 'Unconfirmed meeting poll creation' },
  { id: 'host-poll-create-recovered', title: 'Recovered meeting poll creation' },
  { id: 'host-poll-create-invited', title: 'Created invitation-only meeting poll' },
  { id: 'host-poll-create-link', title: 'One-time link after meeting poll creation' },
] as const

type CreateAuditId = (typeof hostPollCreateAuditPages)[number]['id']
export function isHostPollCreateAuditPage(id: string): id is CreateAuditId {
  return hostPollCreateAuditPages.some((entry) => entry.id === id)
}

const pollId = '72200000-0000-4000-8000-000000000020'
const firstStart = '2030-01-08T14:00:00Z'
const candidates = [
  {
    id: '72200000-0000-4000-8000-000000000021',
    startAt: firstStart,
    endAt: '2030-01-08T14:30:00Z',
    position: 0,
  },
  {
    id: '72200000-0000-4000-8000-000000000022',
    startAt: '2030-01-08T15:00:00Z',
    endAt: '2030-01-08T15:30:00Z',
    position: 1,
  },
]

export async function openHostPollCreateAuditPage(
  page: Page,
  app: FixtureApp,
  id: CreateAuditId,
  locale: 'en' | 'zh-CN',
  keepPending: (release: () => Promise<void>) => void,
) {
  const copy = (key: keyof typeof english & keyof typeof chinese) =>
    locale === 'zh-CN' ? chinese[key] : english[key]
  const fixture = await app.auditState()
  const eventListUrl = `${app.url}/api/v1/event-types`
  const eventTypeUrl = `${eventListUrl}/${fixture.eventTypeId}`
  const createUrl = `${app.url}/api/v1/meeting-polls`
  const profileUrl = `${app.url}/api/v1/profile`
  const membershipUrl = `${app.url}/api/auth/organization/get-active-member`
  const slotsUrl = /\/api\/v1\/public\/(?:teams\/)?[^/]+\/layout-audit\/slots\?/
  const loading = id === 'host-poll-create-loading'
  const link = id === 'host-poll-create-link' || id === 'host-poll-create-recovered'
  let posts = 0
  const others = async (route: Route) => {
    if (loading) return
    if (id === 'host-poll-create-empty') return route.fulfill({ json: { data: [] } })
    if (id === 'host-poll-create-error') return route.abort()
    const response = await route.fetch()
    if (!response.ok()) return route.fulfill({ response })
    const { data }: { data: components['schemas']['EventType'][] } = await response.json()
    return route.fulfill({ json: { data: data.filter(({ slug }) => slug === 'layout-audit') } })
  }
  const event = async (route: Route) => {
    if (id !== 'host-poll-create-stale') return route.continue()
    const response = await route.fetch()
    if (!response.ok()) return route.fulfill({ response })
    const current: components['schemas']['EventType'] = await response.json()
    return route.fulfill({
      json: {
        ...current,
        updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
      },
    })
  }
  const profile = (route: Route) =>
    route.fulfill({ status: 404, json: { error: 'profile_not_found' } })
  const member = async (route: Route) => {
    const response = await route.fetch()
    if (!response.ok()) return route.fulfill({ response })
    return route.fulfill({ json: { ...(await response.json()), role: 'member' } })
  }
  const slots = (route: Route) => {
    if (id === 'host-poll-create-times-loading') return
    if (id === 'host-poll-create-times-error') return route.abort()
    return route.fulfill({
      json: {
        data:
          id === 'host-poll-create-unavailable'
            ? []
            : candidates.map(({ startAt, endAt }) => ({ start: startAt, end: endAt })),
      },
    })
  }
  const submit = async (route: Route) => {
    posts++
    if (id === 'host-poll-create-retry' || (id === 'host-poll-create-recovered' && posts === 1))
      return route.abort()
    if (id === 'host-poll-create-recovered')
      return route.fulfill({ status: 409, json: { error: 'poll_already_created', pollId } })
    if (id === 'host-poll-create-stale-times')
      return route.fulfill({
        status: 409,
        json: { error: 'slot_unavailable', unavailableStarts: [firstStart] },
      })
    const body = route.request().postDataJSON() as {
      deadlineAt: string
      displayTimeZone: string
      admissionMode: 'public_link' | 'invited'
      visibility: 'private' | 'aggregate'
    }
    const poll: components['schemas']['MeetingPollHost'] = {
      id: pollId,
      organizationId: fixture.organizationId,
      eventTypeId: fixture.eventTypeId,
      title: AUDIT_TITLE,
      durationMinutes: 30,
      ...body,
      status: 'open',
      closedAt: null,
      canceledAt: null,
      scheduledAt: null,
      chosenSlotId: null,
      bookingId: null,
      hostRevision: 1,
      createdByUserId: null,
      source: 'web',
      createdAt: AUDIT_NOW,
      updatedAt: AUDIT_NOW,
      candidates,
    }
    return route.fulfill({
      status: 201,
      json: {
        poll,
        publicLink: link
          ? `https://hourmere.invalid/poll#${'synthetic-voting-link'.repeat(3)}`
          : null,
      },
    })
  }
  const release = async () => {
    await page.unroute(eventListUrl, others)
    await page.unroute(eventTypeUrl, event)
    await page.unroute(slotsUrl, slots)
    await page.unroute(createUrl, submit)
    if (id === 'host-poll-create-no-address') await page.unroute(profileUrl, profile)
    if (id === 'host-poll-create-forbidden') await page.unroute(membershipUrl, member)
  }
  let retained = false
  try {
    await page.route(eventListUrl, others)
    await page.route(eventTypeUrl, event)
    await page.route(slotsUrl, slots)
    await page.route(createUrl, submit)
    if (id === 'host-poll-create-no-address') await page.route(profileUrl, profile)
    if (id === 'host-poll-create-forbidden') await page.route(membershipUrl, member)
    await page.goto(app.url + PATHS.newMeetingPoll)
    const main = page.getByRole('main')
    const form = main.getByTestId('meeting-poll-create')
    if (loading) {
      await main.getByRole('status', { name: copy('Loading event types…') }).waitFor()
      keepPending(release)
      retained = true
    } else if (id === 'host-poll-create-empty') {
      await main
        .getByText(copy('No active individual event types are available for polls in this space.'))
        .waitFor()
    } else if (id === 'host-poll-create-forbidden') {
      await main.getByTestId('meeting-poll-create-denied').waitFor()
    } else if (id === 'host-poll-create-error') {
      await main.getByTestId('meeting-poll-create-load-error').waitFor()
    } else if (id === 'host-poll-create-no-address') {
      await main.getByTestId('meeting-poll-create-no-address').waitFor()
    } else {
      await form.waitFor()
      if (id !== 'host-poll-create-times-loading')
        await form.locator('#poll-create-date').fill('2030-01-08')
      if (id === 'host-poll-create-team' || link) {
        await form.locator('#poll-create-admission').selectOption('public_link')
        await form.locator('#poll-create-visibility').selectOption('aggregate')
      }
      const times = form.locator('#poll-create-candidates')
      if (id === 'host-poll-create-times-loading') {
        await times.getByRole('status').waitFor()
        keepPending(release)
        retained = true
      } else if (id === 'host-poll-create-times-error') {
        await times.getByRole('alert').waitFor()
      } else if (id === 'host-poll-create-unavailable') {
        await times.getByText(copy('No times are offered on this date.')).waitFor()
      } else {
        const checks = times.getByRole('checkbox')
        await checks.first().check()
        await checks.nth(1).check()
        if (id === 'host-poll-create-repeated-deadline') {
          await form.locator('#poll-create-deadline').fill('2030-11-03T01:30')
          await form.locator('#poll-create-deadline-offset').waitFor()
        } else if (id !== 'host-poll-create' && id !== 'host-poll-create-team') {
          await form
            .locator('#poll-create-deadline')
            .fill(id === 'host-poll-create-deadline' ? '2030-01-07T00:00' : '2030-01-07T16:30')
          await form
            .getByRole('button', { name: copy('Create meeting poll'), exact: true })
            .press('Enter')
          if (id === 'host-poll-create-recovered') {
            await main.getByRole('button', { name: copy('Retry creation') }).press('Enter')
            await main.getByText(copy('Your poll was already created.')).waitFor()
          } else if (id === 'host-poll-create-invited') {
            await main.getByText(copy('Meeting poll created')).waitFor()
          } else if (id === 'host-poll-create-link') {
            await main.getByTestId('meeting-poll-public-link').waitFor()
          } else if (id === 'host-poll-create-deadline') {
            await form
              .getByText(copy('The deadline must be 1 hour to 30 days from now.'))
              .first()
              .waitFor()
          } else {
            await form.getByTestId('meeting-poll-create-error').waitFor()
          }
        }
      }
    }
    return PATHS.newMeetingPoll
  } finally {
    if (!retained) await release()
  }
}
