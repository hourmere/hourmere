import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { assert, describe, expect, it, vi } from 'vitest'
import { api, type Schemas } from '../api/client.ts'
import { chooseLanguage } from '../i18n/store.ts'
import { PATHS, workflowRunHistoryPath } from '../paths.ts'
import {
  fakeApi,
  json,
  later,
  ME,
  organizations,
  renderApp,
  signedIn,
  signedInAs,
} from '../test/fake-api.tsx'

const id = '00000000-0000-7000-8000-000000000003'
const path = workflowRunHistoryPath(id)
const endpoint = `GET /api/v1/workflows/${id}/runs`
const team = {
  id: '00000000-0000-7000-8000-000000000004',
  name: 'Design Team',
  slug: 'design',
  personal: false,
}
const enabled = {
  'GET /api/v1/instance': () => json(200, { workflowsEnabled: true }),
}
const suppressed: Schemas['WorkflowRunHistoryEntry'] = {
  workflowId: id,
  trigger: 'after_end',
  revision: 3,
  dueAt: '2026-11-18T10:00:00.123450Z',
  finishedAt: '2026-11-18T10:00:00.543210Z',
  outcome: 'skipped',
  reason: 'budget_suppressed',
  sent: 0,
  rejected: 0,
  deliveryUnknown: 0,
  skipped: 2,
}
const attempted: Schemas['WorkflowRunHistoryEntry'] = {
  ...suppressed,
  trigger: 'booking.created',
  finishedAt: '2026-11-18T10:00:00.543209Z',
  outcome: 'completed',
  reason: null,
  sent: 1,
  rejected: 2,
  deliveryUnknown: 3,
  skipped: 0,
}
const page = (data: Schemas['WorkflowRunHistoryEntry'][], nextCursor: string | null = null) =>
  json(200, { data, nextCursor } satisfies Schemas['WorkflowRunHistoryPage'])
const cursorOf = (requestPath: string) =>
  new URL(requestPath, window.location.origin).searchParams.get('cursor')

