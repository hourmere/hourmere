import { describe, expect, it } from 'vitest'
import { describeLocation } from './booking-format.ts'

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
