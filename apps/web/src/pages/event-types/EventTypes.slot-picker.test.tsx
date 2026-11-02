import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { EventType } from '../../api/resources.ts'
import {
  fakeApi,
  json,
  ME,
  profile,
  type Routes,
  renderApp,
  signedInAs,
} from '../../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType, schedule } from '../../test/fixtures.ts'

const team = { ...ME, organization: { ...ME.organization, personal: false, slug: 'design-team' } }

function setup({
  enabled = true,
  me = ME,
  event = eventType(),
  role = 'owner',
  overrides = {},
}: {
  enabled?: boolean
  me?: typeof ME
  event?: EventType
  role?: string
  overrides?: Routes
} = {}) {
  return fakeApi({
    ...signedInAs(me),
    ...profile(),
    'GET /api/v1/instance': () =>
      json(200, {
        publicUrl: 'https://canonical.example',
        slotSnippetsEnabled: enabled,
        signIn: { email: true, google: false, microsoft: false },
      }),
    'GET /api/v1/schedules': () => json(200, { data: [schedule()] }),
    'GET /api/v1/event-type-hosts': () =>
      json(200, { data: [{ id: me.user.id, name: me.user.name }], nextAfter: null }),
    [`GET /api/v1/event-types/${EVENT_TYPE_ID}`]: () => json(200, event),
    'GET /api/auth/organization/get-active-member': () =>
      json(200, {
        id: 'member',
        organizationId: me.organization.id,
        userId: me.user.id,
        role,
      }),
    'GET /api/v1/public/ada/intro-call/slots': () => json(200, { data: [] }),
    'GET /api/v1/public/teams/design-team/intro-call/slots': () => json(200, { data: [] }),
    ...overrides,
  })
}

async function open() {
  renderApp(`/app/event-types/${EVENT_TYPE_ID}`)
  await screen.findByRole('heading', { name: 'Edit “Intro call”', level: 1 })
  await act(async () => {})
}

describe('saved event picker entry', () => {
  it('keeps the entry off until explicitly enabled', async () => {
    setup({ enabled: false })
    await open()
    expect(screen.queryByRole('button', { name: 'Pick open times' })).toBeNull()
  })

  it('does not expose the entry when the capability is unknown or unavailable', async () => {
    let calls = 0
    setup({
      overrides: {
        'GET /api/v1/instance': () =>
          ++calls === 1
            ? json(200, { publicUrl: 'https://canonical.example', slotSnippetsEnabled: true })
            : json(503, { error: 'unavailable' }),
      },
    })
    await open()
    expect(screen.queryByRole('button', { name: 'Pick open times' })).toBeNull()
  })

  it('opens from a personal owner saved view and excludes unsaved title and slug', async () => {
    const user = userEvent.setup()
    const api = setup()
    await open()
    const title = screen.getByLabelText('Title', { exact: true })
    await user.clear(title)
    await user.type(title, 'Unsaved private title')
    const slug = screen.getByLabelText('Booking link', { exact: true })
    await user.clear(slug)
    await user.type(slug, 'unsaved-address')
    await user.click(await screen.findByRole('button', { name: 'Pick open times' }))
    await screen.findByRole('heading', { name: 'Copy open times into an email' })
    await screen.findByText('No times are offered on this date.')
    expect(api.to('GET /api/v1/public/ada/intro-call/slots')).toHaveLength(1)
    expect(api.calls.some((call) => call.path.includes('unsaved-address'))).toBe(false)
    expect(
      screen.getByText(
        'Choose 1–10 alternatives from the saved event type. Unsaved changes are not included.',
      ),
    ).toBeDefined()
  })

  it('allows sharing hidden saved events with the forwarding warning', async () => {
    const user = userEvent.setup()
    setup({ event: eventType({ isHidden: true }) })
    await open()
    await user.click(await screen.findByRole('button', { name: 'Pick open times' }))
    await screen.findByText(
      'This event type is unlisted. Anyone receiving or forwarding these links may open and book it.',
    )
  })

  it.each(['owner', 'admin'])('offers team picker only to a checked %s', async (role) => {
    setup({ me: team, event: eventType({ ownerUserId: null }), role })
    await open()
    await screen.findByRole('button', { name: 'Pick open times' })
  })

  it('denies an ordinary member who hosts the team event', async () => {
    setup({ me: team, event: eventType({ ownerUserId: null }), role: 'member' })
    await open()
    await screen.findByText('Member', { selector: '.space-role' })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Pick open times' })).toBeNull(),
    )
  })

  it('excludes an unsaved new event', async () => {
    setup()
    renderApp('/app/event-types/new')
    await screen.findByRole('heading', { name: 'New event type', level: 1 })
    expect(screen.queryByRole('button', { name: 'Pick open times' })).toBeNull()
  })

  it('does not advertise disabled saved events', async () => {
    setup({ event: eventType({ isActive: false }) })
    await open()
    expect(screen.queryByRole('button', { name: 'Pick open times' })).toBeNull()
  })
})
