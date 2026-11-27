import { describe, expect, it } from 'vitest'
import { isPublicHttpsUrl } from './destination.ts'

describe('public HTTPS destinations', () => {
  it.each(['home.arpa', 'idp.home.arpa', 'idp.alt', 'service.arpa', 'idp.service.arpa'])(
    'refuses special-use name %s',
    (hostname) => {
      expect(isPublicHttpsUrl(new URL(`https://${hostname}/`))).toBe(false)
    },
  )

  it.each(['xhome.arpa', 'home.arpa.example.com', 'example.alt.com'])('accepts %s', (hostname) => {
    expect(isPublicHttpsUrl(new URL(`https://${hostname}/`))).toBe(true)
  })
})
