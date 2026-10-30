import { describe, expect, it } from 'vitest'
import {
  emailText,
  escapeHtml,
  formatChineseTemplate,
  linkableUrl,
  multiLine,
  singleLine,
  subjectLine,
} from './text.ts'

describe('emailText', () => {
  it.each(['“', '”'])('widens only the Chinese %s glyph', (quote) => {
    expect(emailText(`中${quote}Latin${quote}文`, 'zh-CN')).toBe(
      `中<span class="cjk-quote" style="font-family: &quot;PingFang SC&quot;,&quot;Hiragino Sans GB&quot;,&quot;Microsoft YaHei&quot;,&quot;Noto Sans CJK SC&quot;,&quot;Source Han Sans SC&quot;,sans-serif; font-variant-east-asian: full-width; font-feature-settings: 'fwid';">${quote}</span>Latin<span class="cjk-quote" style="font-family: &quot;PingFang SC&quot;,&quot;Hiragino Sans GB&quot;,&quot;Microsoft YaHei&quot;,&quot;Noto Sans CJK SC&quot;,&quot;Source Han Sans SC&quot;,sans-serif; font-variant-east-asian: full-width; font-feature-settings: 'fwid';">${quote}</span>文`,
    )
  })

  it('uses a CJK font before system fonts so Chinese double quotes can be full-width', () => {
    const html = emailText('“中文”', 'zh-CN')
    const styles = [...html.matchAll(/<span class="cjk-quote" style="([^"]*)">/g)]
    expect(styles).toHaveLength(2)
    for (const [, style] of styles) {
      expect(style).toMatch(/^font-family: &quot;PingFang SC&quot;,/)
      expect(style).toContain(
        '&quot;Hiragino Sans GB&quot;,&quot;Microsoft YaHei&quot;,&quot;Noto Sans CJK SC&quot;,&quot;Source Han Sans SC&quot;,sans-serif;',
      )
      expect(style).toContain('font-variant-east-asian: full-width;')
      expect(style).toContain("font-feature-settings: 'fwid';")
    }
  })

  it.each(['O’Brien', 'Ada’s plan', '‘Latin words’'])('preserves %s in Chinese text', (text) => {
    expect(emailText(`中文${text}预约`, 'zh-CN')).toBe(`中文${text}预约`)
  })

  it('leaves English curly quotes and unquoted Chinese text untouched', () => {
    expect(emailText('“Latin” ‘words’ 中文', 'en')).toBe('“Latin” ‘words’ 中文')
    expect(emailText('中文 Latin', 'zh-CN')).toBe('中文 Latin')
  })

  it('escapes untrusted HTML before wrapping Chinese quotes', () => {
    expect(emailText('<img src="x"> & “字”', 'zh-CN')).toBe(
      '&lt;img src=&quot;x&quot;&gt; &amp; <span class="cjk-quote" style="font-family: &quot;PingFang SC&quot;,&quot;Hiragino Sans GB&quot;,&quot;Microsoft YaHei&quot;,&quot;Noto Sans CJK SC&quot;,&quot;Source Han Sans SC&quot;,sans-serif; font-variant-east-asian: full-width; font-feature-settings: \'fwid\';">“</span>字<span class="cjk-quote" style="font-family: &quot;PingFang SC&quot;,&quot;Hiragino Sans GB&quot;,&quot;Microsoft YaHei&quot;,&quot;Noto Sans CJK SC&quot;,&quot;Source Han Sans SC&quot;,sans-serif; font-variant-east-asian: full-width; font-feature-settings: \'fwid\';">”</span>',
    )
  })
})

