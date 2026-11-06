import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { embedSnippet } from './embed-snippet.ts'

const publicUrl = 'https://hourmere.example.com'
const docs = readFileSync(
  new URL('../../../apps/site/src/content/docs/docs/embedding.md', import.meta.url),
  'utf8',
)

function documentedSnippet(heading: string): string {
  const section = docs.split(`## ${heading}\n`)[1]
  const code = section?.match(/```html\n([\s\S]+?)\n```/)?.[1]
  if (!code) throw new Error(`Missing documented ${heading} snippet`)
  return code
}

describe('embed snippet documentation contract', () => {
  it.each([
    ['personal', '/ada/intro'],
    ['team', '/team/Alpha/intro'],
    ['hidden personal', '/ada/private-intro'],
    ['hidden team', '/team/Alpha/private-intro'],
  ])('matches the documented HTML exactly for a %s address', (_name, bookingPath) => {
    for (const [mode, heading] of [
      ['inline', 'Inline'],
      ['popup', 'Popup'],
    ] as const)
      expect(embedSnippet({ publicUrl, bookingPath, mode })).toBe(
        documentedSnippet(heading).replace('/ada/intro', bookingPath),
      )
  })

  it('uses the canonical instance origin and saved reusable booking path', () => {
    expect(
      embedSnippet({
        publicUrl: 'https://HOURMERE.example.com:443/',
        bookingPath: '/Ada/Intro/',
        mode: 'inline',
      }),
    ).toBe(documentedSnippet('Inline'))
    expect(
      embedSnippet({
        publicUrl: 'http://localhost:5173',
        bookingPath: '/team/Alpha/intro',
        mode: 'popup',
      }),
    ).toContain('data-hourmere-url="http://localhost:5173/team/Alpha/intro"')
  })

  it('escapes host-authored button labels as plain text', () => {
    const buttonLabel = `Book <Ada & "team">'s meeting</button><script>alert(1)</script>`
    expect(embedSnippet({ publicUrl, bookingPath: '/ada/intro', mode: 'popup', buttonLabel })).toBe(
      documentedSnippet('Popup').replace(
        'Book a meeting',
        'Book &lt;Ada &amp; &quot;team&quot;&gt;&#39;s meeting&lt;/button&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
      ),
    )
  })

  it.each(['', ' ', '\n\t\r', '\u00a0', '\u3000'])(
    'refuses an empty or whitespace-only popup label %j',
    (buttonLabel) => {
      expect(() =>
        embedSnippet({ publicUrl, bookingPath: '/ada/intro', mode: 'popup', buttonLabel }),
      ).toThrow('Invalid Hourmere popup button label')
    },
  )

  it('preserves the exact valid popup label including surrounding whitespace', () => {
    const buttonLabel = '  Book a meeting \n'
    expect(embedSnippet({ publicUrl, bookingPath: '/ada/intro', mode: 'popup', buttonLabel })).toBe(
      documentedSnippet('Popup').replace('Book a meeting', buttonLabel),
    )
  })

  it.each(['inline', 'popup'] as const)('escapes both URL attributes in %s markup', (mode) => {
    // WHATWG URL accepts these origin characters; HTML attributes still need escaping.
    expect(
      embedSnippet({ publicUrl: `https://a&b"c'd.test`, bookingPath: '/ada/intro', mode }),
    ).toBe(
      documentedSnippet(mode === 'inline' ? 'Inline' : 'Popup').replaceAll(
        'https://hourmere.example.com',
        'https://a&amp;b&quot;c&#39;d.test',
      ),
    )
  })

  it.each([240, 960, 2000])('supports the widget initial height %s', (height) => {
    expect(
      embedSnippet({ publicUrl, bookingPath: '/ada/intro', mode: 'inline', height }),
    ).toContain(`data-hourmere-height="${height}"`)
  })

  it.each([0, 239, 2001, 720.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsupported initial height %s',
    (height) =>
      expect(() =>
        embedSnippet({ publicUrl, bookingPath: '/ada/intro', mode: 'inline', height }),
      ).toThrow('Invalid Hourmere embed height'),
  )

  it('refuses modes unsupported by the widget', () => {
    expect(() =>
      embedSnippet({ publicUrl, bookingPath: '/ada/intro', mode: 'iframe' as 'inline' }),
    ).toThrow('Invalid Hourmere embed mode')
  })

  it.each([
    'javascript:alert(1)',
    'http://hourmere.example.com',
    'https://operator:password@hourmere.example.com',
    'https://hourmere.example.com/app',
    'https://hourmere.example.com?tracking=true',
    'https://hourmere.example.com#fragment',
    'https://hourmere.example.com\\@evil.test',
  ])('refuses unsafe or non-root instance URL %s', (unsafeUrl) => {
    expect(() =>
      embedSnippet({ publicUrl: unsafeUrl, bookingPath: '/ada/intro', mode: 'inline' }),
    ).toThrow('Invalid Hourmere public booking address')
  })

  it.each([
    '/book/one-time-capability',
    '/app/settings',
    '/api/event-types',
    '/booking/manage-token',
    '/team/admin/intro',
    '/ada/intro?name=Ada',
    '/ada/intro#fragment',
    '/ada/intro" onmouseover="alert(1)',
    '/ada/<script>',
    'https://evil.test/ada/intro',
  ])('refuses one-time, private or malformed address %s', (bookingPath) => {
    expect(() => embedSnippet({ publicUrl, bookingPath, mode: 'popup' })).toThrow(
      'Invalid Hourmere public booking address',
    )
  })
})
