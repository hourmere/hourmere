import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { errorMessage, RequestError } from '../api/errors.ts'
import { ErrorSummary, Field } from '../components/forms.tsx'
import { browserLocale } from '../test/browser-locale.ts'
import { admin } from './admin.ts'
import { common } from './common.ts'
import { AccountLanguage, InterfaceScope, LanguageSwitcher, useI18n } from './runtime.tsx'
import { chooseLanguage, resetLanguagePreference } from './store.ts'
import {
  dateMessage,
  isUiText,
  joinMessages,
  literal,
  type MessageKey,
  msg,
  registerCatalog,
  translate,
  translateMessage,
  type UiText,
} from './translate.ts'

registerCatalog(admin)
function Draft() {
  const { t, ui } = useI18n()
  const [draft, setDraft] = useState('Settings')
  const [problem, setProblem] = useState<UiText | null>(null)
  return (
    <>
      <LanguageSwitcher />
      <h1>{t('Your details')}</h1>
      <input
        aria-label="custom draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button
        type="button"
        onClick={() => setProblem(msg('Use at most {0} characters.', { '0': 200 }))}
      >
        check
      </button>
      {problem && <p role="alert">{ui(problem)}</p>}
    </>
  )
}

describe('typed interface messages and language state', () => {
  it.each(['fa-IR', 'th-TH'])(
    'formats dateMessage in the Gregorian calendar for browser locale %s',
    (locale) => {
      browserLocale(locale)
      const date = '2030-12-24'
      const expected = new Intl.DateTimeFormat(locale, {
        calendar: 'gregory',
        timeZone: 'UTC',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date(`${date}T00:00:00Z`))
      expect(translateMessage('en', dateMessage(date), { dateLocale: undefined })).toBe(expected)
    },
  )

  it('keeps interpolation placeholders in both complete catalogs', () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    for (const [key, chinese] of Object.entries({ ...common, ...admin })) {
      expect(chinese.length > 0, key).toBe(true)
      expect(placeholders(chinese), key).toEqual(placeholders(key))
    }
  })
  it('rerenders visible validation and preserves the same draft DOM node', async () => {
    const user = userEvent.setup()
    render(<Draft />)
    const field = screen.getByLabelText<HTMLInputElement>('custom draft')
    await user.type(field, ' untouched')
    await user.click(screen.getByRole('button', { name: 'check' }))
    expect(screen.getByRole('alert').textContent).toBe('Use at most 200 characters.')
    await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
    expect(screen.getByRole('heading').textContent).toBe('你的信息')
    expect(screen.getByRole('alert').textContent).toBe('最多 200 个字符。')
    expect(screen.getByLabelText('custom draft')).toBe(field)
    expect(field.value).toBe('Settings untouched')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(localStorage.getItem('hourmere-language')).toBe('zh-CN')
    expect(document.cookie).toContain('hourmere-language=zh-CN')
  })
  it('uses explicit preference before the already loaded account default and browser fallback', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
    render(
      <AccountLanguage locale="zh-Hans-CN">
        <Draft />
      </AccountLanguage>,
    )
    expect(screen.getByRole('heading').textContent).toBe('你的信息')
    await user.selectOptions(screen.getByLabelText('界面语言'), 'en')
    expect(screen.getByRole('heading').textContent).toBe('Your details')
  })
  it('uses browser language when no supported account default exists', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['qab', 'zh-CN'])
    render(
      <AccountLanguage locale="qac">
        <Draft />
      </AccountLanguage>,
    )
    expect(screen.getByRole('heading').textContent).toBe('你的信息')
  })
  it.each([
    { preference: 'de', account: 'zh-CN' },
    { preference: 'de', account: undefined },
    { preference: undefined, account: 'de' },
    { preference: 'de', account: 'de' },
  ] as const)(
    'skips unavailable admin candidates before the account and browser language: %j',
    ({ preference, account }) => {
      if (preference) chooseLanguage(preference)
      vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-CN'])
      render(
        <InterfaceScope surface="admin">
          <AccountLanguage locale={account}>
            <Draft />
          </AccountLanguage>
        </InterfaceScope>,
      )
      expect(screen.getByRole('heading').textContent).toBe('你的信息')
      expect(screen.getByLabelText<HTMLSelectElement>('界面语言').value).toBe('zh-CN')
      expect(localStorage.getItem('hourmere-language')).toBe(preference ?? null)
    },
  )
  it('uses an available account language before the browser after skipping a public preference', () => {
    chooseLanguage('de')
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-CN'])
    render(
      <InterfaceScope surface="admin">
        <AccountLanguage locale="en">
          <Draft />
        </AccountLanguage>
      </InterfaceScope>,
    )
    expect(screen.getByRole('heading').textContent).toBe('Your details')
  })
  it('keeps an explicit German preference on the public surface before account and browser Chinese', () => {
    chooseLanguage('de')
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['zh-CN'])
    render(
      <InterfaceScope surface="public">
        <AccountLanguage locale="zh-CN">
          <Draft />
        </AccountLanguage>
      </InterfaceScope>,
    )
    expect(screen.getByRole('heading').textContent).toBe('Ihre Angaben')
    expect(screen.getByLabelText<HTMLSelectElement>('Sprache der Benutzeroberfläche').value).toBe(
      'de',
    )
  })
  it('formats in Chinese when it follows an unsupported browser language', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['qab', 'zh-CN'])
    function DateNotice() {
      const { ui, formatLocale } = useI18n()
      return (
        <>
          <output data-testid="format-locale">{formatLocale}</output>
          <p>{ui(dateMessage('2026-11-02'))}</p>
        </>
      )
    }
    render(<DateNotice />)
    expect(screen.getByTestId('format-locale').textContent).toBe('zh-CN')
    expect(screen.getByText(/11月/)).toBeDefined()
  })
  it('keeps the current tab working when both preference stores reject access', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(document, 'cookie', 'get').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(document, 'cookie', 'set').mockImplementation(() => {
      throw new Error('denied')
    })
    resetLanguagePreference()
    render(<Draft />)
    await act(async () => chooseLanguage('zh-CN'))
    expect(screen.getByRole('heading').textContent).toBe('你的信息')
    fireEvent.change(screen.getByLabelText('custom draft'), { target: { value: 'Still editable' } })
    expect(screen.getByLabelText<HTMLInputElement>('custom draft').value).toBe('Still editable')
  })
  it('keeps custom arguments and unknown server prose literal while translating known code messages', () => {
    expect(translate('zh-CN', 'Created “{0}”.', { '0': 'Settings' })).toBe('已创建“Settings”。')
    expect(translateMessage('zh-CN', literal('Settings'))).toBe('Settings')
    expect(
      translateMessage(
        'zh-CN',
        errorMessage(new RequestError(409, 'unknown_future_code', 'Settings')),
      ),
    ).toBe('Settings')
    expect(
      translateMessage('zh-CN', errorMessage(new RequestError(403, 'forbidden', 'arbitrary'))),
    ).toBe('你没有执行此操作的权限。')
    const nested = msg('Could not cancel the booking. {0}', {
      '0': errorMessage(new TypeError('offline')),
    })
    expect(translateMessage('zh-CN', nested)).toContain('无法取消预约。无法连接 Hourmere。')
  })
  it('formats dates and nested overlap pairs after the language changes', () => {
    const notice = msg('Removed the override for {0}.', { '0': dateMessage('2026-11-02') })
    expect(translateMessage('en', notice)).toContain('Nov')
    expect(translateMessage('zh-CN', notice)).toContain('11月')
    const problem = msg('These hours overlap: {0}.', {
      '0': joinMessages([
        msg('{first} and {second}', { first: '09:00–12:00', second: '11:00–14:00' }),
      ]),
    })
    expect(translateMessage('zh-CN', problem)).toBe('以下时间段重叠：09:00–12:00 与 11:00–14:00。')
  })
  it('formats dates in the active account locale before a switcher choice', async () => {
    const user = userEvent.setup()
    const date = dateMessage('2026-11-02')
    function DateNotice() {
      const { ui, formatLocale } = useI18n()
      return (
        <>
          <LanguageSwitcher />
          <p data-testid="date-format-locale">{formatLocale ?? 'browser-default'}</p>
          <p data-testid="notice-date">{ui(msg('Removed the override for {0}.', { '0': date }))}</p>
        </>
      )
    }
    render(
      <AccountLanguage locale="zh-Hans-CN">
        <DateNotice />
      </AccountLanguage>,
    )
    expect(screen.getByTestId('date-format-locale').textContent).toBe('zh-CN')
    expect(screen.getByTestId('notice-date').textContent).toContain('11月')
    await user.selectOptions(screen.getByLabelText('界面语言'), 'zh-CN')
    expect(screen.getByTestId('date-format-locale').textContent).toBe('zh-CN')
    expect(screen.getByTestId('notice-date').textContent).toContain('11月')
    expect(translateMessage('zh-CN', date, { dateLocale: 'en-GB' })).toContain('Nov')
  })

  it.each(['Email', 'Settings', 'Unknown service detail', '邮箱'])(
    'preserves literal %s through field and error summary components after language changes',
    async (detail) => {
      const user = userEvent.setup()
      render(
        <>
          <LanguageSwitcher />
          <Field id="server-field" label="Custom server field" error={literal(detail)}>
            {(control) => <input {...control} />}
          </Field>
          <ErrorSummary
            errors={{ 'server-field': literal(detail) }}
            labels={{ 'server-field': literal('Email') }}
            message={literal(detail)}
            attempt={1}
          />
        </>,
      )
      const fieldError = document.getElementById('server-field-error')
      expect(fieldError?.textContent?.endsWith(detail)).toBe(true)
      await user.selectOptions(screen.getByLabelText('Interface language'), 'zh-CN')
      expect(fieldError?.textContent?.endsWith(detail)).toBe(true)
      expect(screen.getByRole('alert').querySelector('p')?.textContent).toBe(detail)
      expect(screen.getByRole('alert').querySelector('a')?.textContent).toBe(`Email：${detail}`)
      await user.selectOptions(screen.getByLabelText('界面语言'), 'en')
      expect(fieldError?.textContent?.endsWith(detail)).toBe(true)
      expect(screen.getByRole('alert').querySelector('p')?.textContent).toBe(detail)
    },
  )

  it('rejects inherited keys and malformed or unbounded history records', () => {
    for (const key of ['__proto__', 'constructor', 'toString'])
      expect(translate('zh-CN', key as MessageKey)).toBe(key)
    expect(isUiText(Object.create({ key: 'Settings', values: {} }))).toBe(false)
    expect(isUiText({ key: 'Settings', values: new Date() })).toBe(false)
    expect(isUiText({ key: 'constructor', values: {} })).toBe(false)
    expect(isUiText({ key: 'Settings', values: { value: 'x'.repeat(5001) } })).toBe(false)
    expect(isUiText({ key: 'Settings', values: {}, extra: true })).toBe(false)
    expect(isUiText({ date: 'invalid' })).toBe(false)
    expect(isUiText({ items: [], separator: 'unbounded' })).toBe(false)
    expect(isUiText(msg('Created “{0}”.', { '0': 'My custom title' }))).toBe(true)
  })
})
