import { describe, expect, it } from 'vitest'
import { htmlHasLink, icsHasLocation, textHasUrl } from './booking-link-testing.ts'

const join = 'https://meet.google.com/abc-defg-hij'
const lookalikes = [
  `https://attacker.invalid/${join}`,
  `${join}.attacker.invalid`,
  `${join}?redirect=https://attacker.invalid`,
]

describe('complete generated booking links in test assertions', () => {
  it('finds an exact text URL with either language label', () => {
    expect(textHasUrl(`Where: Google Meet: ${join}\n`, join)).toBe(true)
    expect(textHasUrl(`地点：Google Meet：${join}\n`, join)).toBe(true)
  })

  it.each(lookalikes)('rejects a text URL containing the expected URL: %s', (value) => {
    expect(textHasUrl(`Where: Google Meet: ${value}\n`, join)).toBe(false)
  })

  it('finds the complete generated HTML href, with HTML escaping', () => {
    expect(htmlHasLink(`<a href="${join}">Join</a>`, join)).toBe(true)
    expect(
      htmlHasLink(
        '<a href="https://example.invalid/?a=1&amp;b=2">Join</a>',
        'https://example.invalid/?a=1&b=2',
      ),
    ).toBe(true)
    expect(htmlHasLink(`<p>${join}</p>`, join)).toBe(false)
  })

  it.each(lookalikes)('rejects an href containing the expected URL: %s', (value) => {
    expect(htmlHasLink(`<a href="${value}">Join</a>`, join)).toBe(false)
  })

  it('finds only the complete unfolded calendar LOCATION', () => {
    expect(icsHasLocation(`LOCATION:${join}\r\n`, join)).toBe(true)
    expect(icsHasLocation('LOCATION:https://meet.google.com/abc-\r\n defg-hij\r\n', join)).toBe(
      true,
    )
    expect(icsHasLocation(`LOCATION:Google Meet: ${join}\r\n`, `Google Meet: ${join}`)).toBe(true)
    expect(icsHasLocation(`DESCRIPTION:${join}\r\n`, join)).toBe(false)
  })

  it.each(lookalikes)('rejects a calendar location containing the expected URL: %s', (value) => {
    expect(icsHasLocation(`LOCATION:${value}\r\n`, join)).toBe(false)
  })
})