describe('formatChineseTemplate', () => {
  // Keep these boundary cases parallel with apps/web/src/i18n/copy.test.tsx.
  it.each([
    { name: 'Ada Lovelace', event: 'Intro call', expected: '与 Ada Lovelace 的 Intro call' },
    { name: '王小明', event: '初次通话', expected: '与王小明的初次通话' },
    { name: '张三', event: '初次交流', expected: '与张三的初次交流' },
    { name: '王小明', event: 'Ada’s review', expected: '与王小明的 Ada’s review' },
    { name: 'Grace Hopper', event: 'Ada’s review', expected: '与 Grace Hopper 的 Ada’s review' },
    { name: 'O’Brien', event: '初次通话', expected: '与 O’Brien 的初次通话' },
    { name: 'Zoë', event: 'Échange', expected: '与 Zoë 的 Échange' },
    { name: 'André', event: 'Intro call', expected: '与 André 的 Intro call' },
    { name: 'Andre\u0301', event: 'Intro call', expected: '与 Andre\u0301 的 Intro call' },
    { name: 'José', event: '初次通话', expected: '与 José 的初次通话' },
    { name: 'Rene\u0301', event: 'Échange', expected: '与 Rene\u0301 的 Échange' },
    { name: 'Échange', event: '初次交流', expected: '与 Échange 的初次交流' },
    { name: 'Ada李', event: '初次Intro交流', expected: '与 Ada李的初次Intro交流' },
    { name: '李Ada', event: 'Intro初次交流', expected: '与李Ada 的 Intro初次交流' },
    { name: '3M', event: '初次通话', expected: '与 3M 的初次通话' },
    { name: '123', event: '初次通话', expected: '与 123 的初次通话' },
    { name: 'Δημήτρης', event: '初次交流', expected: '与Δημήτρης的初次交流' },
    { name: 'α测试', event: '初次交流', expected: '与α测试的初次交流' },
    { name: 'Zoom.', event: '初次交流', expected: '与 Zoom.的初次交流' },
    { name: 'v1.0)', event: '初次交流', expected: '与 v1.0)的初次交流' },
    { name: 'ＡＢＣ', event: '初次交流', expected: '与ＡＢＣ的初次交流' },
    { name: 'ａｂｃ', event: '初次交流', expected: '与ａｂｃ的初次交流' },
    { name: '０１２', event: '初次交流', expected: '与０１２的初次交流' },
  ])('spaces Han/Latin or digit boundaries for $name and $event', ({ name, event, expected }) => {
    expect(formatChineseTemplate('与{name}的{event}', { name, event })).toBe(expected)
  })

  it('preserves internal user text, punctuation and unrecognized placeholders', () => {
    expect(formatChineseTemplate('活动：{event}，{unknown}', { event: 'Intro中文{host}' })).toBe(
      '活动：Intro中文{host}，{unknown}',
    )
  })
})

describe('subjectLine', () => {
  it.each(['\u00a0', '\u202f'])(
    'preserves non-breaking typography %j while removing header controls',
    (space) => {
      expect(
        subjectLine(`  Confirmation${space}:  Réunion\r\nBcc: victim@example.test\u202e  `),
      ).toBe(`Confirmation${space}: Réunion Bcc: victim@example.test`)
      expect(subjectLine(`Invitation «${space}Équipe${space}»${space}!`)).toBe(
        `Invitation «${space}Équipe${space}»${space}!`,
      )
    },
  )

  it('keeps a subject on one line, so it cannot end the header and start another', () => {
    expect(subjectLine('Hello\r\nBcc: victim@example.com')).toBe('Hello Bcc: victim@example.com')
    expect(subjectLine('a\u2028b\u2029c\u0085d\u000be\u202ef')).toBe('a b c d e f')
  })

  it('caps the length', () => {
    const subject = subjectLine(`${'word '.repeat(100)}end`, 50)
    expect(subject).toHaveLength(50)
    expect(subject.endsWith('…')).toBe(true)
    expect(subjectLine('short', 50)).toBe('short')
  })
})

describe('singleLine and multiLine', () => {
  it('turns control characters into spaces on one line', () => {
    expect(singleLine('  Ada\n\tLovelace\u0000 ')).toBe('Ada Lovelace')
  })

  it('keeps line breaks of multi-line text and drops other control characters', () => {
    expect(multiLine('one\r\ntwo\rthree\u2028four\u0007\u202e')).toBe('one\ntwo\nthree\nfour')
  })
})

describe('escapeHtml', () => {
  it('escapes the characters that matter in text and attributes', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    )
  })
})

describe('linkableUrl', () => {
  it('accepts absolute http(s) URLs only', () => {
    expect(linkableUrl(' https://meet.example.com/abc ')).toBe('https://meet.example.com/abc')
    expect(linkableUrl('http://example.com')).toBe('http://example.com')
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//example.com', 'https://']) {
      expect(linkableUrl(bad), bad).toBeUndefined()
    }
  })
})
