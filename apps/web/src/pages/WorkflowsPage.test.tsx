import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { api, type Schemas } from '../api/client.ts'
import { chooseLanguage } from '../i18n/store.ts'
import { PATHS, workflowEditPath, workflowRunHistoryPath } from '../paths.ts'
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

const list = 'GET /api/v1/workflows'
const workflowPath = '/api/v1/workflows/{id}'
const workflow: Schemas['Workflow'] = {
  id: '00000000-0000-7000-8000-000000000003',
  owner: { kind: 'personal', id: ME.user.id },
  revision: 2,
  enabled: false,
  name: 'Send booking follow-up',
  scope: { type: 'all_event_types' },
  trigger: { type: 'booking.created', delayMinutes: 0 },
  conditions: [],
  actions: [],
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
}
const detail = `/api/v1/workflows/${workflow.id}`
const team = {
  id: '00000000-0000-7000-8000-000000000004',
  name: 'Design Team',
  slug: 'design',
  personal: false,
}
const teamWorkflow: Schemas['Workflow'] = {
  ...workflow,
  id: '00000000-0000-7000-8000-000000000005',
  owner: { kind: 'team', id: team.id },
  name: 'Send team reminder',
}
const page = (data: Schemas['Workflow'][] = [workflow], nextCursor: string | null = null) =>
  json(200, { data, nextCursor })
const enabled = {
  'GET /api/v1/instance': () =>
    json(200, {
      workflowsEnabled: true,
      signIn: { email: true, google: false, microsoft: false },
    }),
}

