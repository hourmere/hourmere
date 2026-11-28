import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import { routingFormPath } from '../../paths.ts'
import { fakeApi, json, later, ME, renderApp, signedInAs } from '../../test/fake-api.tsx'

const id = '17200000-0000-4000-8000-000000000001'
const purpose = '17200000-0000-4000-8000-000000000002'
const support = '17200000-0000-4000-8000-000000000003'
const email = '17200000-0000-4000-8000-000000000004'
const ruleId = '17200000-0000-4000-8000-000000000005'
const team = {
  id: '17200000-0000-4000-8000-000000000006',
  name: 'Support team',
  slug: 'support',
  personal: false,
}
const form: Schemas['RoutingForm'] = {
  id,
  title: 'Find help',
  slug: 'find-help',
  description: null,
  questions: [
    {
      id: purpose,
      type: 'select',
      label: 'What do you need?',
      required: true,
      options: [{ id: support, label: 'Support' }],
    },
    { id: email, type: 'email', label: 'Contact email', required: false },
  ],
  rules: [
    {
      id: ruleId,
      conditions: [{ questionId: purpose, operator: 'equals', value: support }],
      target: { kind: 'message', message: 'Contact the support desk.' },
    },
  ],
  fallback: { kind: 'message', message: 'Please contact the office.' },
  draftRevision: 3,
  enabled: false,
  publishedVersionId: null,
  publishedVersionNumber: null,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  health: null,
}
const result: Schemas['RoutingFormPreview'] = {
  draftRevision: form.draftRevision,
  matchedRuleId: ruleId,
  resolvedRuleId: ruleId,
  target: form.rules[0]?.target ?? null,
  unavailableTargets: [],
  rules: [{ ruleId, matched: true, conditions: [{ questionId: purpose, matched: true }] }],
}
const read = `GET /api/v1/routing-forms/${id}`
const write = `PATCH /api/v1/routing-forms/${id}`
const preview = `POST /api/v1/routing-forms/${id}/preview`
const routes = {
  ...signedInAs({ ...ME, organization: team }),
  'GET /api/v1/instance': () => json(200, { routingFormsEnabled: true }),
  [read]: () => json(200, form),
}

