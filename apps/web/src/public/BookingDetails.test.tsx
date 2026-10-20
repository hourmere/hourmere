import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import { translateMessage } from '../i18n/translate.ts'
import { LocationDetails, locationText, When } from './BookingDetails.tsx'

it('keeps the numeric offset in an unbroken span', () => {
  const { container } = render(
    <When
      start="2026-07-01T14:00:00Z"
      end="2026-07-01T14:30:00Z"
      timeZone="America/Los_Angeles"
      locale="en-US"
    />,
  )
  expect(container.querySelector('.time-offset')?.textContent).toBe('GMT-07:00)')
})

describe('pure conference location presentation', () => {
  it('shows a trusted participant link and preserves its capability only in the protected display', () => {
    const url = 'https://us02web.zoom.us/j/81234567890?pwd=synthetic-only.1'
    render(<LocationDetails location={{ kind: 'zoom', autoCreate: true, url }} />)
    expect(screen.getByRole('link').getAttribute('href')).toBe(url)
    expect(screen.getByRole('link').getAttribute('rel')).toContain('noreferrer')
    expect(locationText({ kind: 'zoom', autoCreate: true, url })).toBe(`Zoom: ${url}`)
  })
  it.each([
    'https://evil.invalid/j/81234567890',
    'https://us02web.zoom.us/j/81234567890?start_url=private',
    'javascript:alert(1)',
  ])('never renders or exports untrusted provider detail %s', (url) => {
    render(<LocationDetails location={{ kind: 'zoom', autoCreate: true, url }} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(locationText({ kind: 'zoom', autoCreate: true, url })).toBe('Zoom')
  })
})

describe('localized booking detail punctuation', () => {
  it.each([
    [{ kind: 'phone', number: '+14155550123' }, '电话会议：+14155550123'],
    [{ kind: 'in_person', address: 'Meeting room' }, '线下见面：Meeting room'],
    [
      { kind: 'link', url: 'https://example.invalid/meeting' },
      '线上会议：https://example.invalid/meeting',
    ],
  ] as const)('localizes the colon before %s details', (location, expected) => {
    chooseLanguage('zh-CN')
    const { container } = render(<LocationDetails location={location} />)
    expect(container.textContent).toBe(expected)
    expect(
      locationText(
        location,
        (key) => translateMessage('zh-CN', key),
        translateMessage('zh-CN', ': '),
      ),
    ).toBe(expected)
  })
  it('uses Chinese brackets and comma for the displayed zone', () => {
    chooseLanguage('zh-CN')
    const { container } = render(
      <When
        start="2026-11-02T14:00:00Z"
        end="2026-11-02T14:30:00Z"
        timeZone="Europe/Berlin"
        locale="zh-CN"
      />,
    )
    expect(container.querySelector('.muted')?.textContent).toBe('（Europe/Berlin，GMT+01:00）')
  })
})
