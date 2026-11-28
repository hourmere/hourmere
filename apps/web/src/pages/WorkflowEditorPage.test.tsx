import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { assert, describe, expect, it, vi } from 'vitest'
import { api, type Schemas } from '../api/client.ts'
import { PATHS } from '../paths.ts'
import { fakeApi, json, later, ME, renderApp, signedIn, signedInAs } from '../test/fake-api.tsx'
import { EVENT_TYPE_ID, eventType } from '../test/fixtures.ts'

const LIST = '/api/v1/workflows'
const PREVIEW = '/api/v1/workflows/preview'
const WORKFLOW_ID = '00000000-0000-7000-8000-000000000003'
const DETAIL = `${LIST}/${WORKFLOW_ID}`
const CREATE = `${PATHS.workflows}/new`
const EDIT = `${PATHS.workflows}/${WORKFLOW_ID}/edit`
const CREATED = '2026-10-01T09:00:00.000Z'
const team = {
  id: '00000000-0000-7000-8000-000000000004',
  name: 'Design Team',
  slug: 'design',
  personal: false,
}
const english = { subject: 'Your intro call', body: 'See you at your scheduled time.' }
const spanish = { subject: 'Tu llamada', body: 'Gracias por reservar.' }
const personal = { kind: 'personal', id: ME.user.id } as const
const baseDefinition = {
  name: 'Send booking reminder',
  owner: personal,
  scope: { type: 'all_event_types' },
  trigger: { type: 'booking.created', delayMinutes: 0 },
  conditions: [],
  actions: [{ type: 'email', recipients: ['booker'] }],
  enabled: false,
} satisfies Omit<Schemas['CreateWorkflowInput'], 'idempotencyKey'>

const workflow: Schemas['Workflow'] = {
  ...baseDefinition,
  id: WORKFLOW_ID,
  revision: 2,
  createdAt: CREATED,
  updatedAt: CREATED,
}
const matchedPreview: Schemas['WorkflowPreview'] = {
  synthetic: true,
  match: 'matched',
  emails: [
    {
      recipientClass: 'booker',
      locale: 'en',
      templateLocale: 'en',
      contentSource: 'built_in',
      subject: 'Example booking confirmation',
      text: 'Your example booking is confirmed.',
      html: '<p>Your example booking is confirmed.</p>',
    },
  ],
  estimates: { emailRecipientClasses: 1, webhookDeliveriesPerMatch: 0 },
}

const endpoint: Schemas['Webhook'] = {
  id: '00000000-0000-7000-8000-000000000005',
  url: 'https://example.test/workflow',
  organizationId: ME.organization.id,
  events: ['workflow.executed'],
  isActive: true,
  createdAt: CREATED,
  updatedAt: CREATED,
}
const nextEndpoint: Schemas['Webhook'] = {
  ...endpoint,
  id: '00000000-0000-7000-8000-000000000006',
  url: 'https://example.test/updated-workflow',
}
const event = eventType({
  questions: [
    {
      id: 'needs-preparation',
      label: 'Do you need preparation?',
      type: 'checkbox',
      required: false,
    },
  ],
})
const group = eventType({
  id: 'e0000000-0000-7000-8000-000000000002',
  title: 'Group open house',
  bookingMode: 'group',
  groupCapacity: 10,
})

const instanceRoute = (followUpHostNotesEnabled: boolean) => ({
  'GET /api/v1/instance': () =>
    json(200, {
      signIn: { email: true, google: false, microsoft: false },
      workflowsEnabled: true,
      followUpHostNotesEnabled,
    }),
})
const editorRoutes = {
  ...signedIn,
  ...instanceRoute(true),
  'GET /api/v1/event-types': () => json(200, { data: [event, group] }),
}
const listResponse = (data: Schemas['Workflow'][]) => json(200, { data, nextCursor: null })
const main = () => within(screen.getByRole('main'))

async function changeInput(
  user: ReturnType<typeof userEvent.setup>,
  input: HTMLElement,
  value: string,
) {
  await user.clear(input)
  await user.type(input, value)
}

