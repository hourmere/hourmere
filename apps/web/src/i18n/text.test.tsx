import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConfirmAction } from '../components/ConfirmAction.tsx'
import { Field } from '../components/forms.tsx'
import styles from '../styles.css?raw'
import { admin } from './admin.ts'
import { LanguageSwitcher, useI18n } from './runtime.tsx'
import { chooseLanguage } from './store.ts'
import { renderUiText } from './text.tsx'
import { msg, registerCatalog } from './translate.ts'

registerCatalog(admin)

describe('Chinese quote typography', () => {
  it('wraps only double quote glyphs, preserving escaped text and Latin letters', () => {
    const content = '“Intro <img src=x>”与‘Working hours’'
    const { container } = render(<p>{renderUiText('zh-CN', content)}</p>)
    expect(container.textContent).toBe(content)
    expect([...container.querySelectorAll('.cjk-quote')].map((node) => node.textContent)).toEqual([
      '“',
      '”',
    ])
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelectorAll('span')).toHaveLength(2)
  })

  it('does not widen apostrophes in user-entered Latin names and titles in Chinese', () => {
    const content = '你与O’Brien的“Ada’s plan”预约已确认'
    const { container } = render(<p>{renderUiText('zh-CN', content)}</p>)
    expect(container.textContent).toBe(content)
    expect([...container.querySelectorAll('.cjk-quote')].map((node) => node.textContent)).toEqual([
      '“',
      '”',
    ])
  })

  it.each(['O’Brien', 'Ada’s plan', '‘Latin words’'])(
    'preserves %s in Chinese text without quote markup',
    (latin) => {
      const content = `中文${latin}预约`
      const { container } = render(<p>{renderUiText('zh-CN', content)}</p>)
      expect(container.textContent).toBe(content)
      expect(container.querySelector('span')).toBeNull()
    },
  )

  it('leaves English text untouched', () => {
    const content = '“Intro” and ‘Working hours’'
    const { container } = render(<p>{renderUiText('en', content)}</p>)
    expect(container.textContent).toBe(content)
    expect(container.querySelector('span')).toBeNull()
  })

  it('rerenders translated visible text with quote spans while attributes stay strings', () => {
    function Notice() {
      const { t, text, uiText } = useI18n()
      return (
        <>
          <LanguageSwitcher />
          <h1 title={t('Edit “{0}”', { '0': 'Intro' })}>{text('Edit “{0}”', { '0': 'Intro' })}</h1>
          <p role="status">{uiText(msg('Created “{0}”.', { '0': 'Intro' }))}</p>
        </>
      )
    }
    render(<Notice />)
    const heading = screen.getByRole('heading')
    expect(heading.querySelector('span')).toBeNull()
    fireEvent.change(screen.getByLabelText('Interface language'), { target: { value: 'zh-CN' } })
    expect(heading.textContent).toBe('编辑“Intro”')
    expect(heading.title).toBe('编辑“Intro”')
    expect(screen.getByRole('heading', { name: '编辑“Intro”' })).toBe(heading)
    expect(heading.querySelectorAll('.cjk-quote')).toHaveLength(2)
    expect(screen.getByRole('status').querySelectorAll('.cjk-quote')).toHaveLength(2)
    fireEvent.change(screen.getByLabelText('界面语言'), { target: { value: 'en' } })
    expect(heading.querySelector('span')).toBeNull()
  })

  it('uses rich text in shared field hints and confirmation prompts', () => {
    chooseLanguage('zh-CN')
    render(
      <>
        <Field
          id="name"
          label="名称"
          optional
          hint="例如“Intro”。"
          error={msg('Created “{0}”.', { '0': 'Intro' })}
        >
          {(props) => <input {...props} />}
        </Field>
        <ConfirmAction
          label="Delete schedule"
          prompt="Delete “Intro”? This cannot be undone."
          confirmLabel="Delete"
          busyLabel="Deleting…"
          failure="Could not save"
          onConfirm={async () => {}}
        />
      </>,
    )
    expect(document.querySelector('label')?.textContent).toBe('名称（可选）')
    expect(screen.getByLabelText('名称（可选）')).toBeDefined()
    expect(document.getElementById('name-hint')?.querySelectorAll('.cjk-quote')).toHaveLength(2)
    expect(document.getElementById('name-error')?.querySelectorAll('.cjk-quote')).toHaveLength(2)
    expect(document.querySelector('#name-error .visually-hidden')?.textContent).toBe('错误：')
    fireEvent.click(screen.getByRole('button', { name: '删除日程' }))
    expect(screen.getByRole('group').querySelectorAll('.cjk-quote')).toHaveLength(2)
  })

  it('uses CJK fonts before Latin system fonts for Chinese quote spans', () => {
    const quote = styles.match(/\.cjk-quote:lang\(zh\)\s*\{([^}]+)\}/)?.[1]
    expect(quote).toMatch(
      /font-family:\s*"PingFang SC",\s*"Hiragino Sans GB",\s*"Microsoft YaHei",\s*"Noto Sans CJK SC",\s*"Source Han Sans SC",\s*sans-serif;/,
    )
  })

  it('restricts full-width font features to Chinese quote spans and balances headings', () => {
    const quote = styles.match(/\.cjk-quote:lang\(zh\)\s*\{([^}]+)\}/)?.[1]
    expect(quote).toContain('font-variant-east-asian: full-width;')
    expect(quote).toContain('font-feature-settings: "fwid";')
    expect(styles).toMatch(
      /h1:lang\(zh\),\s*h2:lang\(zh\),\s*h3:lang\(zh\)\s*\{\s*text-wrap: balance;/,
    )
  })
})
