import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { EventType } from '../../api/resources.ts'
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
import { EVENT_TYPE_ID, eventType, SCHEDULE_ID, schedule } from '../../test/fixtures.ts'
import { LEAVE_WITH_UNSAVED_CHANGES } from '../../unsaved-changes.tsx'

const team = {
  ...ME,
  organization: {
    ...ME.organization,
    id: '00000000-0000-7000-8000-000000000003',
    name: 'Original team',
    slug: 'original-team',
    personal: false,
  },
}
const refusal = () =>
  json(409, { error: 'organization_context_changed', message: 'Changed server wording.' })
const guidance = 'Your team context changed. Reload before making changes.'
const title = () => screen.getByLabelText<HTMLInputElement>('Title')

function server(overrides: Routes = {}, item: EventType = eventType({ ownerUserId: null })) {
  return fakeApi({
    ...signedInAs(team),
    ...profile(),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-types': () => json(200, { data: [item] }),
    'GET /api/v1/event-type-hosts': () =>
      json(200, { data: [{ id: ME.user.id, name: 'Ada' }], nextAfter: null }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, item),
    'POST /api/v1/event-types': refusal,
    [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: refusal,
    [`POST /api/v1/event-types/${EVENT_TYPE_ID}/round-robin/activate`]: refusal,
    [`DELETE /api/v1/event-types/${EVENT_TYPE_ID}`]: refusal,
    ...overrides,
  })
}

async function openEditor() {
  renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  await screen.findByRole('heading', { name: 'Edit “Intro call”', level: 1 })
}

describe('form-bound organization context', () => {
  it('sends the original organization after another tab switches, keeps the draft, and protects recovery', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    let active = team
    const calls = server({ 'GET /api/v1/me': () => json(200, active) })
    renderApp('/app/event-types/new')
    await screen.findByRole('heading', { name: 'New event type', level: 1 })
    await user.type(title(), 'Unsaved original team draft')
    // The other tab changes the server session, while this tab retains its original form.
    active = { ...ME }
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(guidance)
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeNull()
    expect(calls.to('POST /api/v1/event-types')).toHaveLength(1)
    expect(calls.to('POST /api/v1/event-types')[0]?.headers.get('X-Expected-Organization-Id')).toBe(
      team.organization.id,
    )
    expect(calls.to('GET /api/v1/me')).toHaveLength(1)
    expect(title().value).toBe('Unsaved original team draft')
    expect(screen.queryByText(/Created “/)).toBeNull()
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(confirm).toHaveBeenCalledWith(LEAVE_WITH_UNSAVED_CHANGES)
    expect(calls.to('GET /api/v1/me')).toHaveLength(1)
    expect(title().value).toBe('Unsaved original team draft')

    confirm.mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(title().value).toBe(''))
    expect(calls.to('GET /api/v1/me')).toHaveLength(2)
    expect(calls.to('POST /api/v1/event-types')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
  })

  it('binds personal event forms too, so a later team switch cannot silently create in that team', async () => {
    const user = userEvent.setup()
    const calls = server(signedInAs(ME))
    renderApp('/app/event-types/new')
    await screen.findByRole('heading', { name: 'New event type', level: 1 })
    await user.type(title(), 'Personal draft')
    await user.click(screen.getByRole('button', { name: 'Create event type' }))
    await screen.findByRole('alert')
    expect(calls.to('POST /api/v1/event-types')[0]?.headers.get('X-Expected-Organization-Id')).toBe(
      ME.organization.id,
    )
  })

  it.each(['save', 'defaults', 'activate', 'delete'] as const)(
    'sends the bound organization and offers reload when %s is refused',
    async (action) => {
      const user = userEvent.setup()
      // The expected context comes from the form's session, never from a target object's ID.
      const calls = server(
        {},
        eventType({
          ownerUserId: null,
          organizationId: '00000000-0000-7000-8000-000000000099',
          schedulingType: 'round_robin',
          scheduleId: SCHEDULE_ID,
        }),
      )
      await openEditor()
      if (action === 'save') {
        await user.type(title(), ' revised')
        await user.click(screen.getByRole('button', { name: 'Save changes' }))
      } else if (action === 'defaults') {
        await user.click(screen.getByRole('button', { name: 'Use hosts’ default availability' }))
      } else if (action === 'activate') {
        await user.click(screen.getByRole('button', { name: 'Activate round robin' }))
      } else {
        await user.click(screen.getByRole('button', { name: 'Delete event type' }))
        await user.click(
          within(screen.getByRole('group', { name: /Delete “Intro call”/ })).getByRole('button', {
            name: 'Delete event type',
          }),
        )
      }
      expect((await screen.findByRole('alert')).textContent).toContain(guidance)
      expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeNull()
      const path =
        action === 'delete'
          ? `DELETE /api/v1/event-types/${EVENT_TYPE_ID}`
          : action === 'activate'
            ? `POST /api/v1/event-types/${EVENT_TYPE_ID}/round-robin/activate`
            : `PATCH /api/v1/event-types/${EVENT_TYPE_ID}`
      expect(calls.to(path)).toHaveLength(1)
      expect(calls.to(path)[0]?.headers.get('X-Expected-Organization-Id')).toBe(
        team.organization.id,
      )
      expect(title().value).toBe(action === 'save' ? 'Intro call revised' : 'Intro call')
      expect(screen.getByTestId('location').textContent).toBe(`/app/event-types/${EVENT_TYPE_ID}`)
    },
  )

  it('discards a late refusal after focus refresh remounts the organization', async () => {
    const user = userEvent.setup()
    const pending = later()
    let active = team
    server({
      'GET /api/v1/me': () => json(200, active),
      [`PATCH /api/v1/event-types/${EVENT_TYPE_ID}`]: () => pending.response,
    })
    await openEditor()
    await user.type(title(), ' old draft')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    active = { ...ME }
    await act(async () => fireEvent.focus(window))
    await waitFor(() => expect(title().value).toBe('Intro call'))
    await pending.answer(refusal())
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(title().value).toBe('Intro call')
  })
})