async function addTranslation(
  user: ReturnType<typeof userEvent.setup>,
  language: string,
  content: { subject: string; body: string },
) {
  await user.selectOptions(main().getByRole('combobox', { name: 'Add language' }), language)
  await user.click(main().getByRole('button', { name: 'Add translation' }))
  const fields = within(
    main().getByRole('group', { name: language === 'en' ? 'English' : 'Español' }),
  )
  await user.type(fields.getByRole('textbox', { name: 'Custom subject' }), content.subject)
  await user.type(fields.getByRole('textbox', { name: 'Custom body' }), content.body)
}

describe('workflow editor', () => {
  it('previews a saved team webhook workflow without write or webhook-catalogue permissions', async () => {
    const teamWorkflow: Schemas['Workflow'] = {
      ...workflow,
      owner: { kind: 'team', id: team.id },
      actions: [{ type: 'webhook', webhookId: endpoint.id }],
    }
    const requests = fakeApi({
      ...editorRoutes,
      ...signedInAs({
        ...ME,
        organization: team,
        teamManagementPermissions: ['workflows.read', 'workflows.preview'],
      }),
      ...instanceRoute(true),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: team.id, userId: ME.user.id, role: 'member' }),
      [`GET ${DETAIL}`]: () => json(200, teamWorkflow),
      [`POST ${PREVIEW}`]: () =>
        json(200, {
          ...matchedPreview,
          emails: [],
          estimates: { emailRecipientClasses: 0, webhookDeliveriesPerMatch: 1 },
        }),
    })
    renderApp(EDIT)
    const name = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Workflow name' })
    expect(name.value).toBe(teamWorkflow.name)
    expect(main().queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(main().getByText(endpoint.id)).toBeTruthy()
    assert(name.form)
    fireEvent.submit(name.form)
    expect(requests.to(`PATCH ${DETAIL}`)).toHaveLength(0)

    await userEvent.click(main().getByRole('button', { name: 'Preview workflow' }))
    expect(await main().findByText('The example booking matches this workflow.')).toBeTruthy()
    expect(requests.to(`POST ${PREVIEW}`).map(({ body }) => body)).toEqual([
      expect.objectContaining({ owner: teamWorkflow.owner, actions: teamWorkflow.actions }),
    ])
    expect(requests.to('GET /api/v1/webhooks')).toHaveLength(0)
  })

  it('renders a saved workflow as read only when the Member lacks preview and write grants', async () => {
    const teamWorkflow: Schemas['Workflow'] = {
      ...workflow,
      owner: { kind: 'team', id: team.id },
    }
    fakeApi({
      ...editorRoutes,
      ...signedInAs({
        ...ME,
        organization: team,
        teamManagementPermissions: ['workflows.read'],
      }),
      ...instanceRoute(true),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: team.id, userId: ME.user.id, role: 'member' }),
      [`GET ${DETAIL}`]: () => json(200, teamWorkflow),
    })
    renderApp(EDIT)
    const name = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Workflow name' })
    expect(name.value).toBe(teamWorkflow.name)
    expect(name.closest('fieldset')?.disabled).toBe(true)
    expect(main().queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(main().queryByRole('button', { name: 'Preview workflow' })).toBeNull()
  })
  it('retains the creation key after an unconfirmed save and draft changes', async () => {
    let attempts = 0
    const requests = fakeApi({
      ...editorRoutes,
      [`POST ${LIST}`]: () =>
        ++attempts === 1
          ? json(500, { error: 'internal_error' })
          : json(409, { error: 'idempotency_key_reused' }),
    })
    const user = userEvent.setup()
    renderApp(CREATE)
    const name = await screen.findByRole('textbox', { name: 'Workflow name' })
    await user.type(name, 'Follow-up')
    await user.keyboard('{Enter}')
    await screen.findByText('Could not save the workflow. Try again.')

    await user.type(name, ' email')
    await user.click(main().getByRole('button', { name: 'Create workflow' }))
    await screen.findByText(
      'A workflow may already have been saved. Check the workflow list before creating another.',
    )
    const bodies = requests
      .to(`POST ${LIST}`)
      .map(({ body }) => body as Schemas['CreateWorkflowInput'])
    expect(bodies.map(({ name }) => name)).toEqual(['Follow-up', 'Follow-up email'])
    expect(bodies[0]?.idempotencyKey).toMatch(/^[0-9a-f]{32}$/)
    expect(bodies[1]?.idempotencyKey).toBe(bodies[0]?.idempotencyKey)
  })

  it('creates a scoped email workflow through the generated client', async () => {
    let saved: Schemas['Workflow'] | undefined
    const requests = fakeApi({
      ...editorRoutes,
      [`GET ${LIST}`]: () => listResponse(saved ? [saved] : []),
      [`POST ${LIST}`]: ({ body }) => {
        saved = { ...workflow, ...(body as Schemas['CreateWorkflowInput']) }
        return json(201, saved)
      },
    })
    const post = vi.spyOn(api, 'POST')
    const user = userEvent.setup()
    renderApp(PATHS.workflows)

    await user.click(await screen.findByRole('link', { name: 'New workflow' }))
    await user.type(await screen.findByRole('textbox', { name: 'Workflow name' }), 'Intro reminder')
    await user.selectOptions(main().getByRole('combobox', { name: 'Applies to' }), 'event_type')
    const eventPicker = main().getByRole('combobox', { name: 'Event type' })
    expect(within(eventPicker).queryByRole('option', { name: group.title })).toBeNull()
    await user.selectOptions(eventPicker, EVENT_TYPE_ID)
    await user.selectOptions(main().getByRole('combobox', { name: 'Trigger' }), 'before_start')
    await changeInput(user, main().getByRole('spinbutton', { name: 'Offset (minutes)' }), '45')

    await user.click(main().getByRole('button', { name: 'Add condition' }))
    await user.selectOptions(
      main().getByRole('combobox', { name: 'Condition type' }),
      'guest_count',
    )
    await user.selectOptions(main().getByRole('combobox', { name: 'Comparison' }), 'at_least')
    await changeInput(user, main().getByRole('spinbutton', { name: 'Guest count' }), '2')
    await user.click(main().getByRole('button', { name: 'Add condition' }))
    const answer = within(main().getByRole('group', { name: 'Condition 2' }))
    const conditionType = answer.getByRole('combobox', { name: 'Condition type' })
    expect(document.activeElement).toBe(conditionType)
    await user.selectOptions(conditionType, 'answer')
    await user.selectOptions(
      answer.getByRole('combobox', { name: 'Question' }),
      'needs-preparation',
    )
    await user.selectOptions(answer.getByRole('combobox', { name: 'Answer' }), 'false')
    await user.click(main().getByRole('checkbox', { name: 'Hosts' }))
    await addTranslation(user, 'en', english)
    await addTranslation(user, 'es', spanish)

    const create = main().getByRole('button', { name: 'Create workflow' })
    create.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('heading', { name: 'Intro reminder' })).toBeTruthy()

    const [request] = requests.to(`POST ${LIST}`)
    expect(request?.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
    expect(request?.body).toEqual({
      ...baseDefinition,
      name: 'Intro reminder',
      scope: { type: 'event_type', eventTypeId: EVENT_TYPE_ID },
      trigger: { type: 'before_start', offsetMinutes: 45 },
      conditions: [
        { field: 'guest_count', operator: 'at_least', value: 2 },
        { field: 'answer', operator: 'equals', questionId: 'needs-preparation', value: false },
      ],
      actions: [
        { type: 'email', recipients: ['booker', 'hosts'], content: { en: english, es: spanish } },
      ],
      idempotencyKey: expect.any(String),
    })
    expect(post).toHaveBeenCalledExactlyOnceWith(LIST, expect.anything())
    expect(requests.to('GET /api/v1/instance')).toHaveLength(1)
  })

  it('loads and edits the saved email fields without modifying its live enabled flag', async () => {
    let current: Schemas['Workflow'] = {
      ...workflow,
      enabled: true,
      scope: { type: 'event_type', eventTypeId: EVENT_TYPE_ID },
      trigger: { type: 'before_start', offsetMinutes: 30 },
      conditions: [{ field: 'guest_count', operator: 'at_least', value: 1 }],
      actions: [{ type: 'email', recipients: ['booker', 'hosts'], content: { en: english } }],
    }
    const requests = fakeApi({
      ...editorRoutes,
      [`GET ${LIST}`]: () => listResponse([current]),
      [`GET ${DETAIL}`]: () => json(200, current),
      [`PATCH ${DETAIL}`]: ({ body }) => {
        current = { ...current, ...(body as Schemas['UpdateWorkflowInput']), revision: 3 }
        return json(200, current)
      },
    })
    const patch = vi.spyOn(api, 'PATCH')
    const user = userEvent.setup()
    renderApp(PATHS.workflows)
    await user.click(await screen.findByRole('link', { name: `Edit ${workflow.name}` }))

    const name = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Workflow name' })
    expect(name.value).toBe(workflow.name)
    expect(main().getByRole<HTMLSelectElement>('combobox', { name: 'Applies to' }).value).toBe(
      'event_type',
    )
    expect(main().getByRole<HTMLSelectElement>('combobox', { name: 'Event type' }).value).toBe(
      EVENT_TYPE_ID,
    )
    expect(
      main().getByRole<HTMLInputElement>('spinbutton', { name: 'Offset (minutes)' }).value,
    ).toBe('30')
    expect(main().getByRole<HTMLInputElement>('checkbox', { name: 'Hosts' }).checked).toBe(true)
    const subject = main().getByRole<HTMLInputElement>('textbox', { name: 'Custom subject' })
    const body = main().getByRole<HTMLTextAreaElement>('textbox', { name: 'Custom body' })
    expect(subject.value).toBe(english.subject)
    expect(body.value).toBe(english.body)
    await changeInput(user, name, 'Updated reminder')
    await user.selectOptions(
      main().getByRole('combobox', { name: 'Applies to' }),
      'all_event_types',
    )
    await user.selectOptions(
      main().getByRole('combobox', { name: 'Trigger' }),
      'booking.rescheduled',
    )
    await changeInput(user, main().getByRole('spinbutton', { name: 'Delay (minutes)' }), '20')
    await user.selectOptions(
      main().getByRole('combobox', { name: 'Condition type' }),
      'booking_source',
    )
    await user.selectOptions(main().getByRole('combobox', { name: 'Booking source' }), 'api')
    await user.click(main().getByRole('checkbox', { name: 'Hosts' }))
    await user.click(main().getByRole('checkbox', { name: 'Guests' }))
    await changeInput(user, subject, 'New time')
    await changeInput(user, body, 'Your new booking time.')
    await user.click(main().getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('heading', { name: 'Updated reminder' })).toBeTruthy()

    const [request] = requests.to(`PATCH ${DETAIL}`)
    expect(request?.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
    expect(request?.body).toEqual({
      expectedRevision: 2,
      name: 'Updated reminder',
      scope: { type: 'all_event_types' },
      trigger: { type: 'booking.rescheduled', delayMinutes: 20 },
      conditions: [{ field: 'booking_source', operator: 'equals', value: 'api' }],
      actions: [
        {
          type: 'email',
          recipients: ['booker', 'guests'],
          content: { en: { subject: 'New time', body: 'Your new booking time.' } },
        },
      ],
    })
    expect(patch).toHaveBeenCalledExactlyOnceWith('/api/v1/workflows/{id}', expect.anything())
  })

  it('picks an eligible webhook endpoint on create and changes it on edit', async () => {
    let current: Schemas['Workflow'] | undefined
    const unavailable: Schemas['Webhook'][] = [
      {
        ...endpoint,
        id: '00000000-0000-7000-8000-000000000007',
        url: 'https://example.test/paused',
        isActive: false,
      },
      {
        ...endpoint,
        id: '00000000-0000-7000-8000-000000000008',
        url: 'https://example.test/foreign',
        organizationId: team.id,
      },
      {
        ...endpoint,
        id: '00000000-0000-7000-8000-000000000009',
        url: 'https://example.test/booking-only',
        events: ['booking.created'],
      },
    ]
    const requests = fakeApi({
      ...editorRoutes,
      'GET /api/v1/webhooks': () => json(200, [endpoint, ...unavailable, nextEndpoint]),
      [`GET ${LIST}`]: () => listResponse(current ? [current] : []),
      [`GET ${DETAIL}`]: () => json(200, current),
      [`POST ${LIST}`]: ({ body }) => {
        current = { ...workflow, ...(body as Schemas['CreateWorkflowInput']), revision: 1 }
        return json(201, current)
      },
      [`PATCH ${DETAIL}`]: ({ body }) => {
        current = {
          ...(current ?? workflow),
          ...(body as Schemas['UpdateWorkflowInput']),
          revision: 2,
        }
        return json(200, current)
      },
    })
    const user = userEvent.setup()
    renderApp(CREATE)
    await user.type(await screen.findByRole('textbox', { name: 'Workflow name' }), 'Notify CRM')
    expect(requests.to('GET /api/v1/webhooks')).toHaveLength(0)
    await user.selectOptions(main().getByRole('combobox', { name: 'Action' }), 'webhook')
    const choice = await screen.findByRole('combobox', { name: 'Webhook endpoint' })
    await within(choice).findByRole('option', { name: endpoint.url })
    for (const hook of unavailable) {
      expect(within(choice).queryByRole('option', { name: hook.url })).toBeNull()
    }
    await user.selectOptions(choice, endpoint.id)
    expect(main().queryByRole('checkbox', { name: 'Booker' })).toBeNull()
    await user.click(main().getByRole('button', { name: 'Create workflow' }))
    await user.click(await screen.findByRole('link', { name: 'Edit Notify CRM' }))

    await screen.findByRole('heading', { name: 'Edit workflow' })
    const savedChoice = await screen.findByRole<HTMLSelectElement>('combobox', {
      name: 'Webhook endpoint',
    })
    await within(savedChoice).findByRole('option', { name: nextEndpoint.url })
    expect(savedChoice.value).toBe(endpoint.id)
    await user.selectOptions(savedChoice, nextEndpoint.id)
    await user.click(main().getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('heading', { name: 'Notify CRM' })).toBeTruthy()
    expect(requests.to(`POST ${LIST}`).map(({ body }) => body)).toEqual([
      expect.objectContaining({ actions: [{ type: 'webhook', webhookId: endpoint.id }] }),
    ])
    expect(requests.to(`PATCH ${DETAIL}`).map(({ body }) => body)).toEqual([
      expect.objectContaining({
        expectedRevision: 1,
        actions: [{ type: 'webhook', webhookId: nextEndpoint.id }],
      }),
    ])
  })

  it('hides saved custom subject and body when host notes are off and previews built-in text', async () => {
    const requests = fakeApi({
      ...editorRoutes,
      ...instanceRoute(false),
      [`GET ${LIST}`]: () => listResponse([workflow]),
      [`GET ${DETAIL}`]: () =>
        json(200, {
          ...workflow,
          actions: [{ type: 'email', recipients: ['booker'], content: { en: english } }],
        }),
      [`POST ${PREVIEW}`]: () => json(200, matchedPreview),
      [`PATCH ${DETAIL}`]: () => json(200, workflow),
      'GET /api/v1/webhooks': () => json(200, [endpoint]),
    })
    const user = userEvent.setup()
    renderApp(EDIT)
    await screen.findByRole('textbox', { name: 'Workflow name' })

    expect(main().queryByRole('textbox', { name: 'Custom subject' })).toBeNull()
    expect(main().queryByRole('textbox', { name: 'Custom body' })).toBeNull()
    expect(main().queryByRole('button', { name: 'Add translation' })).toBeNull()
    expect(main().queryByDisplayValue(english.subject)).toBeNull()
    expect(main().queryByDisplayValue(english.body)).toBeNull()
    const action = main().getByRole('combobox', { name: 'Action' })
    await user.selectOptions(action, 'webhook')
    await screen.findByRole('option', { name: endpoint.url })
    await user.selectOptions(action, 'email')
    await user.click(main().getByRole('button', { name: 'Preview workflow' }))
    await screen.findByText('The example booking matches this workflow.')
    expect(main().getByText('Example booking confirmation')).toBeTruthy()
    expect(requests.to(`POST ${PREVIEW}`).map(({ body }) => body)).toEqual([
      expect.objectContaining({ actions: [{ type: 'email', recipients: ['booker'] }] }),
    ])
    const save = main().getByRole<HTMLButtonElement>('button', { name: 'Save changes' })
    expect(save.disabled).toBe(true)
    expect(requests.to(`PATCH ${DETAIL}`)).toHaveLength(0)
    await user.click(
      main().getByRole('checkbox', { name: 'Replace saved custom text with built-in text' }),
    )
    await user.click(save)
    await screen.findByRole('heading', { name: workflow.name })
    expect(requests.to(`PATCH ${DETAIL}`).map(({ body }) => body)).toEqual([
      expect.objectContaining({
        expectedRevision: 2,
        actions: [{ type: 'email', recipients: ['booker'] }],
      }),
    ])
    expect(requests.to('GET /api/v1/instance')).toHaveLength(1)
  })

  it('previews rendered text, fallback and skip reasons through the generated client', async () => {
    const pending = later()
    const emails: Schemas['WorkflowPreview']['emails'] = [
      {
        recipientClass: 'booker',
        locale: 'zh-CN',
        templateLocale: 'en',
        contentSource: 'built_in',
        fallback: 'missing_translation',
        subject: 'Your booking reminder',
        text: 'Hello <example>. Your booking begins at 15:00.',
        html: '<strong>HTML representation</strong>',
      },
    ]
    const estimates = { emailRecipientClasses: 1, webhookDeliveriesPerMatch: 0 }
    let previews = 0
    const requests = fakeApi({
      ...editorRoutes,
      [`GET ${DETAIL}`]: () =>
        json(200, {
          ...workflow,
          actions: [{ type: 'email', recipients: ['booker'], content: { en: english } }],
        }),
      [`POST ${PREVIEW}`]: () =>
        ++previews === 1
          ? pending.response
          : json(200, { synthetic: true, match: 'scope_mismatch', emails, estimates }),
    })
    const post = vi.spyOn(api, 'POST')
    const user = userEvent.setup()
    renderApp(EDIT)
    await screen.findByRole('textbox', { name: 'Workflow name' })
    await user.selectOptions(main().getByRole('combobox', { name: 'Preview language' }), 'zh-CN')
    await user.click(main().getByRole('button', { name: 'Preview workflow' }))
    await screen.findByText('Generating preview…')
    expect(main().queryByText(emails[0]?.subject ?? '')).toBeNull()
    await pending.answer(
      json(200, { synthetic: true, match: 'condition_false', emails, estimates }),
    )

    expect(
      await screen.findByText(
        'Skipped: the example booking does not meet the workflow conditions.',
      ),
    ).toBeTruthy()
    expect(main().getByText('Your booking reminder')).toBeTruthy()
    expect(main().getByText('Hello <example>. Your booking begins at 15:00.')).toBeTruthy()
    expect(main().queryByText('HTML representation')).toBeNull()
    expect(
      main().getByText('Built-in text is used because a custom translation is missing.'),
    ).toBeTruthy()
    expect(
      main().getByText('Requested language: 简体中文. Template language: English.'),
    ).toBeTruthy()
    await user.selectOptions(
      main().getByRole('combobox', { name: 'Preview event type' }),
      EVENT_TYPE_ID,
    )
    await user.click(main().getByRole('button', { name: 'Preview workflow' }))
    expect(
      await screen.findByText('Skipped: the example booking is outside the workflow scope.'),
    ).toBeTruthy()

    const [first, second] = requests.to(`POST ${PREVIEW}`)
    expect(first?.headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)
    expect(first?.body).toEqual({
      name: workflow.name,
      owner: personal,
      scope: workflow.scope,
      trigger: workflow.trigger,
      conditions: [],
      actions: [{ type: 'email', recipients: ['booker'], content: { en: english } }],
      example: { locale: 'zh-CN' },
    })
    expect(second?.body).toMatchObject({ example: { locale: 'zh-CN', eventTypeId: EVENT_TYPE_ID } })
    expect(post).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenNthCalledWith(1, PREVIEW, expect.anything())
    expect(post).toHaveBeenNthCalledWith(2, PREVIEW, expect.anything())
    expect(requests.to(`POST ${LIST}`)).toHaveLength(0)
    expect(requests.to(`PATCH ${DETAIL}`)).toHaveLength(0)
  })

  it('blocks a stale write until the person reloads the latest revision', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    let current = workflow
    const requests = fakeApi({
      ...editorRoutes,
      [`GET ${LIST}`]: () => listResponse([current]),
      [`GET ${DETAIL}`]: () => json(200, current),
      [`PATCH ${DETAIL}`]: ({ body }) => {
        const update = body as Schemas['UpdateWorkflowInput']
        if (update.expectedRevision === 2) {
          current = { ...current, revision: 3, name: 'Edited elsewhere' }
          return json(409, { error: 'workflow_revision_conflict', message: 'Internal detail' })
        }
        current = { ...current, ...update, revision: 4 }
        return json(200, current)
      },
    })
    const user = userEvent.setup()
    renderApp(EDIT)
    const name = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Workflow name' })
    await changeInput(user, name, 'My edits')
    await user.click(main().getByRole('button', { name: 'Save changes' }))
    expect(
      await screen.findByText(
        'This workflow changed. Review the latest version before trying again.',
      ),
    ).toBeTruthy()
    expect(main().queryByText('Internal detail')).toBeNull()
    expect(name.value).toBe('My edits')
    const save = main().queryByRole<HTMLButtonElement>('button', { name: 'Save changes' })
    if (save) await user.click(save)
    expect(requests.to(`PATCH ${DETAIL}`)).toHaveLength(1)

    await user.click(main().getByRole('button', { name: 'Reload workflow' }))
    await screen.findByDisplayValue('Edited elsewhere')
    await changeInput(
      user,
      main().getByRole('textbox', { name: 'Workflow name' }),
      'Reviewed update',
    )
    await user.click(main().getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('heading', { name: 'Reviewed update' })).toBeTruthy()
    expect(requests.to(`PATCH ${DETAIL}`).map(({ body }) => body)).toEqual([
      expect.objectContaining({ expectedRevision: 2, name: 'My edits' }),
      expect.objectContaining({ expectedRevision: 3, name: 'Reviewed update' }),
    ])
  })

  it.each([403, 500])(
    'keeps loading and a %i response neutral in the edit route',
    async (status) => {
      const pending = later()
      fakeApi({
        ...editorRoutes,
        [`GET ${DETAIL}`]: () => pending.response,
      })
      renderApp(EDIT)
      await screen.findByRole('status', { name: 'Loading workflow editor…' })
      expect(main().queryByRole('textbox', { name: 'Workflow name' })).toBeNull()
      await pending.answer(json(status, { error: 'denied', message: 'Internal detail' }))
      const message =
        status === 403 ? 'This workflow is unavailable.' : 'Could not load the workflow editor.'
      expect(await screen.findByText(message)).toBeTruthy()
      expect(main().queryByText('Internal detail')).toBeNull()
      expect(main().queryByRole('textbox', { name: 'Workflow name' })).toBeNull()
      expect(main().queryByRole('button', { name: 'Save changes' })).toBeNull()
    },
  )
})