describe('Workflow lifecycle', () => {
  it('lists personal workflows and uses the generated client to enable, disable and delete by the displayed revision', async () => {
    let current = workflow
    let deleted = false
    const requests = fakeApi({
      ...signedIn,
      ...enabled,
      [list]: () => page(deleted ? [] : [current]),
      [`GET ${detail}`]: () => json(200, current),
      [`PATCH ${detail}`]: ({ body }) => {
        current = { ...current, enabled: (body as { enabled: boolean }).enabled }
        return json(200, current)
      },
      [`DELETE ${detail}`]: () => {
        deleted = true
        return new Response(null, { status: 204 })
      },
    })
    const get = vi.spyOn(api, 'GET')
    const patch = vi.spyOn(api, 'PATCH')
    const remove = vi.spyOn(api, 'DELETE')
    const user = userEvent.setup()
    renderApp(PATHS.workflows)

    expect(await screen.findByRole('heading', { name: workflow.name })).toBeTruthy()
    const content = within(screen.getByRole('main'))
    expect(content.getByText('Disabled')).toBeTruthy()
    const enable = content.getByRole('button', { name: `Enable ${workflow.name}` })
    enable.focus()
    await user.keyboard('{Enter}')
    const enableConfirm = content.getByRole('group', { name: 'Enable this workflow?' })
    expect(document.activeElement).toBe(
      within(enableConfirm).getByRole('button', { name: 'Cancel' }),
    )
    await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(
      content.getByRole('button', { name: `Enable ${workflow.name}` }),
    )
    expect(requests.to(`GET ${detail}`)).toHaveLength(0)

    await user.keyboard('{Enter}')
    await user.tab({ shift: true })
    await user.keyboard('{Enter}')
    expect(await content.findByText('Workflow enabled.')).toBeTruthy()
    expect(await content.findByText('Enabled')).toBeTruthy()
    await user.click(content.getByRole('button', { name: `Disable ${workflow.name}` }))
    expect(
      content.getByRole('group', {
        name: 'Disable this workflow? Runs picked up while it is disabled are skipped.',
      }),
    ).toBeTruthy()
    await user.click(content.getByRole('button', { name: 'Disable workflow' }))
    expect(await content.findByText('Workflow disabled.')).toBeTruthy()
    expect(await content.findByText('Disabled')).toBeTruthy()
    await user.click(content.getByRole('button', { name: `Delete ${workflow.name}` }))
    expect(
      content.getByRole('group', {
        name: 'Delete this workflow? Pending runs will be canceled. This cannot be undone.',
      }),
    ).toBeTruthy()
    await user.click(content.getByRole('button', { name: 'Delete workflow' }))
    expect(await content.findByText('Workflow deleted.')).toBeTruthy()
    expect(await content.findByText('No workflows yet.')).toBeTruthy()

    expect(requests.to(list).map(({ path }) => path)).toEqual(
      Array.from({ length: 4 }, () => `/api/v1/workflows?ownerKind=personal&ownerId=${ME.user.id}`),
    )
    expect(requests.to(`PATCH ${detail}`).map(({ body }) => body)).toEqual([
      { expectedRevision: 2, enabled: true },
      { expectedRevision: 2, enabled: false },
    ])
    expect(requests.to(`DELETE ${detail}`).map(({ body }) => body)).toEqual([
      { expectedRevision: 2 },
    ])
    for (const { headers } of [
      ...requests.to(`PATCH ${detail}`),
      ...requests.to(`DELETE ${detail}`),
    ])
      expect(headers.get('X-Expected-Organization-Id')).toBe(ME.organization.id)

    expect(get).toHaveBeenCalledWith('/api/v1/workflows', expect.anything())
    expect(get).toHaveBeenCalledWith(workflowPath, expect.anything())
    expect(patch).toHaveBeenCalledTimes(2)
    expect(patch).toHaveBeenNthCalledWith(1, workflowPath, expect.anything())
    expect(patch).toHaveBeenNthCalledWith(2, workflowPath, expect.anything())
    expect(remove).toHaveBeenCalledExactlyOnceWith(workflowPath, expect.anything())
  })

  it.each(['detail', 'write'] as const)(
    'refreshes the list without replaying a stale action rejected by the %s',
    async (stage) => {
      const revised = { ...workflow, revision: 3, name: 'Revised follow-up' }
      let current = workflow
      const requests = fakeApi({
        ...signedIn,
        ...enabled,
        [list]: () => page([current]),
        [`GET ${detail}`]: () => {
          if (stage === 'detail') current = revised
          return json(200, current)
        },
        [`PATCH ${detail}`]: () => {
          current = revised
          return json(409, { error: 'workflow_revision_conflict' })
        },
      })
      renderApp(PATHS.workflows)
      await userEvent.click(await screen.findByRole('button', { name: `Enable ${workflow.name}` }))
      await userEvent.click(screen.getByRole('button', { name: 'Enable workflow' }))
      expect(
        await screen.findByText(
          'This workflow changed. Review the latest version before trying again.',
        ),
      ).toBeTruthy()
      expect(await screen.findByRole('button', { name: 'Enable Revised follow-up' })).toBeTruthy()
      expect(requests.to(`PATCH ${detail}`)).toHaveLength(stage === 'detail' ? 0 : 1)
      expect(screen.queryByText('Workflow enabled.')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Enable workflow' })).toBeNull()
    },
  )

  it('clears the list and confirmation after a stale organization conflict', async () => {
    const requests = fakeApi({
      ...signedInAs({ ...ME, organization: team }),
      ...enabled,
      [list]: () => page([teamWorkflow]),
      [`GET /api/v1/workflows/${teamWorkflow.id}`]: () => json(200, teamWorkflow),
      [`DELETE /api/v1/workflows/${teamWorkflow.id}`]: () =>
        json(409, { error: 'organization_context_changed' }),
    })
    renderApp(PATHS.workflows)
    await userEvent.click(
      await screen.findByRole('button', { name: `Delete ${teamWorkflow.name}` }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Delete workflow' }))
    expect(
      await screen.findByText('Your space changed. Reload before making changes.'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    expect(screen.queryByText(teamWorkflow.name)).toBeNull()
    expect(screen.queryByText('Workflow deleted.')).toBeNull()
    expect(requests.to(list).map(({ path }) => path)).toEqual([
      `/api/v1/workflows?ownerKind=team&ownerId=${team.id}`,
    ])
    const writes = requests.to(`DELETE /api/v1/workflows/${teamWorkflow.id}`)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.headers.get('X-Expected-Organization-Id')).toBe(team.id)
  })

  it('drops a pending detail read when switching from personal space to an administered team', async () => {
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
        json(200, {
          userId: ME.user.id,
          organizationId: team.id,
          role: 'admin',
        }),
      [list]: () => page([me.organization.personal ? workflow : teamWorkflow]),
      [`GET ${detail}`]: () => pending.response,
    })
    const user = userEvent.setup()
    renderApp(PATHS.workflows)
    await user.click(await screen.findByRole('button', { name: `Enable ${workflow.name}` }))
    await user.click(screen.getByRole('button', { name: 'Enable workflow' }))
    await waitFor(() => expect(requests.to(`GET ${detail}`)).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: /^Switch space/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: new RegExp(team.name) }))
    expect(await screen.findByRole('heading', { name: teamWorkflow.name })).toBeTruthy()
    await pending.answer(json(200, workflow))
    expect(screen.queryByText(workflow.name)).toBeNull()
    expect(screen.queryByText('Workflow enabled.')).toBeNull()
    expect(requests.to(`PATCH ${detail}`)).toHaveLength(0)
  })

  it.each(['owner', 'admin', 'member'])('preserves the fixed %s workflow markup', async (role) => {
    const requests = fakeApi({
      ...signedInAs({ ...ME, organization: team }),
      ...enabled,
      'GET /api/auth/organization/get-active-member': () =>
        json(200, {
          userId: ME.user.id,
          organizationId: team.id,
          role,
        }),
      [list]: () => page([teamWorkflow]),
    })
    renderApp(PATHS.workflows)
    const { id, name } = teamWorkflow
    const heading =
      '<div tabindex="-1"><header class="page-intro"><div class="page-header"><h1>Workflows</h1>'
    const endHeading = '</div></header></div>'
    const unavailable =
      '<p role="alert" class="alert alert-error">Workflows are unavailable in this space.</p>'
    if (role === 'member') {
      expect(await screen.findByText('Workflows are unavailable in this space.')).toBeTruthy()
      expect(screen.queryByRole('link', { name: 'Workflows' })).toBeNull()
      expect(requests.to(list)).toHaveLength(0)
      expect(screen.getByRole('main').innerHTML).toBe(`${heading}${endHeading}${unavailable}`)
      return
    }
    const rowHeading = await screen.findByRole('heading', { name })
    expect(rowHeading.id).toMatch(/_r_[0-9a-z]+_/)
    const newLink = `<a class="button button-primary" href="${PATHS.newWorkflow}" data-discover="true">New workflow</a>`
    const rowStart = `<ul class="card-list plain-list"><li class="panel card-item"><div class="card-main"><h2 id="${rowHeading.id}" class="card-title user-content">${name}</h2><p>Disabled</p></div><div class="card-actions">`
    const links = `<a class="button button-small" aria-label="Run history for ${name}" href="${workflowRunHistoryPath(id)}" data-discover="true">Run history</a><a class="button button-small" aria-label="Edit ${name}" href="${workflowEditPath(id)}" data-discover="true">Edit</a>`
    const buttons = `<button id="${rowHeading.id}-enable" class="button button-small" type="button" aria-label="Enable ${name}">Enable</button><button id="${rowHeading.id}-delete" class="button button-small" type="button" aria-label="Delete ${name}">Delete</button>`
    expect(screen.getByRole('main').innerHTML).toBe(
      `${heading}${newLink}${endHeading}${rowStart}${links}${buttons}</div></li></ul>`,
    )
  })

  it('shows a granted Member only permitted workflow actions', async () => {
    const id = teamWorkflow.id
    const runs = `GET /api/v1/workflows/${id}/runs`
    const requests = fakeApi({
      ...signedInAs({
        ...ME,
        organization: team,
        teamManagementPermissions: ['workflows.read', 'workflows.read_runs', 'workflows.preview'],
      }),
      ...enabled,
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { userId: ME.user.id, organizationId: team.id, role: 'member' }),
      [list]: () => page([teamWorkflow]),
      [runs]: () => json(200, { data: [], nextCursor: null }),
    })
    renderApp(PATHS.workflows)
    expect(await screen.findByRole('heading', { name: teamWorkflow.name })).toBeTruthy()
    const main = within(screen.getByRole('main'))
    expect(main.getByRole('link', { name: 'Details' }).getAttribute('href')).toBe(
      workflowEditPath(id),
    )
    expect(main.getByRole('link', { name: 'Preview workflow' }).getAttribute('href')).toBe(
      PATHS.newWorkflow,
    )
    expect(main.queryByRole('link', { name: 'New workflow' })).toBeNull()
    expect(main.queryByRole('link', { name: /^Edit/ })).toBeNull()
    expect(main.queryByRole('button', { name: /^(Enable|Disable|Delete)/ })).toBeNull()
    await userEvent.click(main.getByRole('link', { name: `Run history for ${teamWorkflow.name}` }))
    expect(await screen.findByText('No finished runs yet.')).toBeTruthy()
    expect(requests.to(runs)).toHaveLength(1)
  })

  it.each([
    [PATHS.workflows, 'Workflows are unavailable in this space.'],
    [PATHS.newWorkflow, 'This workflow is unavailable.'],
    [workflowEditPath(teamWorkflow.id), 'This workflow is unavailable.'],
    [workflowRunHistoryPath(teamWorkflow.id), 'Run history is unavailable in this space.'],
  ])('keeps unrenewed Admin workflow actions unavailable on %s', async (path, message) => {
    const requests = fakeApi({
      ...signedInAs({
        ...ME,
        organization: team,
        teamManagementPermissions: [],
        teamPermissionRenewalRequired: true,
      }),
      ...enabled,
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { userId: ME.user.id, organizationId: team.id, role: 'admin' }),
    })
    renderApp(path)
    expect(await screen.findByText(message)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Workflows' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'New workflow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Preview workflow' })).toBeNull()
    expect(requests.to(list)).toHaveLength(0)
    expect(requests.to(`GET /api/v1/workflows/${teamWorkflow.id}`)).toHaveLength(0)
    expect(requests.to(`GET /api/v1/workflows/${teamWorkflow.id}/runs`)).toHaveLength(0)
  })

  it.each([403, 500])(
    'keeps loading and %i reads distinct from a confirmed empty list',
    async (status) => {
      const pending = later()
      fakeApi({ ...signedIn, ...enabled, [list]: () => pending.response })
      renderApp(PATHS.workflows)
      expect(await screen.findByRole('status', { name: 'Loading workflows…' })).toBeTruthy()
      expect(screen.queryByText('No workflows yet.')).toBeNull()
      await pending.answer(json(status, { error: 'unexpected_error', message: 'Internal detail' }))
      expect(
        await screen.findByText(
          status === 403 ? 'Workflows are unavailable in this space.' : 'Could not load workflows.',
        ),
      ).toBeTruthy()
      expect(screen.queryByText('No workflows yet.')).toBeNull()
      expect(screen.queryByText('Internal detail')).toBeNull()
    },
  )

  it('localizes the list and its confirmation and follows the owner-bound cursor', async () => {
    chooseLanguage('zh-CN')
    const requests = fakeApi({
      ...signedIn,
      ...enabled,
      [list]: ({ path }) =>
        path.includes('cursor=opaque') ? page([]) : page([workflow], 'opaque'),
    })
    renderApp(PATHS.workflows)
    expect(await screen.findByRole('heading', { name: '工作流', level: 1 })).toBeTruthy()
    await userEvent.click(await screen.findByRole('button', { name: `删除“${workflow.name}”` }))
    expect(screen.getByRole('button', { name: '删除工作流' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    await userEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(await screen.findByText('暂无工作流。')).toBeTruthy()
    const queries = requests
      .to(list)
      .map(({ path }) => Object.fromEntries(new URL(path, window.location.origin).searchParams))
    expect(queries).toEqual([
      { ownerKind: 'personal', ownerId: ME.user.id },
      { ownerKind: 'personal', ownerId: ME.user.id, cursor: 'opaque' },
    ])
  })
})
