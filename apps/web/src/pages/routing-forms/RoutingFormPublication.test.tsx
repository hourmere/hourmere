import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import {
  AppShell,
  EditRoutingFormPage,
  NewRoutingFormPage,
  RequireRoutingForms,
  RequireSession,
  SessionLayout,
} from '../../lazy-pages.tsx'
import { PATHS, routingFormPath } from '../../paths.ts'
import { fakeApi, json, later, ME, renderApp, signedInAs } from '../../test/fake-api.tsx'
import { resolveLazy } from '../../test/resolve-lazy.ts'

// The first test would otherwise spend its first findBy* loading these route chunks.
beforeAll(() =>
  resolveLazy(
    SessionLayout,
    RequireSession,
    AppShell,
    RequireRoutingForms,
    NewRoutingFormPage,
    EditRoutingFormPage,
  ),
)

type Form = Schemas['RoutingForm']
type Publication = Schemas['RoutingFormPublication']
type TargetHealth = NonNullable<Form['health']>['targets'][number]

const id = '17300000-0000-4000-8000-000000000001'
const team = {
  id: '17300000-0000-4000-8000-000000000002',
  name: 'Support team',
  slug: 'support',
  personal: false,
}
const address = routingFormPath(id, team.id)
const versionId = '17300000-0000-4000-8000-000000000003'
const questionId = '17300000-0000-4000-8000-000000000004'
const brokenEventId = '17300000-0000-4000-8000-000000000005'
const brokenRuleId = '17300000-0000-4000-8000-000000000006'
const otherRuleId = '17300000-0000-4000-8000-000000000007'
const date = '2026-11-01T09:00:00.000Z'
const draft: Form = {
  id,
  title: 'Find help',
  slug: 'find-help',
  description: null,
  questions: [],
  rules: [],
  fallback: { kind: 'message', message: 'Contact the office.' },
  draftRevision: 1,
  enabled: false,
  publishedVersionId: null,
  publishedVersionNumber: null,
  createdAt: date,
  updatedAt: date,
  health: null,
}
const create = 'POST /api/v1/routing-forms'
const read = `GET /api/v1/routing-forms/${id}`
const save = `PATCH /api/v1/routing-forms/${id}`
const preview = `POST /api/v1/routing-forms/${id}/preview`
const publish = `POST /api/v1/routing-forms/${id}/publish`
const routes = {
  ...signedInAs({ ...ME, organization: team }),
  'GET /api/v1/instance': () => json(200, { routingFormsEnabled: true }),
  [read]: () => json(200, draft),
}

function published(
  saved: Form,
  {
    number = 1,
    publishedId = versionId,
    status = 'ok',
    targets = [{ ruleId: 'fallback', eventTypeId: null, health: 'ok', reason: null }],
  }: {
    number?: number
    publishedId?: string
    status?: NonNullable<Form['health']>['status']
    targets?: TargetHealth[]
  } = {},
): Publication {
  return {
    form: {
      ...saved,
      draftRevision: saved.draftRevision + 1,
      publishedVersionId: publishedId,
      publishedVersionNumber: number,
      health: { versionId: publishedId, status, targets },
    },
    version: {
      id: publishedId,
      formId: id,
      versionNumber: number,
      publishedAt: date,
      questions: saved.questions,
      rules: saved.rules,
      fallback: saved.fallback,
    },
  }
}

const reviewButton = 'Review publication'
const publishButton = 'Publish version'
const disableButton = 'Disable routing form'
const reenableButton = 'Re-enable routing form'
const disableAcknowledgement =
  'I understand that while this form is disabled, submissions and pending booking links are blocked.'
const staleMessage =
  'This routing form changed elsewhere. Reload it and review your edits before trying again.'
const review = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: reviewButton }))