describe('Workflow run history', () => {
  it('opens from the workflow list and passes the opaque cursor unchanged in both directions', async () => {
    const cursor = 'next_A+b/c==%2F'
    const workflow = {
      id,
      owner: { kind: 'personal', id: ME.user.id },
      name: 'Send booking follow-up',
      enabled: false,
    }
    const requests = fakeApi({
      ...signedIn,
      ...enabled,
      'GET /api/v1/workflows': () => json(200, { data: [workflow], nextCursor: null }),
      [endpoint]: ({ path }) =>
        cursorOf(path) === cursor ? page([attempted]) : page([suppressed], cursor),
    })
    const get = vi.spyOn(api, 'GET')
    const user = userEvent.setup()
    renderApp(PATHS.workflows)

    const link = await screen.findByRole('link', { name: `Run history for ${workflow.name}` })
    expect(link.getAttribute('href')).toBe(path)
    link.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Mail budget limit reached')).toBeTruthy()
    const heading = screen.getByRole('heading', { name: 'Run history', level: 1 })
    const buttons = within(screen.getByRole('navigation', { name: 'Run history pages' }))
    expect(buttons.getByRole<HTMLButtonElement>('button', { name: 'Previous page' }).disabled).toBe(
      true,
    )
    buttons.getByRole('button', { name: 'Next page' }).focus()
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(requests.to(endpoint).map(({ path }) => cursorOf(path))).toEqual([null, cursor]),
    )
    expect(await screen.findByRole('heading', { name: 'Booking created' })).toBeTruthy()
    expect(document.activeElement).toBe(heading)
    expect(screen.queryByText('Mail budget limit reached')).toBeNull()
    const last = within(screen.getByRole('navigation', { name: 'Run history pages' }))
    expect(last.getByRole<HTMLButtonElement>('button', { name: 'Next page' }).disabled).toBe(true)
    await user.click(last.getByRole('button', { name: 'Previous page' }))
    expect(await screen.findByText('Mail budget limit reached')).toBeTruthy()
    expect(requests.to(endpoint).map(({ path }) => cursorOf(path))).toEqual([null, cursor, null])
    expect(get).toHaveBeenCalledWith(
      '/api/v1/workflows/{id}/runs',
      expect.objectContaining({ params: { path: { id }, query: { cursor } } }),
    )
  })

  it.each([
    ['en', 'Sent', 'Send outcome unknown', 'Mail budget limit reached', 'Recipients skipped'],
    ['zh-CN', '已发送', '发送结果未知', '已达到邮件发送额度上限', '跳过的收件人数'],
  ] as const)(
    'reports the suppressed and unknown send outcomes in %s with aggregate counts',
    async (locale, sent, unknown, reason, skipped) => {
      chooseLanguage(locale)
      fakeApi({
        ...signedIn,
        ...enabled,
        [endpoint]: () =>
          json(200, {
            data: [suppressed, { ...attempted, privateField: 'Synthetic private address' }],
            nextCursor: null,
          }),
      })
      renderApp(path)
      expect(await screen.findByText(reason)).toBeTruthy()
      const [suppressedRun, unknownRun] = within(screen.getByRole('main')).getAllByRole('listitem')
      assert(suppressedRun && unknownRun)
      expect(within(suppressedRun).getByText(skipped).nextElementSibling?.textContent).toBe('2')
      expect(within(unknownRun).getByText(sent).nextElementSibling?.textContent).toBe('1')
      expect(within(unknownRun).getByText(unknown).nextElementSibling?.textContent).toBe('3')
      expect(screen.queryByText('Synthetic private address')).toBeNull()
      expect(screen.getByRole('main').textContent).not.toMatch(/inbox|收件箱|已送达/i)
    },
  )

  it('renders future outcome and reason codes as unknown', async () => {
    fakeApi({
      ...signedIn,
      ...enabled,
      [endpoint]: () =>
        json(200, {
          data: [{ ...attempted, outcome: 'new_outcome', reason: 'constructor' }],
          nextCursor: null,
        }),
    })
    renderApp(path)
    expect(await screen.findAllByText('Unknown', { exact: true })).toHaveLength(2)
    expect(screen.queryByText('new_outcome')).toBeNull()
    expect(screen.queryByText('constructor')).toBeNull()
  })

  it('distinguishes loading and read failure from an empty response and retries', async () => {
    const pending = later()
    let attempt = 0
    fakeApi({
      ...signedIn,
      ...enabled,
      [endpoint]: () => (++attempt === 1 ? pending.response : page([])),
    })
    renderApp(path)
    expect(await screen.findByRole('status', { name: 'Loading run history…' })).toBeTruthy()
    expect(screen.queryByText('No finished runs yet.')).toBeNull()
    await pending.answer(json(500, { error: 'internal_error', message: 'Private error detail' }))
    expect(await screen.findByText('Could not load run history.')).toBeTruthy()
    expect(screen.queryByText('No finished runs yet.')).toBeNull()
    expect(screen.queryByText('Private error detail')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('No finished runs yet.')).toBeTruthy()
    expect(screen.queryByRole('navigation', { name: 'Run history pages' })).toBeNull()
  })

  it.each([403, 404])('keeps a %i response opaque', async (status) => {
    fakeApi({
      ...signedIn,
      ...enabled,
      [endpoint]: () => json(status, { error: 'workflow_not_found' }),
    })
    renderApp(path)
    expect(await screen.findByText('Run history is unavailable in this space.')).toBeTruthy()
    expect(screen.queryByText('No finished runs yet.')).toBeNull()
  })

  it('accepts the canonical workflow ID for an uppercase link', async () => {
    const lower = 'ab000000-0000-7000-8000-000000000003'
    const upper = lower.toUpperCase()
    fakeApi({
      ...signedIn,
      ...enabled,
      [`GET /api/v1/workflows/${upper}/runs`]: () => page([{ ...suppressed, workflowId: lower }]),
    })
    renderApp(workflowRunHistoryPath(upper))
    expect(await screen.findByText('Mail budget limit reached')).toBeTruthy()
  })

  it.each(['owner', 'admin'] as const)(
    'allows current team %ss to request history',
    async (role) => {
      const membership = later()
      const requests = fakeApi({
        ...signedInAs({ ...ME, organization: team }),
        ...enabled,
        'GET /api/auth/organization/get-active-member': () => membership.response,
        [endpoint]: () => page([suppressed]),
      })
      renderApp(path)
      expect(await screen.findByRole('status', { name: 'Loading run history…' })).toBeTruthy()
      expect(requests.to(endpoint)).toHaveLength(0)
      await membership.answer(json(200, { userId: ME.user.id, organizationId: team.id, role }))
      expect(await screen.findByText('Mail budget limit reached')).toBeTruthy()
      expect(requests.to(endpoint)).toHaveLength(1)
    },
  )

  it('does not request team history for an ordinary member', async () => {
    const requests = fakeApi({
      ...signedInAs({ ...ME, organization: team }),
      ...enabled,
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { userId: ME.user.id, organizationId: team.id, role: 'member' }),
    })
    renderApp(path)
    expect(await screen.findByText('Run history is unavailable in this space.')).toBeTruthy()
    expect(requests.to(endpoint)).toHaveLength(0)
  })

  it('drops the previous space’s late history and restarts without its cursor', async () => {
    const pending = later()
    let me = ME
    const requests = fakeApi({
      ...signedIn,
      ...enabled,
      ...organizations([ME.organization, team]),
      'GET /api/v1/me': () => json(200, me),
      'POST /api/auth/organization/set-active': () => {
        me = { ...ME, organization: team }
        return json(200, team)
      },
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { userId: ME.user.id, organizationId: team.id, role: 'admin' }),
      [endpoint]: ({ path }) => {
        if (!me.organization.personal) return json(404, { error: 'workflow_not_found' })
        return cursorOf(path) ? pending.response : page([suppressed], 'personal-cursor')
      },
    })
    const user = userEvent.setup()
    renderApp(path)
    await user.click(await screen.findByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(requests.to(endpoint)).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: /^Switch space/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: new RegExp(team.name) }))
    expect(await screen.findByText('Run history is unavailable in this space.')).toBeTruthy()
    await pending.answer(page([attempted]))
    expect(screen.queryByText('Send outcome unknown')).toBeNull()
    expect(requests.to(endpoint).map(({ path }) => cursorOf(path))).toEqual([
      null,
      'personal-cursor',
      null,
    ])
  })
})