describe('workflow editor access', () => {
  it.each([
    { path: CREATE, flag: false },
    { path: EDIT, flag: undefined },
  ])('keeps $path hidden while workflow discovery is pending and off', async ({ path, flag }) => {
    const discovery = later()
    const requests = fakeApi({
      ...signedIn,
      'GET /api/v1/instance': () => discovery.response,
    })
    renderApp(path)
    await waitFor(() => expect(requests.to('GET /api/v1/instance')).toHaveLength(1))
    await screen.findByRole('status', { name: 'Loading…' })
    expect(screen.queryByRole('link', { name: 'Workflows' })).toBeNull()
    await discovery.answer(json(200, { workflowsEnabled: flag, followUpHostNotesEnabled: true }))
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Workflows' })).toBeNull()
    expect(main().queryByRole('textbox', { name: 'Workflow name' })).toBeNull()
    expect(requests.to('GET /api/v1/instance')).toHaveLength(1)
    expect(requests.to('GET /api/v1/event-types')).toHaveLength(0)
    expect(requests.to('GET /api/v1/webhooks')).toHaveLength(0)
    expect(requests.calls.filter(({ path }) => path.startsWith(LIST))).toHaveLength(0)
  })

  it.each([CREATE, EDIT])('denies an ordinary team member entering %s directly', async (path) => {
    const requests = fakeApi({
      ...signedInAs({ ...ME, organization: team }),
      ...instanceRoute(true),
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { userId: ME.user.id, organizationId: team.id, role: 'member' }),
    })
    renderApp(path)
    expect(await screen.findByText('This workflow is unavailable.')).toBeTruthy()
    const nav = within(screen.getByRole('navigation', { name: 'Main' }))
    expect(nav.queryByRole('link', { name: 'Workflows' })).toBeNull()
    expect(main().queryByRole('textbox', { name: 'Workflow name' })).toBeNull()
    expect(requests.to('GET /api/v1/event-types')).toHaveLength(0)
    expect(requests.calls.filter(({ path }) => path.startsWith(LIST))).toHaveLength(0)
  })

  it.each(['owner', 'admin'])(
    'lets a current team %s edit only team-eligible fields',
    async (role) => {
      const teamEvent = eventType({
        id: 'e0000000-0000-7000-8000-000000000003',
        title: 'Team intro',
        organizationId: team.id,
        ownerUserId: null,
      })
      const teamWorkflow: Schemas['Workflow'] = {
        ...workflow,
        owner: { kind: 'team', id: team.id },
        scope: { type: 'event_type', eventTypeId: teamEvent.id },
      }
      const requests = fakeApi({
        ...signedInAs({ ...ME, organization: team }),
        ...instanceRoute(true),
        'GET /api/auth/organization/get-active-member': () =>
          json(200, { userId: ME.user.id, organizationId: team.id, role }),
        'GET /api/v1/event-types': () => json(200, { data: [teamEvent, event] }),
        [`GET ${DETAIL}`]: () => json(200, teamWorkflow),
        [`POST ${PREVIEW}`]: () => json(200, matchedPreview),
      })
      const user = userEvent.setup()
      renderApp(EDIT)
      await screen.findByRole('textbox', { name: 'Workflow name' })
      const picker = main().getByRole<HTMLSelectElement>('combobox', { name: 'Event type' })
      expect(picker.value).toBe(teamEvent.id)
      expect(within(picker).queryByRole('option', { name: event.title })).toBeNull()
      await user.click(main().getByRole('button', { name: 'Add condition' }))
      const row = within(main().getByRole('group', { name: 'Condition 1' }))
      const condition = row.getByRole<HTMLSelectElement>('combobox', { name: 'Condition type' })
      expect(Array.from(condition.options, ({ value }) => value)).toEqual([
        'event_type',
        'guest_count',
      ])
      await user.selectOptions(row.getByRole('combobox', { name: 'Event type' }), teamEvent.id)
      await user.click(main().getByRole('button', { name: 'Preview workflow' }))
      await screen.findByText('The example booking matches this workflow.')
      const [preview] = requests.to(`POST ${PREVIEW}`)
      expect(preview?.headers.get('X-Expected-Organization-Id')).toBe(team.id)
      expect(preview?.body).toMatchObject({ owner: { kind: 'team', id: team.id } })
    },
  )
})
