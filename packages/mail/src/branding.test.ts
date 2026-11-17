import { brandColorContrast, brandPalette } from '@hourmere/core/brand-contrast'
import { describe, expect, it } from 'vitest'
import { brandEmail } from './branding.ts'
import { emailButton, emailLayout, emailLinkStyle } from './layout.ts'

const logo =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII='
const message = {
  to: 'invitee@example.com',
  subject: 'Meeting',
  text: 'Hourmere\nMeeting\n',
  html: emailLayout(
    'en',
    'Meeting',
    `${emailButton('Manage', 'https://example.com/booking')}${emailButton('Cancel', 'https://example.com/booking', true)}<a style="${emailLinkStyle}" href="https://example.com">Meeting</a>`,
  ),
  attachments: [
    {
      filename: 'invite.ics',
      contentType: 'text/calendar; method=REQUEST; charset=UTF-8',
      content: 'unchanged calendar',
    },
  ],
}

describe('transactional email branding', () => {
  it.each(['#FFFFFF', '#000000', '#008855'])(
    'uses readable button and link colors for %s',
    (primaryColor) => {
      const brand = {
        name: 'Example & partners',
        primaryColor,
        logoDataUrl: `data:image/png;base64,${logo}`,
      }
      const result = brandEmail(message, brand)
      const palette = brandPalette(primaryColor)?.light
      expect(palette).toBeTruthy()
      expect(result.html).toContain(`background-color: ${palette?.accent};`)
      expect(result.html).toContain(`color: ${palette?.accentText}; text-decoration: none;`)
      expect(result.html).toContain(`color: ${palette?.link};`)
      expect(
        brandColorContrast(palette?.accent as string, palette?.accentText as string),
      ).toBeGreaterThanOrEqual(4.5)
      expect(brandColorContrast(palette?.link as string, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
      expect(result.html).toContain(
        'src="cid:organization-logo@hourmere" alt="Example &amp; partners" width="1" height="1"',
      )
      expect(result.html).not.toMatch(/<img[^>]+https?:/)
      expect(result.html).toContain('Hourmere</p>')
      expect(result.text).toBe(message.text)
      expect(result.attachments?.[0]).toEqual(message.attachments[0])
      expect(result.attachments?.[1]).toMatchObject({
        content: logo,
        encoding: 'base64',
        cid: 'organization-logo@hourmere',
      })
    },
  )

  it('preserves default output for absent or invalid branding and rejects remote logo sources', () => {
    expect(brandEmail(message)).toBe(message)
    expect(
      brandEmail(message, {
        name: 'Example',
        primaryColor: 'red; content: url(https://invalid.test)',
        logoDataUrl: 'https://invalid.test/logo.png',
      }),
    ).toEqual(message)
  })

  it('refuses oversized CID attachments at the mail boundary', () => {
    const oversized = Buffer.concat([Buffer.from(logo, 'base64'), Buffer.alloc(64 * 1024)])
    const result = brandEmail(message, {
      name: 'Example',
      primaryColor: null,
      logoDataUrl: `data:image/png;base64,${oversized.toString('base64')}`,
    })
    expect(result.attachments).toEqual(message.attachments)
    expect(result.html).not.toContain('cid:')
  })

  it('does not interpret invitee text as template styles', () => {
    const malicious = {
      ...message,
      html: emailLayout(
        'en',
        'Meeting',
        '&lt;img src=&quot;https://invalid.test&quot;&gt; color: #1f4fd8;',
      ),
    }
    const result = brandEmail(malicious, {
      name: '<script>bad</script>',
      primaryColor: '#008855',
      logoDataUrl: `data:image/png;base64,${logo}`,
    })
    expect(result.html).toContain(
      '&lt;img src=&quot;https://invalid.test&quot;&gt; color: #1f4fd8;',
    )
    expect(result.html).toContain('alt="&lt;script&gt;bad&lt;/script&gt;"')
  })
})
