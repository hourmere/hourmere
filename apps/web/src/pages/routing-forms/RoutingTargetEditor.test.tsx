import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import type { FieldErrors } from '../../components/forms.tsx'
import '../../i18n/admin.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { routingFormPath } from '../../paths.ts'
import { fakeApi, json, later, ME, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { RoutingTargetEditor } from './RoutingTargetEditor.tsx'
import { useRoutingTargetEvents } from './routing-target-events.ts'

type Target = Schemas['RoutingForm']['fallback']
const uuid = (number: number) => `00000000-0000-4000-9000-${String(number).padStart(12, '0')}`
const team = uuid(1)
const otherTeam = uuid(2)
const smallOption = { id: uuid(4), label: 'Small team' }
const largeOption = { id: uuid(5), label: 'Large team' }
const size = {
  id: uuid(3),
  label: 'Company size',
  required: true,
  type: 'select',
  options: [smallOption, largeOption],
} satisfies Schemas['RoutingForm']['questions'][number]
const contact = { id: uuid(6), label: 'Work email', required: true, type: 'email' } as const
const questions = [size, contact]
const janeEvent = {
  id: uuid(7),
  organizationId: team,
  ownerUserId: null,
  schedulingType: 'individual',
  bookingMode: 'individual',
  isActive: true,
  isHidden: true,
  hosts: [{ userId: uuid(8) }],
  title: 'Consultation',
  slug: 'jane-consultation',
  questions: [
    { id: 'size', type: 'select', label: 'Team size', required: true, options: ['Small', 'Large'] },
    { id: 'phone', type: 'phone', label: 'Phone', required: true },
    { id: 'notes', type: 'long_text', label: 'Notes', required: false },
  ],
} satisfies Partial<Schemas['EventType']>
const samEvent = {
  ...janeEvent,
  id: uuid(9),
  isHidden: false,
  slug: 'sam-consultation',
  hosts: [{ userId: uuid(10) }],
}
const list = 'GET /api/v1/event-types'
const jane = `${list}/${janeEvent.id}`
const sam = `${list}/${samEvent.id}`
const event = { kind: 'event', eventTypeId: janeEvent.id, mappings: [] } satisfies Target
const message = { kind: 'message', message: 'Contact us' } satisfies Target

function Editor({
  initial,
  organizationId = team,
  errors = {},
  onChange,
}: {
  initial: Target
  organizationId?: string
  errors?: FieldErrors
  onChange: (target: Target) => void
}) {
  const [target, setTarget] = useState(initial)
  const events = useRoutingTargetEvents(organizationId, null, [target])
  return (
    <InterfaceScope surface="admin">
      <RoutingTargetEditor
        events={events}
        target={target}
        questions={questions}
        path="fallback"
        errors={errors}
        onChange={(next) => {
          setTarget(next)
          onChange(next)
        }}
      />
    </InterfaceScope>
  )
}

describe('Routing destinations and mappings', () => {
  it('loads eligible team events lazily and selects each member’s single-host event by its stable ID', async () => {
    const api = fakeApi({
      [list]: () =>
        json(200, {
          data: [
            janeEvent,
            samEvent,
            { ...janeEvent, id: uuid(11), title: 'Inactive', isActive: false },
            { ...janeEvent, id: uuid(12), title: 'Group', bookingMode: 'group' },
            { ...janeEvent, id: uuid(13), title: 'Personal event', ownerUserId: uuid(8) },
          ],
        }),
      [jane]: () => json(200, janeEvent),
      [sam]: () => json(200, samEvent),
    })
    const changes = vi.fn<(target: Target) => void>()
    render(<Editor initial={message} onChange={changes} />)
    expect(screen.getByRole('textbox', { name: 'Message to show' })).toBeTruthy()
    expect(api.calls).toEqual([])

    const user = userEvent.setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Destination type' }), 'event')
    const picker = await screen.findByRole('combobox', { name: 'Event type' })
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Choose an event type',
      'Consultation (jane-consultation) (hidden)',
      'Consultation (sam-consultation)',
    ])
    expect(api.calls.map(({ path }) => path)).toEqual(['/api/v1/event-types'])
    await user.selectOptions(picker, janeEvent.id)
    await screen.findByRole('group', { name: 'Answer mappings' })
    expect(changes).toHaveBeenLastCalledWith(event)
    expect(api.to(jane)).toHaveLength(1)

    await user.selectOptions(picker, samEvent.id)
    await screen.findByRole('group', { name: 'Answer mappings' })
    expect(changes).toHaveBeenLastCalledWith({ ...event, eventTypeId: samEvent.id })
    expect(api.to(sam)).toHaveLength(1)
    expect(api.to(list)).toHaveLength(1)
  })

  it('repairs a stale option using current booking options and prevents duplicate or incompatible destinations', async () => {
    fakeApi({
      [list]: () => json(200, { data: [janeEvent] }),
      [jane]: () => json(200, janeEvent),
    })
    const mapping = {
      questionId: size.id,
      destination: { kind: 'question', questionId: 'size' },
      options: { [smallOption.id]: 'Old small', [largeOption.id]: 'Large' },
    } satisfies Extract<Target, { kind: 'event' }>['mappings'][number]
    const changes = vi.fn<(target: Target) => void>()
    render(<Editor initial={{ ...event, mappings: [mapping] }} onChange={changes} />)
    const stale = 'Choose a current booking option for each routing option.'
    await screen.findByText(stale)
    const user = userEvent.setup()
    const small = screen.getByRole('combobox', { name: 'Booking option for “Small team”' })
    expect(small.getAttribute('aria-describedby')).toBe('fallback.mappings.0.options-error')
    expect(
      within(small).getByRole('option', { name: 'Previous booking option unavailable' }),
    ).toBeTruthy()
    await user.selectOptions(small, 'Small')
    expect(screen.queryByText(stale)).toBeNull()
    const repaired = { ...mapping, options: { ...mapping.options, [smallOption.id]: 'Small' } }
    expect(changes).toHaveBeenLastCalledWith({ ...event, mappings: [repaired] })

    await user.click(screen.getByRole('button', { name: 'Add an answer mapping' }))
    const second = within(screen.getByRole('group', { name: 'Answer mapping 2' }))
    const source = second.getByRole('combobox', { name: 'Routing question' })
    const destination = second.getByRole('combobox', { name: 'Booking field' })
    expect(document.activeElement).toBe(source)
    await user.selectOptions(source, size.id)
    expect(within(destination).getAllByRole('option')).toHaveLength(1)
    await user.selectOptions(source, contact.id)
    expect(
      within(destination)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose a booking field', 'Invitee email', 'Notes'])
    await user.selectOptions(destination, 'inviteeEmail')
    expect(changes).toHaveBeenLastCalledWith({
      ...event,
      mappings: [repaired, { questionId: contact.id, destination: { kind: 'inviteeEmail' } }],
    })
    await user.click(second.getByRole('button', { name: 'Remove answer mapping 2' }))
    expect(changes).toHaveBeenLastCalledWith({ ...event, mappings: [repaired] })
  })

  it('shows neutral list loading and denied states even for a saved event destination', async () => {
    const pending = later()
    const api = fakeApi({ [list]: () => pending.response })
    const field = 'fallback.mappings.0.options'
    const message = 'Choose a current booking option for each routing option.'
    render(<Editor initial={event} errors={{ [field]: message }} onChange={vi.fn()} />)
    expect(screen.getByTestId('routing-event-types-loading').textContent).toContain(
      'Loading event types…',
    )
    await pending.answer(json(403, { error: 'team_management_access_denied' }))
    expect(await screen.findByTestId('routing-event-types-denied')).toBeTruthy()
    expect(screen.queryByTestId('routing-event-types-empty')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Answer mappings' })).toBeNull()
    const error = screen.getByText(message)
    expect(error.id).toBe(`${field}-error`)
    error.focus()
    expect(document.activeElement).toBe(error)
    expect(api.calls).toHaveLength(1)
  })

  it('removes mappings for deleted routing options while preserving the remaining crosswalk', async () => {
    fakeApi({
      [list]: () => json(200, { data: [janeEvent] }),
      [jane]: () => json(200, janeEvent),
    })
    const mapping = {
      questionId: size.id,
      destination: { kind: 'question', questionId: 'size' },
      options: { [smallOption.id]: 'Small', [largeOption.id]: 'Large' },
    } satisfies Extract<Target, { kind: 'event' }>['mappings'][number]
    const changes = vi.fn<(target: Target) => void>()
    render(
      <Editor
        initial={{
          ...event,
          mappings: [{ ...mapping, options: { ...mapping.options, [uuid(20)]: 'Large' } }],
        }}
        onChange={changes}
      />,
    )
    const remove = await screen.findByRole('button', { name: 'Remove obsolete option mappings' })
    remove.focus()
    await userEvent.setup().keyboard('{Enter}')
    expect(changes).toHaveBeenLastCalledWith({ ...event, mappings: [mapping] })
    expect(screen.queryByRole('button', { name: 'Remove obsolete option mappings' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Routing question' }))
  })

  it('distinguishes booking field errors from missing configuration and can retry', async () => {
    const pending = later()
    let first = true
    fakeApi({
      [list]: () => json(200, { data: [janeEvent] }),
      [jane]: () => {
        if (!first) return json(200, janeEvent)
        first = false
        return pending.response
      },
    })
    render(<Editor initial={event} onChange={vi.fn()} />)
    expect(await screen.findByTestId('routing-booking-fields-loading')).toBeTruthy()
    await pending.answer(json(503, { error: 'service_unavailable' }))
    expect(await screen.findByText('Could not load booking fields.')).toBeTruthy()
    expect(screen.queryByText('This event type is unavailable.')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByTestId('routing-answer-mappings')).toBeTruthy()
  })

  it('never offers an event or booking field from a different active team', async () => {
    const detailResponse = later()
    const { to } = fakeApi({
      [list]: () => json(200, { data: [janeEvent] }),
      [jane]: () => detailResponse.response,
    })
    const onChange = vi.fn<(target: Target) => void>()
    const ui = render(<Editor initial={event} onChange={onChange} />)
    await screen.findByTestId('routing-booking-fields-loading')
    await waitFor(() => expect(to(jane)).toHaveLength(1))
    await detailResponse.answer(json(200, { ...janeEvent, organizationId: otherTeam }))
    expect(await screen.findByTestId('routing-booking-fields-context')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Answer mappings' })).toBeNull()

    ui.rerender(<Editor initial={event} organizationId={otherTeam} onChange={onChange} />)
    expect(screen.queryByRole('combobox', { name: 'Event type' })).toBeNull()
    expect(await screen.findByTestId('routing-event-types-context')).toBeTruthy()
    expect(to(jane)).toHaveLength(1)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('saves a complete option mapping with its hidden target and the current team revision', async () => {
    const form: Schemas['RoutingForm'] = {
      id: uuid(21),
      title: 'Consultation requests',
      slug: 'consultation-requests',
      description: null,
      questions,
      rules: [],
      fallback: event,
      draftRevision: 8,
      enabled: false,
      publishedVersionId: null,
      publishedVersionNumber: null,
      health: null,
      createdAt: '2026-11-01T09:00:00Z',
      updatedAt: '2026-11-01T09:00:00Z',
    }
    const path = `/api/v1/routing-forms/${form.id}`
    const api = fakeApi({
      ...signedInAs({
        ...ME,
        organization: { id: team, name: 'Consulting', slug: 'consulting', personal: false },
      }),
      'GET /api/v1/instance': () => json(200, { routingFormsEnabled: true }),
      [`GET ${path}`]: () => json(200, form),
      [list]: () => json(200, { data: [janeEvent] }),
      [jane]: () => json(200, janeEvent),
      [`PATCH ${path}`]: ({ body }) =>
        json(200, { ...form, ...(body as Schemas['UpdateRoutingForm']), draftRevision: 9 }),
    })
    renderApp(routingFormPath(form.id, team))
    const user = userEvent.setup()
    const fallback = within(await screen.findByRole('region', { name: 'Fallback' }))
    await user.click(await fallback.findByRole('button', { name: 'Add an answer mapping' }))
    await user.selectOptions(fallback.getByRole('combobox', { name: 'Routing question' }), size.id)
    await user.selectOptions(
      fallback.getByRole('combobox', { name: 'Booking field' }),
      'question:size',
    )
    const save = screen.getByRole('button', { name: 'Save draft' })
    await user.click(save)
    expect(screen.getByRole('alert').textContent).toContain(
      'Map every answer option to a booking option.',
    )
    expect(api.to(`PATCH ${path}`)).toHaveLength(0)

    await user.selectOptions(
      fallback.getByRole('combobox', { name: 'Booking option for “Small team”' }),
      'Small',
    )
    await user.selectOptions(
      fallback.getByRole('combobox', { name: 'Booking option for “Large team”' }),
      'Large',
    )
    await user.click(save)
    await screen.findByText('Draft saved.')
    const request = api.to(`PATCH ${path}`)[0]
    expect(request?.headers.get('X-Expected-Organization-Id')).toBe(team)
    expect(request?.body).toMatchObject({
      expectedRevision: form.draftRevision,
      fallback: {
        ...event,
        mappings: [
          {
            questionId: size.id,
            destination: { kind: 'question', questionId: 'size' },
            options: { [smallOption.id]: 'Small', [largeOption.id]: 'Large' },
          },
        ],
      },
    })
  })
})
