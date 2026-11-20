import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { PATHS, routingFormPath } from '../../paths.ts'
import { fakeApi, json, later, ME, renderApp, signedIn, signedInAs } from '../../test/fake-api.tsx'

const id = '00000000-0000-7000-8000-000000000030'
const team = {
  id: '00000000-0000-7000-8000-000000000031',
  name: 'Design Team',
  slug: 'design',
  personal: false,
}
const enabled = {
  'GET /api/v1/instance': () => json(200, { routingFormsEnabled: true }),
}
const list = 'GET /api/v1/routing-forms'
const create = 'POST /api/v1/routing-forms'
const read = `GET /api/v1/routing-forms/${id}`
const save = `PATCH /api/v1/routing-forms/${id}`
const archive = `DELETE /api/v1/routing-forms/${id}`
const form: Schemas['RoutingForm'] = {
  id,
  title: 'Contact sales',
  slug: 'contact-sales',
  description: null,
  questions: [],
  rules: [],
  fallback: { kind: 'message', message: 'No appointment is available for these answers.' },
  draftRevision: 1,
  enabled: false,
  publishedVersionId: null,
  publishedVersionNumber: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  health: null,
}

describe('Routing form management', () => {
  it('creates a draft, saves an edit and archives only after confirmation', async () => {
    let draft: Schemas['RoutingForm'] | null = null
    const api = fakeApi({
      ...signedIn,
      ...enabled,
      [list]: () => json(200, { data: draft ? [draft] : [], nextCursor: null }),
      [create]: (call) => {
        const { title, slug, questions } = call.body as Schemas['CreateRoutingForm']
        draft = {
          ...form,
          title,
          slug,
          questions: questions as Schemas['RoutingForm']['questions'],
        }
        return json(201, draft)
      },
      [read]: () => (draft ? json(200, draft) : json(404, { error: 'routing_form_not_found' })),
      [save]: (call) => {
        const { questions } = call.body as Schemas['UpdateRoutingForm']
        draft = {
          ...form,
          ...draft,
          questions: questions as Schemas['RoutingForm']['questions'],
          draftRevision: 2,
        }
        return json(200, draft)
      },
      [archive]: () => {
        draft = null
        return new Response(null, { status: 204 })
      },
    })
    renderApp(PATHS.routingForms)
    const user = userEvent.setup()
    await screen.findByRole('heading', { name: 'Routing forms' })
    const main = within(screen.getByRole('main'))
    expect(await main.findByText('No routing forms yet.')).toBeTruthy()
    await user.click(main.getByRole('link', { name: 'New routing form' }))
    await user.type(await main.findByRole('textbox', { name: 'Title' }), form.title)
    await user.type(main.getByRole('textbox', { name: 'Form address' }), form.slug)
    await user.click(main.getByRole('button', { name: 'Add a question' }))
    await user.type(main.getByRole('textbox', { name: 'Question' }), 'Company')
    await user.click(main.getByRole('button', { name: 'Save draft' }))

    expect(await main.findByRole('heading', { name: 'Edit routing form' })).toBeTruthy()
    const created = api.to(create)[0]?.body as Schemas['CreateRoutingForm']
    expect(created).toMatchObject({
      title: form.title,
      slug: form.slug,
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      fallback: form.fallback,
      questions: [{ id: expect.stringMatching(/^[a-f0-9-]{36}$/), label: 'Company' }],
    })
    expect(screen.getByTestId('location').textContent).toBe(routingFormPath(id, ME.organization.id))

    const question = await main.findByRole('textbox', { name: 'Question' })
    await user.clear(question)
    await user.type(question, 'Organization')
    await user.click(main.getByRole('button', { name: 'Save draft' }))
    expect(await main.findByText('Draft saved.')).toBeTruthy()
    expect(api.to(save)[0]?.body).toEqual({
      title: form.title,
      slug: form.slug,
      description: '',
      questions: [{ ...created.questions?.[0], label: 'Organization' }],
      expectedRevision: 1,
    })

    await user.click(main.getByRole('link', { name: 'Back to routing forms' }))
    await user.click(await main.findByRole('link', { name: form.title }))
    expect((await main.findByRole<HTMLInputElement>('textbox', { name: 'Question' })).value).toBe(
      'Organization',
    )
    await user.click(main.getByRole('button', { name: 'Archive routing form' }))
    expect(api.to(archive)).toHaveLength(0)
    expect(main.getByRole('group', { name: /Archive this routing form/ })).toBeTruthy()
    const cancel = main.getByRole('button', { name: 'Cancel' })
    expect(document.activeElement).toBe(cancel)
    await user.keyboard('{Escape}')
    expect(api.to(archive)).toHaveLength(0)
    expect(document.activeElement).toBe(main.getByRole('button', { name: 'Archive routing form' }))
    await user.click(main.getByRole('button', { name: 'Archive routing form' }))
    await user.click(main.getByRole('button', { name: 'Archive form' }))

    expect(await main.findByText('No routing forms yet.')).toBeTruthy()
    expect(main.queryByRole('link', { name: form.title })).toBeNull()
    expect(api.to(archive).map(({ body }) => body)).toEqual([{ expectedRevision: 2 }])
    for (const request of [list, create, read, save, archive])
      expect(
        api
          .to(request)
          .every((call) => call.headers.get('X-Expected-Organization-Id') === ME.organization.id),
      ).toBe(true)
  })

  it('distinguishes loading, failed and forbidden reads from an empty list', async () => {
    const pending = later()
    let loads = 0
    fakeApi({
      ...signedIn,
      ...enabled,
      [list]: () =>
        ++loads === 1 ? pending.response : json(403, { error: 'team_management_access_denied' }),
    })
    renderApp(PATHS.routingForms)
    expect(await screen.findByRole('status', { name: 'Loading routing forms…' })).toBeTruthy()
    expect(screen.queryByText('No routing forms yet.')).toBeNull()
    expect(screen.queryByRole('link', { name: 'New routing form' })).toBeNull()
    await pending.answer(json(503, { error: 'unavailable' }))
    expect(await screen.findByText('Could not load routing forms.')).toBeTruthy()
    expect(screen.queryByText('No routing forms yet.')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText("You don't have permission to do that.")).toBeTruthy()
    expect(screen.queryByText('No routing forms yet.')).toBeNull()
    expect(screen.queryByRole('link', { name: 'New routing form' })).toBeNull()
  })

  it.each(['owner', 'admin', 'member'])('matches the server for team role %s', async (role) => {
    const api = fakeApi({
      ...signedInAs({ ...ME, organization: team }),
      ...enabled,
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: team.id, userId: ME.user.id, role }),
      [list]: () => json(200, { data: [form], nextCursor: null }),
    })
    renderApp(PATHS.routingForms)
    if (role === 'member') {
      expect(
        await screen.findByText(
          'Only team owners and admins can manage routing forms in this space.',
        ),
      ).toBeTruthy()
      expect(api.to(list)).toHaveLength(0)
      expect(screen.queryByRole('link', { name: 'Routing forms' })).toBeNull()
    } else {
      await screen.findByRole('heading', { name: 'Routing forms' })
      const main = within(screen.getByRole('main'))
      const row = await main.findByRole('link', { name: form.title })
      expect(row.getAttribute('href')).toBe(routingFormPath(id, team.id))
      expect(api.to(list)[0]?.headers.get('X-Expected-Organization-Id')).toBe(team.id)
    }
  })

  it('does not read an editor link bound to another organization', async () => {
    const api = fakeApi({ ...signedIn, ...enabled })
    renderApp(routingFormPath(id, team.id))
    expect(await screen.findByText('This routing form is unavailable.')).toBeTruthy()
    expect(api.to(read)).toHaveLength(0)
    expect(screen.queryByTestId('routing-form-editor')).toBeNull()
  })

  it('replays an uncertain creation with the original body and request ID', async () => {
    let attempts = 0
    const api = fakeApi({
      ...signedIn,
      ...enabled,
      [create]: () => {
        attempts++
        if (attempts === 1) return json(503, { error: 'unavailable' })
        if (attempts === 2) return json(429, { error: 'rate_limited' })
        return json(201, form)
      },
      [read]: () => json(200, form),
    })
    renderApp(PATHS.newRoutingForm)
    const user = userEvent.setup()
    const title = await screen.findByRole('textbox', { name: 'Title' })
    await user.type(title, form.title)
    await user.type(screen.getByRole('textbox', { name: 'Form address' }), form.slug)
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(
      await screen.findByText('Could not confirm creation. Try again to recover this draft.'),
    ).toBeTruthy()
    expect(title.closest('fieldset')?.disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(api.to(create)).toHaveLength(2))
    expect(api.to(create)[0]?.body).toEqual(api.to(create)[1]?.body)
    expect(
      await screen.findByText('Could not confirm creation. Try again to recover this draft.'),
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(await screen.findByRole('heading', { name: 'Edit routing form' })).toBeTruthy()
    expect(api.to(create)[0]?.body).toEqual(api.to(create)[2]?.body)
  })
})
