import type { InterfaceLanguage } from '@hourmere/core/language'
import type { ReactNode } from 'react'

/** Keep string translations available for attributes; only visible quote glyphs get markup. */
export function renderUiText(locale: InterfaceLanguage, text: string): ReactNode {
  if (locale !== 'zh-CN') return text
  return text.split(/([“”])/u).map((part, index) =>
    /^[“”]$/u.test(part) ? (
      // The index identifies a glyph's position in this immutable translated string.
      // biome-ignore lint/suspicious/noArrayIndexKey: text fragments have no independent state
      <span className="cjk-quote" key={index}>
        {part}
      </span>
    ) : (
      part
    ),
  )
}
