import {
  evaluateRoutingForm,
  validateRoutingAnswers,
  validateRoutingFormConfig,
} from '@hourmere/scheduling/routing-form-config'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import '../../i18n/admin.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { chooseLanguage } from '../../i18n/store.ts'
import { RoutingRulesEditor } from './RoutingRulesEditor.tsx'
import type { RoutingTargetEvents } from './routing-target-events.ts'

type Form = Schemas['RoutingForm']
type Rule = Form['rules'][number]

const introduction = { id: '40000000-0000-4000-8000-000000000011', label: 'Introduction' }
const support = { id: '40000000-0000-4000-8000-000000000012', label: 'תמיכה (Support)' }
const topic = {
  id: '40000000-0000-4000-8000-000000000001',
  label: 'ما الموضوع؟ (Topic)',
  type: 'select',
  required: false,
  options: [introduction, support],
} satisfies Form['questions'][number]
const company = {
  id: '40000000-0000-4000-8000-000000000002',
  label: 'Company',
  type: 'short_text',
  required: false,
} satisfies Form['questions'][number]
const questions = [topic, company]
const fallback = { kind: 'message', message: 'Contact the office' } as const
const events: RoutingTargetEvents = {
  list: { status: 'loading' },
  bookingFields: () => ({ status: 'loading' }),
  eventTitle: () => undefined,
  retry: () => {},
}

function Editor({
  initial,
  onRulesChange,
}: {
  initial: Rule[]
  onRulesChange: (rules: Rule[]) => void
}) {
  const [rules, setRules] = useState(initial)
  const [target, setTarget] = useState<Form['fallback']>(fallback)
  return (
    <InterfaceScope surface="admin">
      <RoutingRulesEditor
        questions={questions}
        rules={rules}
        fallback={target}
        onRulesChange={(next) => {
          onRulesChange(next)
          setRules(next)
        }}
        onFallbackChange={setTarget}
        errors={{}}
        events={events}
      />
    </InterfaceScope>
  )
}

function renderEditor(initial: Rule[]) {
  const changes = vi.fn<(rules: Rule[]) => void>()
  render(<Editor initial={initial} onRulesChange={changes} />)
  return () => changes.mock.lastCall?.[0] ?? initial
}

function match(rules: Rule[]) {
  const config = validateRoutingFormConfig({ questions, rules, fallback })
  const answers = validateRoutingAnswers(config.questions, { [topic.id]: introduction.id })
  return evaluateRoutingForm(config, answers)
}

describe('Routing rules', () => {
  it('changes the first matching rule when reordered by keyboard and retains each rule ID', async () => {
    const first: Rule = {
      id: '40000000-0000-4000-8000-000000000021',
      conditions: [{ questionId: topic.id, operator: 'equals', value: introduction.id }],
      target: { kind: 'message', message: 'First result' },
    }
    const second: Rule = {
      id: '40000000-0000-4000-8000-000000000022',
      conditions: [
        { questionId: topic.id, operator: 'one_of', values: [introduction.id, support.id] },
      ],
      target: { kind: 'message', message: 'Second result' },
    }
    const latest = renderEditor([first, second])
    const user = userEvent.setup()
    expect(match(latest())).toEqual({ ruleId: first.id, target: first.target })

    const moveUp = screen.getByRole('button', { name: 'Move up: rule 2' })
    moveUp.focus()
    await user.keyboard('{Enter}')

    expect(latest()).toEqual([second, first])
    expect(match(latest())).toEqual({ ruleId: second.id, target: second.target })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move down: rule 1' }))
    expect(screen.getByRole('status').textContent).toBe('Moved rule 2 to position 1 of 2.')
    expect(screen.getByRole('region', { name: 'Fallback' })).toBeTruthy()
  })

  it('authors select conditions with option IDs and limits text questions to equality in Chinese', async () => {
    chooseLanguage('zh-CN')
    const latest = renderEditor([])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '添加规则' }))
    const addedId = latest()[0]?.id
    expect(addedId).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/)

    const first = within(screen.getByRole('group', { name: '条件 1' }))
    const source = first.getByRole('combobox', { name: '分流表单问题' })
    expect(document.activeElement).toBe(source)
    expect(within(source).getByRole('option', { name: topic.label }).dir).toBe('auto')
    await user.selectOptions(source, topic.id)
    await user.selectOptions(first.getByRole('combobox', { name: '要匹配的回答' }), introduction.id)
    await user.selectOptions(first.getByRole('combobox', { name: '比较方式' }), 'one_of')
    const choices = within(first.getByRole('group', { name: '要匹配的回答' }))
    const supportOption = choices.getByRole('checkbox', { name: support.label })
    expect(supportOption.closest('label')?.querySelector('bdi')?.textContent).toBe(support.label)
    supportOption.focus()
    await user.keyboard(' ')

    await user.click(screen.getByRole('button', { name: '添加条件' }))
    const second = within(screen.getByRole('group', { name: '条件 2' }))
    expect(document.activeElement).toBe(second.getByRole('combobox', { name: '分流表单问题' }))
    await user.selectOptions(second.getByRole('combobox', { name: '分流表单问题' }), company.id)
    const comparison = within(second.getByRole('combobox', { name: '比较方式' }))
    expect(comparison.getAllByRole('option').map((option) => option.textContent)).toEqual(['等于'])
    const answer = second.getByRole('textbox', { name: '要匹配的回答' })
    const companyName = 'شركة (Example)'
    expect(answer.dir).toBe('auto')
    await user.type(answer, companyName)
    expect(latest()[0]).toMatchObject({
      id: addedId,
      conditions: [
        { questionId: topic.id, operator: 'one_of', values: [introduction.id, support.id] },
        { questionId: company.id, operator: 'equals', value: companyName },
      ],
    })
    await user.click(second.getByRole('button', { name: '移除条件：条件 2' }))
    expect(document.activeElement).toBe(source)
    expect(latest()[0]?.conditions).toHaveLength(1)
  })
})