describe('Routing draft preview', () => {
  it('validates answers, pins the team and renders the server match and trace', async () => {
    const questionLabel = '🙂 ما الموضوع؟ (Topic)'
    const optionLabel = 'תמיכה (Support)'
    const lines = [
      'تواصل مع support@example.test (Support)',
      'Instructions: https://example.test/help?lang=en&step=2',
    ] as const
    const mixedForm = {
      ...form,
      questions: [
        {
          ...form.questions[0],
          label: questionLabel,
          options: [{ id: support, label: optionLabel }],
        },
        form.questions[1],
      ],
    }
    const pending = later()
    const api = fakeApi({
      ...routes,
      [read]: () => json(200, mixedForm),
      [preview]: () => pending.response,
    })
    renderApp(routingFormPath(id, team.id))
    const user = userEvent.setup()
    const panel = within(await screen.findByTestId('routing-preview', {}, { timeout: 4_000 }))
    const run = panel.getByRole('button', { name: 'Run preview' })

    await user.click(run)
    expect(panel.getByRole('alert').textContent).toContain('Answer this required question.')
    expect(api.to(preview)).toHaveLength(0)
    const select = panel.getByRole('combobox', { name: questionLabel })
    expect(panel.getByText(questionLabel, { selector: 'label bdi' }).textContent).toBe(
      questionLabel,
    )
    const option = within(select).getByRole('option', { name: optionLabel })
    expect(option.dir).toBe('auto')
    await user.selectOptions(select, option)
    const emailInput = panel.getByRole('textbox', { name: /Contact email/ })
    await user.type(emailInput, 'not-an-address')
    await user.click(run)
    expect(panel.getByRole('alert').textContent).toContain('Enter a valid email address.')
    expect(api.to(preview)).toHaveLength(0)
    await user.clear(emailInput)

    await user.click(run)
    expect((await panel.findByTestId('routing-preview-loading')).textContent).toContain(
      'Running preview…',
    )
    expect(panel.queryByTestId('routing-preview-result')).toBeNull()
    await pending.answer(
      json(200, { ...result, target: { kind: 'message', message: lines.join('\n\n') } }),
    )
    const output = within(await panel.findByTestId('routing-preview-result'))
    expect(output.getByRole('status').textContent).toContain('Matched: Rule 1.')
    const message = output.getByText(lines[0], { selector: 'p bdi' }).parentElement
    expect(message?.textContent).toBe(lines.join('\n\n'))
    expect(Array.from(message?.querySelectorAll('bdi') ?? [], (line) => line.textContent)).toEqual(
      lines,
    )
    const trace = within(output.getByRole('list', { name: 'Evaluated rules' }))
    expect(trace.getByText(questionLabel, { selector: 'bdi' }).parentElement?.textContent).toBe(
      `${questionLabel} Matched`,
    )
    expect(api.to(preview)).toHaveLength(1)
    expect(api.to(preview)[0]?.headers.get('X-Expected-Organization-Id')).toBe(team.id)
    expect(api.to(preview)[0]?.body).toEqual({ answers: { [purpose]: support, [email]: null } })
    expect(api.to(write)).toHaveLength(0)
  })

  it('sends the edited fallback on save and previews only the resulting revision', async () => {
    const fallback = { kind: 'message', message: 'Contact the new office.' } as const
    const api = fakeApi({
      ...routes,
      [write]: () => json(200, { ...form, fallback, draftRevision: 4 }),
      [preview]: () =>
        json(200, {
          ...result,
          draftRevision: 4,
          target: fallback,
          resolvedRuleId: 'fallback',
          unavailableTargets: [{ ruleId, reason: 'not_found' }],
        } satisfies Schemas['RoutingFormPreview']),
    })
    renderApp(routingFormPath(id, team.id))
    const user = userEvent.setup()
    const group = within(
      await screen.findByRole('region', { name: 'Fallback' }, { timeout: 4_000 }),
    )
    const message = group.getByRole('textbox', { name: 'Message to show' })
    await user.clear(message)
    await user.type(message, fallback.message)
    const panel = within(screen.getByTestId('routing-preview'))
    expect(panel.getByRole<HTMLButtonElement>('button', { name: 'Run preview' }).disabled).toBe(
      true,
    )
    expect(api.to(preview)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await screen.findByText('Draft saved.')
    expect(api.to(write)[0]?.body).toMatchObject({ fallback, expectedRevision: 3 })
    const savedPreview = within(screen.getByTestId('routing-preview'))
    await user.selectOptions(
      savedPreview.getByRole('combobox', { name: 'What do you need?' }),
      support,
    )
    await user.click(savedPreview.getByRole('button', { name: 'Run preview' }))
    const output = within(await savedPreview.findByTestId('routing-preview-result'))
    expect(output.getByRole('status').textContent).toContain('Matched: Rule 1.')
    expect(output.getByRole('status').textContent).toContain('Destination used: Fallback.')
    expect(output.getByText(fallback.message)).toBeTruthy()
  })

  it.each([
    [403, { error: 'team_management_access_denied' }, 'denied'],
    [503, { error: 'service_unavailable' }, 'error'],
    [200, { ...result, draftRevision: 4 }, 'stale'],
    [400, { error: 'invalid_routing_answers' }, 'stale'],
  ])('shows a neutral state for preview response %s', async (status, body, state) => {
    fakeApi({ ...routes, [preview]: () => json(status, body) })
    renderApp(routingFormPath(id, team.id))
    const panel = within(await screen.findByTestId('routing-preview', {}, { timeout: 4_000 }))
    const user = userEvent.setup()
    await user.selectOptions(panel.getByRole('combobox', { name: 'What do you need?' }), support)
    await user.click(panel.getByRole('button', { name: 'Run preview' }))
    expect((await panel.findByRole('alert')).dataset.testid).toBe(`routing-preview-${state}`)
    expect(panel.queryByTestId('routing-preview-result')).toBeNull()
    expect(panel.queryByText('No destination is available for these answers.')).toBeNull()
  })
})