describe('Routing form publication', () => {
  it('creates, saves, previews and explicitly publishes a team draft', async () => {
    const pending = later()
    let form = draft
    const api = fakeApi({
      ...routes,
      [create]: ({ body }) => {
        const { title, slug, questions } = body as Schemas['CreateRoutingForm']
        form = { ...form, title, slug, questions: questions as Form['questions'] }
        return json(201, form)
      },
      [read]: () => json(200, form),
      [save]: ({ body }) => {
        const { fallback } = body as Schemas['UpdateRoutingForm']
        if (fallback?.kind !== 'message') throw new Error('Expected a message fallback')
        form = { ...form, fallback, draftRevision: form.draftRevision + 1 }
        return json(200, form)
      },
      [preview]: () =>
        json(200, {
          draftRevision: form.draftRevision,
          matchedRuleId: 'fallback',
          resolvedRuleId: 'fallback',
          target: form.fallback,
          unavailableTargets: [],
          rules: [],
        } satisfies Schemas['RoutingFormPreview']),
      [publish]: () => pending.response,
    })
    renderApp(PATHS.newRoutingForm)
    const user = userEvent.setup()
    await user.type(await screen.findByRole('textbox', { name: 'Title' }), draft.title)
    await user.type(screen.getByRole('textbox', { name: 'Form address' }), draft.slug)
    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    await user.type(screen.getByRole('textbox', { name: 'Question' }), 'Company')
    expect(screen.queryByRole('button', { name: reviewButton })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    const fallback = within(await screen.findByRole('region', { name: 'Fallback' }))
    const message = 'Contact the support desk.'
    const field = fallback.getByRole('textbox', { name: 'Message to show' })
    await user.clear(field)
    await user.type(field, message)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: reviewButton }).disabled).toBe(
      true,
    )
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await screen.findByText('Draft saved.')
    const previewPanel = within(screen.getByTestId('routing-preview'))
    await user.type(previewPanel.getByRole('textbox', { name: /Company/ }), 'Example')
    await user.click(previewPanel.getByRole('button', { name: 'Run preview' }))
    const result = within(await previewPanel.findByTestId('routing-preview-result'))
    expect(result.getByText(message)).toBeTruthy()
    expect(api.to(preview)[0]?.body).toEqual({
      answers: { [form.questions[0]?.id ?? '']: 'Example' },
    })

    await review(user)
    const confirmation = within(screen.getByRole('group', { name: reviewButton }))
    expect(confirmation.getByText('Saved fallback')).toBeTruthy()
    expect(confirmation.getByText(message)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBe(document.activeElement)
    expect(api.to(publish)).toHaveLength(0)
    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: reviewButton })).toBe(document.activeElement)
    await review(user)
    await user.click(screen.getByRole('button', { name: publishButton }))
    await waitFor(() => expect(api.to(publish)).toHaveLength(1))
    expect((await screen.findByTestId('routing-publication-pending')).textContent).toBe(
      'Publishing…',
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: publishButton }).disabled).toBe(
      true,
    )
    expect(api.to(publish)[0]?.body).toEqual({
      expectedRevision: 2,
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    })
    expect(screen.queryByText(/Published version 1/)).toBeNull()
    await pending.answer(json(201, published(form)))
    expect(await screen.findByText('Published version 1.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: disableButton })).toBeNull()
    expect(api.to(save)).toHaveLength(1)
    for (const request of [create, read, save, preview, publish]) {
      expect(
        api.to(request).map(({ headers }) => headers.get('X-Expected-Organization-Id')),
      ).toEqual([team.id])
    }
  })

  it('requires disable acknowledgement and sends only the new availability and revision', async () => {
    let form = published({ ...draft, enabled: true }).form
    const api = fakeApi({
      ...routes,
      [read]: () => json(200, form),
      [save]: ({ body }) => {
        const { enabled } = body as Schemas['UpdateRoutingForm']
        form = { ...form, enabled: enabled ?? form.enabled, draftRevision: form.draftRevision + 1 }
        return json(200, form)
      },
    })
    renderApp(address)
    const user = userEvent.setup()
    const title = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Title' })
    await user.type(title, ' for teams')
    await user.click(screen.getByRole('button', { name: disableButton }))
    expect(api.to(save)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.to(save)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: disableButton }))
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Disable form' })
    expect(confirm.disabled).toBe(true)
    await user.click(confirm)
    expect(api.to(save)).toHaveLength(0)
    await user.click(screen.getByRole('checkbox', { name: disableAcknowledgement }))
    await user.click(confirm)
    await user.click(await screen.findByRole('button', { name: reenableButton }))
    expect(api.to(save).map(({ body }) => body)).toEqual([{ enabled: false, expectedRevision: 2 }])
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe(
      'Find help for teams',
    )
    await user.click(screen.getByRole('button', { name: 'Re-enable form' }))
    await screen.findByRole('button', { name: disableButton })
    expect(api.to(save).map(({ body }) => body)).toEqual([
      { enabled: false, expectedRevision: 2 },
      { enabled: true, expectedRevision: 3 },
    ])
    expect(api.to(save).map(({ headers }) => headers.get('X-Expected-Organization-Id'))).toEqual([
      team.id,
      team.id,
    ])
    expect(api.to(publish)).toHaveLength(0)
  })

  it.each([false, true])(
    'preserves unsaved edits after a conflict (overlapping: %s)',
    async (overlap) => {
      let reads = 0
      let saves = 0
      const updated = {
        ...draft,
        title: overlap ? 'A teammate changed the title' : draft.title,
        description: 'A teammate changed this.',
        draftRevision: 2,
      }
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const api = fakeApi({
        ...routes,
        [read]: () => json(200, ++reads === 1 ? draft : updated),
        [save]: ({ body }) => {
          if (++saves === 1) return json(409, { error: 'routing_revision_conflict' })
          const { title } = body as Schemas['UpdateRoutingForm']
          return json(200, { ...updated, title, draftRevision: 3 })
        },
      })
      renderApp(address)
      const user = userEvent.setup()
      await user.type(await screen.findByRole('textbox', { name: 'Title' }), ' for teams')
      await user.click(screen.getByRole('button', { name: 'Save draft' }))
      await screen.findByText(staleMessage)
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe(
        'Find help for teams',
      )
      await user.click(screen.getByRole('button', { name: 'Reload' }))
      await screen.findByDisplayValue(updated.description)
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe(
        'Find help for teams',
      )
      if (overlap) {
        await user.click(screen.getByRole('button', { name: 'Save draft' }))
        expect(confirm).toHaveBeenCalledWith(
          'Save your edits over the fields that also changed in the latest draft?',
        )
        expect(api.to(save)).toHaveLength(1)
        confirm.mockReturnValue(true)
      }
      await user.click(screen.getByRole('button', { name: 'Save draft' }))
      await screen.findByText('Draft saved.')
      expect(api.to(read)).toHaveLength(2)
      expect(api.to(read)[1]?.headers.get('X-Expected-Organization-Id')).toBe(team.id)
      expect(api.to(save)[1]?.body).toMatchObject({
        title: 'Find help for teams',
        description: updated.description,
        expectedRevision: 2,
      })
      expect(confirm).toHaveBeenCalledTimes(overlap ? 2 : 0)
    },
  )

  it('requires a fresh review after a publish conflict and uses the newly loaded revision', async () => {
    const newer = {
      ...draft,
      fallback: { kind: 'message', message: 'Use the new contact desk.' } as const,
      draftRevision: 2,
    }
    let reads = 0
    let publications = 0
    const api = fakeApi({
      ...routes,
      [read]: () => json(200, ++reads === 1 ? draft : newer),
      [publish]: () =>
        ++publications === 1
          ? json(409, { error: 'routing_revision_conflict' })
          : json(201, published(newer)),
    })
    renderApp(address)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: reviewButton })
    await review(user)
    await user.click(screen.getByRole('button', { name: publishButton }))
    await screen.findByText(staleMessage)
    await user.click(screen.getByRole('button', { name: 'Reload' }))
    await screen.findByDisplayValue(newer.fallback.message)
    expect(api.to(publish)).toHaveLength(1)
    await review(user)
    const confirmation = within(screen.getByRole('group', { name: reviewButton }))
    expect(confirmation.getByText(newer.fallback.message)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: publishButton }))
    await screen.findByText('Published version 1.')
    expect(api.to(publish)[1]?.body).toMatchObject({ expectedRevision: 2 })
    expect(api.to(publish)[1]?.body).not.toEqual(api.to(publish)[0]?.body)
  })

  it('uses published health to repair the same draft rule after reordering', async () => {
    const broken = {
      id: brokenRuleId,
      conditions: [{ questionId, operator: 'equals', value: 'support' }],
      target: { kind: 'event', eventTypeId: brokenEventId, mappings: [] },
    } satisfies Form['rules'][number]
    const other = {
      id: otherRuleId,
      conditions: [{ questionId, operator: 'equals', value: 'sales' }],
      target: { kind: 'message', message: 'Find a sales contact.' },
    } satisfies Form['rules'][number]
    let form = published(
      {
        ...draft,
        questions: [{ id: questionId, label: 'Topic', type: 'short_text', required: false }],
        rules: [broken, other],
      },
      {
        status: 'unavailable',
        targets: [
          {
            ruleId: brokenRuleId,
            eventTypeId: brokenEventId,
            health: 'unavailable',
            reason: 'deleted',
          },
          { ruleId: otherRuleId, eventTypeId: null, health: 'ok', reason: null },
          { ruleId: 'fallback', eventTypeId: null, health: 'unknown', reason: null },
        ],
      },
    ).form
    const api = fakeApi({
      ...routes,
      [read]: () => json(200, form),
      'GET /api/v1/event-types': () => json(200, { data: [], nextCursor: null }),
      [save]: ({ body }) => {
        const { rules } = body as Schemas['UpdateRoutingForm']
        form = { ...form, rules: rules as Form['rules'], draftRevision: form.draftRevision + 1 }
        return json(200, form)
      },
      [publish]: () =>
        json(
          201,
          published(form, {
            number: 2,
            publishedId: '17300000-0000-4000-8000-000000000008',
            targets: [otherRuleId, brokenRuleId, 'fallback'].map((ruleId) => ({
              ruleId,
              eventTypeId: null,
              health: 'ok',
              reason: null,
            })),
          }),
        ),
    })
    renderApp(address)
    const user = userEvent.setup()
    const health = within(await screen.findByRole('region', { name: 'Published target health' }))
    expect(within(health.getByRole('list')).getByText('Unavailable')).toBeTruthy()
    expect(health.getByText('Health unknown')).toBeTruthy()
    expect(health.queryByRole('button', { name: 'Repair fallback' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Move down: rule 1' }))
    await user.click(health.getByRole('button', { name: /^Repair rule / }))
    const rule = within(screen.getByRole('group', { name: 'Rule 2' }))
    const destination = rule.getByRole('combobox', { name: 'Destination type' })
    expect(document.activeElement).toBe(destination)
    await user.selectOptions(destination, 'message')
    await user.type(rule.getByRole('textbox', { name: 'Message to show' }), 'Contact support.')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await screen.findByText('Draft saved.')
    expect(api.to(save)[0]?.body).toMatchObject({
      rules: [other, { ...broken, target: { kind: 'message', message: 'Contact support.' } }],
      expectedRevision: 2,
    })
    expect(within(health.getByRole('list')).getByText('Unavailable')).toBeTruthy()
    await review(user)
    await user.click(screen.getByRole('button', { name: publishButton }))
    await screen.findByText('Published version 2.')
    expect(health.queryByText('Unavailable')).toBeNull()
    expect(health.queryByRole('button', { name: /^Repair rule / })).toBeNull()
  })

  it('reviews the exact saved fallback when eligible events share a title', async () => {
    const catalog = later()
    const first = {
      id: brokenEventId,
      organizationId: team.id,
      ownerUserId: null,
      title: 'Consultation',
      slug: 'support-consultation',
      schedulingType: 'individual',
      bookingMode: 'individual',
      isActive: true,
      isHidden: true,
      questions: [],
    } satisfies Partial<Schemas['EventType']>
    const second = { ...first, id: otherRuleId, slug: 'sales-consultation', isHidden: false }
    fakeApi({
      ...routes,
      [read]: () =>
        json(200, { ...draft, fallback: { kind: 'event', eventTypeId: first.id, mappings: [] } }),
      'GET /api/v1/event-types': () => catalog.response,
      [`GET /api/v1/event-types/${first.id}`]: () => json(200, first),
    })
    renderApp(address)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: reviewButton })
    await review(user)
    const confirmation = within(screen.getByRole('group', { name: reviewButton }))
    expect(confirmation.getByText('Loading event types…')).toBeTruthy()
    await catalog.answer(json(200, { data: [first, second], nextCursor: null }))
    expect(
      await confirmation.findByText('Consultation (support-consultation) (hidden)'),
    ).toBeTruthy()
    expect(confirmation.queryByText('Consultation (sales-consultation)')).toBeNull()
  })

  it('reports a denied publication without implying that a configuration is missing', async () => {
    const api = fakeApi({
      ...routes,
      [publish]: () => json(403, { error: 'team_management_access_denied' }),
    })
    renderApp(address)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: reviewButton })
    await review(user)
    await user.click(screen.getByRole('button', { name: publishButton }))
    expect(await screen.findByText("You don't have permission to do that.")).toBeTruthy()
    expect(screen.queryByText('Published version 1.')).toBeNull()
    expect(screen.queryByRole('button', { name: reenableButton })).toBeNull()
    expect(api.to(publish)).toHaveLength(1)
  })

  it('retries an unconfirmed publication with the same revision and request ID', async () => {
    let requests = 0
    const api = fakeApi({
      ...routes,
      [publish]: () =>
        ++requests === 1 ? json(503, { error: 'unavailable' }) : json(201, published(draft)),
    })
    renderApp(address)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: reviewButton })
    await review(user)
    await user.click(screen.getByRole('button', { name: publishButton }))
    await screen.findByText(
      'Could not confirm publication. Try publishing again to recover the result.',
    )
    expect(screen.queryByText('Published version 1.')).toBeNull()
    await user.click(screen.getByRole('button', { name: publishButton }))
    await screen.findByText('Published version 1.')
    expect(api.to(publish)).toHaveLength(2)
    expect(api.to(publish)[1]?.body).toEqual(api.to(publish)[0]?.body)
  })

  it('does not load a team draft or mount publication controls for a team member', async () => {
    const api = fakeApi({
      ...routes,
      'GET /api/auth/organization/get-active-member': () =>
        json(200, { organizationId: team.id, userId: ME.user.id, role: 'member' }),
    })
    renderApp(address)
    expect(
      await screen.findByText(
        'Only team owners and admins can manage routing forms in this space.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: reviewButton })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Published target health' })).toBeNull()
    expect(api.to(read)).toHaveLength(0)
    expect(api.to(publish)).toHaveLength(0)
  })
})
