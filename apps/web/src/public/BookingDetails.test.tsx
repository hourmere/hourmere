import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LocationDetails, locationText } from './BookingDetails.tsx'

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
