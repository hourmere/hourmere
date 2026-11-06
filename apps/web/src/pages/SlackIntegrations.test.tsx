import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  fakeApi,
  json,
  later,
  ME,
  PROFILE,
  profile,
  type Routes,
  renderApp,
  signedIn,
} from '../test/fake-api.tsx'

const base = '/api/v1/slack-destinations'
const destination = {
  id: '00000000-0000-7000-8000-000000000070',
  organizationId: ME.organization.id,
  url: 'https://hooks.slack.com/services/••••',
  events: ['booking.created'],
  isActive: true,
  eventTypeId: '00000000-0000-7000-8000-000000000071',
  createdAt: '2026-11-06T00:00:00Z',
  updatedAt: '2026-11-06T00:00:00Z',
}
function server(routes: Routes = {}) {
  return fakeApi({
    ...signedIn,
    ...profile(PROFILE),
    [`GET ${base}`]: () => json(200, []),
    'GET /api/v1/event-types': () => json(200, { data: [] }),
    ...routes,
  })
}
async function open() {
  const user = userEvent.setup()
  renderApp('/app/settings')
  await user.click(await screen.findByRole('button', { name: 'Slack booking notifications' }))
  return user
}

describe('Slack settings', () => {
  it('never displays event choices from another space after a context switch', async () => {
    server({
      'GET /api/v1/event-types': () =>
        json(200, {
          data: [
            {
              id: destination.eventTypeId,
              organizationId: 'different-space',
              title: 'Other space title',
            },
          ],
        }),
    })
    await open()
    await screen.findByText('Could not load event type choices. Your saved filter is unchanged.')
    expect(screen.queryByRole('option', { name: 'Other space title' })).toBeNull()
    expect(screen.getByLabelText<HTMLSelectElement>('Event type filter').disabled).toBe(true)
  })

  it('asks before collapsing a dirty configuration and retains it when cancelled', async () => {
    server()
    const user = await open()
    const input = await screen.findByLabelText<HTMLInputElement>('Slack incoming-webhook URL')
    fireEvent.change(input, { target: { value: 'synthetic-draft' } })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await user.click(screen.getByRole('button', { name: 'Slack booking notifications' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(input.isConnected).toBe(true)
    expect(input.value).toBe('synthetic-draft')
  })

  it('preserves an unavailable filter while pausing after event choices fail', async () => {
    const requests = server({
      [`GET ${base}`]: () => json(200, [destination]),
      'GET /api/v1/event-types': () => json(403, { error: 'denied' }),
      [`PATCH ${base}/${destination.id}`]: () => json(200, { ...destination, isActive: false }),
    })
    const user = await open()
    await screen.findByText('Could not load event type choices. Your saved filter is unchanged.')
    const filter = screen.getByLabelText<HTMLSelectElement>('Event type filter')
    expect(filter.disabled).toBe(true)
    expect(filter.value).toBe(destination.eventTypeId)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Save Slack destination' }).disabled,
    ).toBe(true)
    await user.click(screen.getByLabelText('Enable Slack notifications'))
    await user.click(screen.getByRole('button', { name: 'Save Slack destination' }))
    await screen.findByText('Slack destination saved.')
    expect(requests.to(`PATCH ${base}/${destination.id}`)[0]?.body).toEqual({ isActive: false })
  })
  it('shows event titles and lets the owner select a filter explicitly', async () => {
    const requests = server({
      'GET /api/v1/event-types': () =>
        json(200, {
          data: [
            {
              id: destination.eventTypeId,
              organizationId: ME.organization.id,
              title: 'Planning session',
            },
          ],
        }),
      [`POST ${base}`]: () => json(201, destination),
    })
    const user = await open()
    await screen.findByRole('option', { name: 'Planning session' })
    await user.selectOptions(screen.getByLabelText('Event type filter'), destination.eventTypeId)
    fireEvent.change(screen.getByLabelText('Slack incoming-webhook URL'), {
      target: { value: 'https://hooks.slack.com/services/T000/B000/SYNTHETIC' },
    })
    await user.click(screen.getByRole('button', { name: 'Save Slack destination' }))
    await screen.findByText('Slack destination saved.')
    expect(requests.to(`POST ${base}`)[0]?.body).toMatchObject({
      eventTypeId: destination.eventTypeId,
    })
  })
  it('clears a bearer URL even when saving fails without exposing the remote message', async () => {
    server({
      [`POST ${base}`]: () =>
        json(400, { error: 'invalid_slack_url', message: 'sensitive remote detail' }),
    })
    const user = await open()
    const input = await screen.findByLabelText<HTMLInputElement>('Slack incoming-webhook URL')
    fireEvent.change(input, {
      target: { value: 'https://hooks.slack.com/services/T000/B000/SYNTHETIC' },
    })
    await user.click(screen.getByRole('button', { name: 'Save Slack destination' }))
    await screen.findByText(
      'Could not update Slack notifications. Check your access and settings, then try again.',
    )
    expect(input.value).toBe('')
    expect(screen.queryByText(/sensitive remote detail/)).toBeNull()
  })

  it('creates with context fencing, clears the bearer URL and only shows the masked result', async () => {
    let saved = false
    const requests = server({
      [`GET ${base}`]: () => json(200, saved ? [destination] : []),
      [`POST ${base}`]: () => {
        saved = true
        return json(201, destination)
      },
    })
    const user = await open()
    const input = await screen.findByLabelText<HTMLInputElement>('Slack incoming-webhook URL')
    expect(input.type).toBe('password')
    const secret = 'https://hooks.slack.com/services/T000/B000/SYNTHETIC'
    fireEvent.change(input, { target: { value: secret } })
    await user.click(screen.getByRole('button', { name: 'Save Slack destination' }))
    await screen.findByText(destination.url)
    expect(screen.getByLabelText<HTMLInputElement>('Replacement Slack webhook URL').value).toBe('')
    expect(document.body.textContent?.includes(secret)).toBe(false)
    expect(requests.to(`POST ${base}`)[0]?.headers.get('X-Expected-Organization-Id')).toBe(
      ME.organization.id,
    )
    expect(
      requests
        .to(`GET ${base}`)
        .every((call) => call.headers.get('X-Expected-Organization-Id') === ME.organization.id),
    ).toBe(true)
    expect(requests.to(`POST ${base}`)[0]?.body).toMatchObject({
      isActive: true,
      eventTypeId: null,
      events: ['booking.created', 'booking.cancelled', 'booking.rescheduled'],
    })
  })
  it('preserves an existing filter, supports subscription updates, testing and confirmed deletion', async () => {
    let removed = false
    const requests = server({
      [`GET ${base}`]: () => json(200, removed ? [] : [destination]),
      [`PATCH ${base}/${destination.id}`]: () => json(200, destination),
      [`POST ${base}/${destination.id}/test`]: () => json(202, { deliveryId: 'sample' }),
      [`DELETE ${base}/${destination.id}`]: () => {
        removed = true
        return new Response(null, { status: 204 })
      },
    })
    const user = await open()
    await screen.findByText(destination.url)
    expect(screen.getByLabelText<HTMLInputElement>('Event type filter').value).toBe(
      destination.eventTypeId,
    )
    await user.click(screen.getByLabelText('Booking cancelled'))
    await user.click(screen.getByRole('button', { name: 'Save Slack destination' }))
    await screen.findByText('Slack destination saved.')
    expect(requests.to(`PATCH ${base}/${destination.id}`)[0]?.body).toEqual({
      events: ['booking.created', 'booking.cancelled'],
    })
    await user.click(screen.getByRole('button', { name: 'Send test message' }))
    await screen.findByText('Slack test message queued. This does not confirm delivery.')
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await user.click(screen.getByRole('button', { name: 'Delete Slack destination' }))
    expect(requests.to(`DELETE ${base}/${destination.id}`)).toHaveLength(0)
    vi.mocked(window.confirm).mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Delete Slack destination' }))
    await screen.findByText('No Slack destination yet.')
    for (const call of requests.calls.filter((call) => call.path.startsWith(base)))
      expect(call.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
  })
  it('keeps errors neutral, never renders remote error details or a setup form on denied reads', async () => {
    server({
      [`GET ${base}`]: () =>
        json(403, { error: 'insufficient_role', message: 'sensitive remote detail' }),
    })
    await open()
    await screen.findByText(
      'Could not load Slack notifications. Only organization owners and admins can manage them.',
    )
    expect(screen.queryByText('No Slack destination yet.')).toBeNull()
    expect(screen.queryByLabelText('Slack incoming-webhook URL')).toBeNull()
    expect(screen.queryByText(/sensitive remote detail/)).toBeNull()
  })
  it('clears a failed submission URL and blocks stale-context writes until reload', async () => {
    const requests = server({
      [`POST ${base}`]: () =>
        json(409, { error: 'organization_context_changed', message: 'sensitive remote detail' }),
    })
    const user = await open()
    fireEvent.change(await screen.findByLabelText('Slack incoming-webhook URL'), {
      target: { value: 'https://hooks.slack.com/services/T000/B000/SYNTHETIC' },
    })
    await user.click(screen.getByRole('button', { name: 'Save Slack destination' }))
    await screen.findByText('Your team context changed. Reload before making changes.')
    expect(screen.queryByRole('button', { name: 'Save Slack destination' })).toBeNull()
    expect(screen.queryByText(/sensitive remote detail/)).toBeNull()
    expect(requests.to(`POST ${base}`)).toHaveLength(1)
  })
  it('does not show empty configuration while loading and ignores a late result after closing', async () => {
    const pending = later()
    server({ [`GET ${base}`]: () => pending.response })
    const user = await open()
    await screen.findByText('Loading Slack notifications…')
    expect(screen.queryByText('No Slack destination yet.')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Slack booking notifications' }))
    await pending.answer(json(200, [destination]))
    await waitFor(() => expect(screen.queryByText(destination.url)).toBeNull())
  })
  it('disables testing a paused destination and localizes configuration in Chinese', async () => {
    server({ [`GET ${base}`]: () => json(200, [{ ...destination, isActive: false }]) })
    const user = await open()
    await screen.findByText(destination.url)
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Send test message' }).disabled,
    ).toBe(true)
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(screen.getByRole('heading', { name: '集成' })).toBeDefined()
    expect(screen.getByLabelText('新的 Slack Webhook 地址')).toBeDefined()
    expect(screen.getByLabelText('按活动类型筛选')).toBeDefined()
    expect(screen.getByLabelText('预约已创建')).toBeDefined()
    expect(screen.getByRole('button', { name: '保存 Slack 接收地址' })).toBeDefined()
  })
})
