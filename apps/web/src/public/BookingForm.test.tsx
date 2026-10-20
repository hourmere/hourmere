import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import type { UiText } from '../i18n/translate.ts'
import { BookingForm, type BookingFormValues, validateBookingForm } from './BookingForm.tsx'
import type { FieldErrors, Question } from './validation.ts'

const valid: BookingFormValues = {
  name: 'Ada',
  email: 'ada@example.com',
  guests: [],
  answers: {},
}
const topics: Question = {
  id: 'topics',
  label: 'Topics',
  type: 'multi_select',
  required: true,
  options: ['One', 'Two'],
}

function Form({
  initial = valid,
  questions = [],
  serverErrors = {},
  formError = null,
  onSubmit = vi.fn(),
}: {
  initial?: BookingFormValues
  questions?: Question[]
  serverErrors?: FieldErrors
  formError?: UiText | null
  onSubmit?: () => void
}) {
  const [values, setValues] = useState(initial)
  return (
    <BookingForm
      allowGuests
      questions={questions}
      values={values}
      onChange={setValues}
      serverErrors={serverErrors}
      formError={formError}
      submitting={false}
      onSubmit={onSubmit}
    />
  )
}

describe('public booking form polish', () => {
  it('ignores untouched guests but validates both fields of every partially completed row', () => {
    expect(
      validateBookingForm([], {
        ...valid,
        guests: [{ name: ' ', email: '\t' }],
      }),
    ).toEqual({})
    expect(
      validateBookingForm([], {
        ...valid,
        guests: [
          { name: '', email: '' },
          { name: 'Guest', email: '' },
          { name: '', email: 'other@example.com' },
        ],
      }),
    ).toEqual({
      'guest-1-email': 'Enter an email address.',
      'guest-2-name': 'Enter a name.',
    })
    expect(
      validateBookingForm([], {
        ...valid,
        guests: [
          ...Array.from({ length: 10 }, () => ({ name: 'Guest', email: 'guest@example.com' })),
          { name: '', email: '' },
        ],
      }),
    ).toEqual({})
    expect(
      validateBookingForm([], {
        ...valid,
        guests: Array.from({ length: 11 }, () => ({ name: 'Guest', email: 'guest@example.com' })),
      }).guests,
    ).toBeDefined()
  })

  it('allows an added empty guest row to submit and keeps compact row hooks', async () => {
    const user = userEvent.setup(),
      onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit} />)
    await user.click(screen.getByRole('button', { name: 'Add a guest' }))
    const guest = screen.getByLabelText('Guest 1 name').closest('.guest')
    expect(guest?.children).toHaveLength(3)
    expect(guest?.children[0]?.className).toBe('field')
    expect(guest?.children[1]?.className).toBe('field')
    expect(guest?.lastElementChild?.classList.contains('guest-remove')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('focuses a linked error summary on every failed attempt and scrolls to fields', async () => {
    const user = userEvent.setup(),
      onSubmit = vi.fn(),
      scrollIntoView = vi.fn()
    render(<Form initial={{ ...valid, name: '', email: '' }} onSubmit={onSubmit} />)
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect(screen.queryAllByRole('alert')).toHaveLength(1)
    const summary = screen.getByRole('alert'),
      name = screen.getByLabelText('Your name')
    expect(summary.classList.contains('error-summary')).toBe(true)
    expect(summary.parentElement?.firstElementChild).toBe(summary)
    expect(document.activeElement).toBe(summary)
    expect(within(summary).getByRole('heading').textContent).toBe('Please check the form')
    expect(onSubmit).not.toHaveBeenCalled()
    Object.defineProperty(name, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    await user.click(within(summary).getByRole('link', { name: 'Your name: Enter your name.' }))
    expect(document.activeElement).toBe(name)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
    expect(document.activeElement).toBe(summary)
    fireEvent.change(name, { target: { value: 'Ada' } })
    expect(within(summary).queryByRole('link', { name: /Your name:/ })).toBeNull()
  })

  it('links server errors to guest rows and option groups with unique focusable IDs', async () => {
    const user = userEvent.setup()
    render(
      <Form
        initial={{ ...valid, guests: [{ name: 'Guest', email: '' }] }}
        questions={[topics]}
        serverErrors={{
          guests: 'The host no longer allows guests. Remove the guests to continue.',
          'q-topics': 'Choose at least one option.',
          'guest-0-email': 'Enter an email address.',
        }}
      />,
    )
    const summary = screen.getByRole('alert')
    for (const link of within(summary).getAllByRole('link')) {
      const target = document.getElementById(link.getAttribute('href')?.slice(1) ?? '')
      expect(target).not.toBeNull()
      await user.click(link)
      expect(document.activeElement).toBe(target)
    }
    expect(screen.getByRole('group', { name: 'Topics' }).classList.contains('choices')).toBe(true)
    expect(screen.getAllByRole('checkbox').every((box) => box.closest('.choice'))).toBe(true)
  })

  it.each(['client', 'server'] as const)(
    'lists %s errors in the rendered field order with questions before guests',
    async (source) => {
      const user = userEvent.setup()
      render(
        <Form
          initial={{
            ...valid,
            name: '',
            email: '',
            guests: [{ name: 'Guest', email: '' }],
          }}
          questions={[
            topics,
            { id: 'company', label: 'Company', type: 'short_text', required: true },
          ]}
          serverErrors={
            source === 'server'
              ? {
                  'guest-0-email': 'Enter an email address.',
                  'q-company': 'Enter an answer.',
                  guests: 'The host no longer allows guests. Remove the guests to continue.',
                  email: 'Enter an email address.',
                  'q-topics': 'Choose at least one option.',
                  name: 'Enter your name.',
                }
              : {}
          }
        />,
      )
      if (source === 'client') {
        await user.click(screen.getByRole('button', { name: 'Confirm booking' }))
      }
      const links = within(screen.getByRole('alert')).getAllByRole('link')
      const fields = links.map((link) =>
        document.getElementById(link.getAttribute('href')?.slice(1) ?? ''),
      )
      expect(fields.map((field) => field?.getAttribute('data-field'))).toEqual([
        'name',
        'email',
        'q-topics',
        'q-company',
        ...(source === 'server' ? ['guests'] : []),
        'guest-0-email',
      ])
      for (let i = 1; i < fields.length; i++) {
        expect(
          (fields[i - 1]?.compareDocumentPosition(fields[i] as HTMLElement) ?? 0) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      }
    },
  )

  it.each([
    [
      'en',
      'What would you like to discuss?',
      'What would you like to discuss? This answer is required.',
      'Your name: Enter your name.',
    ],
    ['zh-CN', '你想讨论什么？', '你想讨论什么？此问题为必答项。', '你的姓名：请输入你的姓名。'],
  ] as const)(
    'adds no second colon after a %s question label that already ends in punctuation',
    async (language, label, expected, plainLabel) => {
      chooseLanguage(language)
      const user = userEvent.setup()
      render(
        <Form
          initial={{ ...valid, name: '' }}
          questions={[{ id: 'topic', label, type: 'short_text', required: true }]}
        />,
      )
      await user.click(
        screen.getByRole('button', { name: language === 'en' ? 'Confirm booking' : '确认预约' }),
      )
      const summary = screen.getByRole('alert')
      expect(within(summary).getByRole('link', { name: expected })).toBeDefined()
      expect(within(summary).getByRole('link', { name: plainLabel })).toBeDefined()
    },
  )

  it('shows form-wide failures once in the same summary and localizes public headings', () => {
    chooseLanguage('zh-CN')
    const { rerender } = render(<Form formError="Check the form and try again." />)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('heading').textContent).toBe('无法保存')
    expect(screen.getByRole('alert').textContent).toContain('请检查表单后重试。')
    rerender(<Form serverErrors={{ email: 'Enter an email address.' }} />)
    expect(screen.getByRole('heading').textContent).toBe('请检查表单')
    expect(screen.getByRole('link').textContent).toBe('邮箱：请输入邮箱地址。')
  })
})
