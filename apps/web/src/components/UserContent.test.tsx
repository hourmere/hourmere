import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AccountLanguage } from '../i18n/runtime.tsx'
import { UserContentLines, UserContentList, UserContentMessage } from './UserContent.tsx'

describe('user content boundaries', () => {
  it.each([
    ['en', 'Your Échange with Ada is confirmed.', ['Échange', 'Ada']],
    ['zh-CN', '你与 Ada 的“Échange”预约已确认。', ['Ada', 'Échange']],
  ] as const)(
    'preserves %s placeholder order, punctuation and spacing',
    (locale, expected, slots) => {
      render(
        <AccountLanguage locale={locale}>
          <button type="button">
            <UserContentMessage
              message="Your {event} with {host} is confirmed."
              values={{ event: 'Échange', host: 'Ada' }}
            />
          </button>
        </AccountLanguage>,
      )
      const button = screen.getByRole('button')
      expect(button.textContent).toBe(expected)
      expect(Array.from(button.querySelectorAll('bdi'), (item) => item.textContent)).toEqual(slots)
    },
  )

  it('keeps a name and bracketed email separate while retaining exact text', () => {
    const name = '✨ 42 ليلى (Ada)'
    const email = 'ada@example.invalid'
    render(
      <AccountLanguage locale="en">
        <p>
          <UserContentMessage
            message="{name} ({detail})"
            values={{ name, detail: email }}
            renderValues={{ detail: <bdi dir="ltr">{email}</bdi> }}
          />
        </p>
      </AccountLanguage>,
    )
    const paragraph = screen.getByRole('paragraph')
    expect(paragraph.textContent).toBe(`${name} (${email})`)
    expect(Array.from(paragraph.querySelectorAll('bdi'), (item) => item.textContent)).toEqual([
      name,
      email,
    ])
    expect(paragraph.querySelector('bdi[dir="ltr"]')?.textContent).toBe(email)
  })

  it('isolates repeated list values independently with localized separators', () => {
    const values = ['(שלום)', '王小明', '42?!', '(שלום)']
    render(
      <AccountLanguage locale="zh-CN">
        <p>
          <UserContentList values={values} />
        </p>
      </AccountLanguage>,
    )
    const paragraph = screen.getByRole('paragraph')
    expect(paragraph.textContent).toBe('(שלום)、王小明、42?!、(שלום)')
    expect(Array.from(paragraph.querySelectorAll('bdi'), (item) => item.textContent)).toEqual(
      values,
    )
  })

  it('retains blank lines, Unicode separators and literal angle brackets', () => {
    const text = 'مرحبا (A)\r\n\r\nLatin עברית\u2029[123] <bdi>\n'
    render(
      <p>
        <UserContentLines text={text} />
      </p>,
    )
    const paragraph = screen.getByRole('paragraph')
    expect(paragraph.textContent).toBe(text)
    expect(Array.from(paragraph.querySelectorAll('bdi'), (item) => item.textContent)).toEqual([
      'مرحبا (A)',
      'Latin עברית',
      '[123] <bdi>',
    ])
  })
})
