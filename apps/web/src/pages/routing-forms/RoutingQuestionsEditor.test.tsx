import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client.ts'
import '../../i18n/admin.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { chooseLanguage } from '../../i18n/store.ts'
import { RoutingQuestionsEditor } from './RoutingQuestionsEditor.tsx'

type Questions = Schemas['RoutingForm']['questions']

const company = {
  id: '00000000-0000-4000-8000-000000000001',
  type: 'short_text',
  label: 'Company',
  required: false,
} as const
const email = {
  id: '00000000-0000-4000-8000-000000000002',
  type: 'email',
  label: 'Work email',
  required: true,
} as const

function Editor({
  initial,
  onChange,
}: {
  initial: Questions
  onChange: (next: Questions) => void
}) {
  const [questions, setQuestions] = useState(initial)
  return (
    <InterfaceScope surface="admin">
      <RoutingQuestionsEditor
        questions={questions}
        onChange={(next) => {
          onChange(next)
          setQuestions(next)
        }}
      />
    </InterfaceScope>
  )
}

function renderEditor(initial: Questions) {
  const changes = vi.fn<(questions: Questions) => void>()
  render(<Editor initial={initial} onChange={changes} />)
  return () => changes.mock.lastCall?.[0]
}

describe('Routing questions', () => {
  it('adds and edits a question, then moves it by keyboard while preserving IDs', async () => {
    const latest = renderEditor([company, email])
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Add a question' }))
    const addedId = latest()?.[2]?.id
    expect(addedId).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/)
    const question = within(screen.getByRole('group', { name: 'Question 3' }))
    expect(document.activeElement).toBe(question.getByRole('textbox', { name: 'Question' }))
    await user.keyboard('Team size')
    await user.click(question.getByRole('checkbox', { name: 'Required' }))

    const moveUp = question.getByRole('button', { name: 'Move up: question 3, “Team size”' })
    await user.tab()
    expect(document.activeElement).toBe(moveUp)
    await user.keyboard('{Enter}')
    expect(latest()?.map((entry) => entry.id)).toEqual([company.id, addedId, email.id])
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Move up: question 2, “Team size”' }),
    )
    await user.keyboard(' ')
    expect(latest()).toEqual([
      { id: addedId, type: 'short_text', label: 'Team size', required: true },
      company,
      email,
    ])
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Move down: question 1, “Team size”' }),
    )
    expect(screen.getByRole('status').textContent).toContain('to position 1 of 3.')
  })

  it('gives a changed question type a new ID and keeps option IDs through editing and keyboard reorder', async () => {
    chooseLanguage('zh-CN')
    const latest = renderEditor([company])
    const user = userEvent.setup()
    const type = screen.getByRole('combobox', { name: '回答类型' })
    await user.selectOptions(type, 'select')
    const changed = latest()?.[0]
    if (changed?.type !== 'select') throw new Error('Expected a select question')
    expect(changed).toMatchObject({ label: company.label, required: false })
    expect(changed.id).not.toBe(company.id)
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: '回答类型' }))

    await user.type(screen.getByRole('textbox', { name: '问题 1 的选项 1' }), '小团队')
    await user.click(screen.getByRole('button', { name: '添加选项' }))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '问题 1 的选项 2' }))
    const withSecondOption = latest()?.[0]
    if (withSecondOption?.type !== 'select') throw new Error('Expected a select question')
    const firstId = changed.options[0]?.id
    const secondId = withSecondOption.options[1]?.id
    expect(firstId).toBeDefined()
    expect(secondId).toBeDefined()
    expect(firstId).not.toBe(secondId)
    await user.keyboard('大团队')

    await user.tab()
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '上移：问题 1 的选项 2' }),
    )
    await user.keyboard('{Enter}')
    expect(latest()).toEqual([
      {
        ...changed,
        options: [
          { id: secondId, label: '大团队' },
          { id: firstId, label: '小团队' },
        ],
      },
    ])
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: '下移：问题 1 的选项 1' }),
    )
    expect(screen.getByRole('status').textContent).toBe(
      '已将问题 1 的选项 2 移至第 1 位，共 2 项。',
    )
  })
})
