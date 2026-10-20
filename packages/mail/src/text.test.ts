import { describe, expect, it } from 'vitest'
import {
  escapeHtml,
  formatChineseTemplate,
  linkableUrl,
  multiLine,
  singleLine,
  subjectLine,
} from './text.ts'

describe('formatChineseTemplate', () => {
  it.each([
    { name: 'Ada Lovelace', event: 'Intro call', expected: '与 Ada Lovelace 的 Intro call' },
    { name: '张三', event: '初次交流', expected: '与张三的初次交流' },
    { name: 'Zoë', event: 'Échange', expected: '与 Zoë 的 Échange' },
    { name: 'Andre\u0301', event: 'Intro call', expected: '与 Andre\u0301 的 Intro call' },
    { name: 'Ada李', event: '初次Intro交流', expected: '与 Ada李的初次Intro交流' },
    { name: '李Ada', event: 'Intro初次交流', expected: '与李Ada 的 Intro初次交流' },
    { name: 'Δημήτρης', event: '初次交流', expected: '与Δημήτρης的初次交流' },
  ])('spaces only Han/Latin boundaries for $name and $event', ({ name, event, expected }) => {
    expect(formatChineseTemplate('与{name}的{event}', { name, event })).toBe(expected)
  })

  it('preserves internal user text, punctuation and unrecognized placeholders', () => {
    expect(formatChineseTemplate('活动：{event}，{unknown}', { event: 'Intro中文{host}' })).toBe(
      '活动：Intro中文{host}，{unknown}',
    )
  })
})

describe('subjectLine', () => {
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
