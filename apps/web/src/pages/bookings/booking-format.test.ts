import { describe, expect, it } from 'vitest'
import { answerText, describeLocation } from './booking-format.ts'

describe('booking location links', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/meeting',
    '//example.com/meeting',
    'invalid',
  ])('shows %s as text only', (url) => {
    expect(describeLocation({ kind: 'link', url })).toEqual({
      label: 'Online meeting',
      detail: url,
      href: null,
    })
  })

  it.each(['http://example.com/meeting', 'https://example.com/meeting'])(
    'makes %s clickable',
    (url) => {
      expect(describeLocation({ kind: 'link', url })?.href).toBe(url)
    },
  )
})

describe('booking answer text', () => {
  it.each([
    ['zh-CN', 'Pro、Team'],
    ['en', 'Pro, Team'],
  ])('formats selected options in %s', (locale, expected) => {
    expect(answerText(['Pro', 'Team'], locale)).toBe(expected)
    expect(answerText([], locale)).toBeNull()
    expect(answerText(undefined, locale)).toBeNull()
    expect(answerText('Settings', locale)).toBe('Settings')
    expect(answerText(true, locale)).toBe('Yes')
  })
})
