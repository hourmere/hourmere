import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { admin } from './admin.ts'
import { common } from './common.ts'
import { type MessageKey, registerCatalog, translate } from './translate.ts'

registerCatalog(admin)

describe('rendered Chinese catalogue punctuation', () => {
  it.each([
    ['common', common],
    ['admin', admin],
  ] as const)(
    'keeps full-width punctuation unspaced and sentence endings full-width in %s',
    (_name, catalogue) => {
      const entries = Object.keys(catalogue).map((key) => {
        const values = Object.fromEntries(
          [...key.matchAll(/\{(\w+)\}/g)].map((match) => [match[1], '示例']),
        )
        return { key, text: translate('zh-CN', key as MessageKey, values) }
      })
      const { container } = render(
        <div>
          {entries.map(({ key, text }) => (
            <p key={key}>{text}</p>
          ))}
        </div>,
      )
      // No exceptions: placeholders are synthetic prose, so URLs, decimals and user
      // punctuation cannot disguise a catalogue sentence's final ASCII full stop.
      for (const [index, paragraph] of [...container.querySelectorAll('p')].entries()) {
        const text = paragraph.textContent ?? ''
        const key = entries[index]?.key
        expect(text, key).not.toMatch(/[。，][ \t]+/)
        expect(text, key).not.toMatch(/\p{Script=Han}[^\n]*\.[ \t]*$/u)
      }
    },
  )
})
