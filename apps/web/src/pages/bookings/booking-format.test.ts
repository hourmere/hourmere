import { describe, expect, it } from 'vitest'
import { translateMessage } from '../../i18n/translate.ts'
import { booking } from '../../test/fixtures.ts'
import { answerText, bookingTitle, bookingUpdate, describeLocation } from './booking-format.ts'

describe('booking title metadata on updates', () => {
  const current = booking({ eventTypeTitle: '初次通话' })

  it('keeps title metadata after a same-booking mutation omits it', () => {
    const updated = booking({ status: 'cancelled' })
    expect(bookingUpdate(current, updated)).toMatchObject({
      eventTypeTitle: '初次通话',
      status: 'cancelled',
    })
  })

  it('never carries title metadata to a successor or another booking', () => {
    const successor = booking({ id: 'successor' })
    expect(bookingUpdate(current, successor)).not.toHaveProperty('eventTypeTitle')
  })

  it.each([null, 'Renamed event'])('accepts authoritative refreshed title metadata %s', (title) => {
    expect(bookingUpdate(current, booking({ eventTypeTitle: title })).eventTypeTitle).toBe(title)
  })
})

describe('booking title composition', () => {
  it.each([
    ['en', 'Grace Hopper', '初次通话 with Grace Hopper'],
    ['zh-CN', 'Grace Hopper', '与 Grace Hopper 的初次通话'],
    ['zh-CN', '王小明', '与王小明的初次通话'],
    ['zh-CN', 'O’Brien', '与 O’Brien 的初次通话'],
    ['zh-CN', 'Ada’s team', '与 Ada’s team 的初次通话'],
  ] as const)('composes a verified generated title in %s for %s', (locale, name, expected) => {
    const current = booking({ eventTypeTitle: '初次通话', title: `初次通话 with ${name}` })
    current.attendees = current.attendees.map((a) => (a.isBooker ? { ...a, name } : a)).reverse()
    expect(translateMessage(locale, bookingTitle(current, locale))).toBe(expected)
  })

  it.each([
    { title: 'Design with Grace Hopper and friends', eventTypeTitle: 'Design' },
    { title: 'Old title with Grace Hopper', eventTypeTitle: 'New title' },
    { title: 'Intro call with Grace Hopper', eventTypeTitle: null },
    { title: 'Intro call with Grace Hopper' },
    { title: 'Intro call with Alan Turing', eventTypeTitle: 'Intro call' },
    { title: 'Settings', eventTypeTitle: 'Intro call' },
    { title: 'Cancel booking', eventTypeTitle: 'Intro call' },
    { title: 'Intro call with Grace Hopper', eventTypeTitle: 'Intro call', attendees: [] },
  ])('preserves an unverified, custom or historical title: $title', (overrides) => {
    const current = booking(overrides)
    expect(translateMessage('zh-CN', bookingTitle(current, 'zh-CN'))).toBe(current.title)
  })
})

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
