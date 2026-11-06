import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { embedOrigin, publicBookingPath } from './embed.ts'
import { embedSnippet } from './embed-snippet.ts'

const source = readFileSync(new URL('./embed-snippet.ts', import.meta.url), 'utf8')
const docs = readFileSync(
  new URL('../../../apps/site/src/content/docs/docs/embedding.md', import.meta.url),
  'utf8',
)

/** Run isolated source copies so parallel tests never see a modified production file. */
function copy(code: string): typeof embedSnippet {
  const compiled = stripTypeScriptTypes(code)
    .replace(/^import .*$/m, '')
    .replace('export function embedSnippet', 'function embedSnippet')
  return new Function('embedOrigin', 'publicBookingPath', `${compiled}; return embedSnippet`)(
    embedOrigin,
    publicBookingPath,
  ) as typeof embedSnippet
}

function assertDocumentedDefaults(generate: typeof embedSnippet) {
  for (const [mode, heading] of [
    ['inline', 'Inline'],
    ['popup', 'Popup'],
  ] as const) {
    const section = docs.split(`## ${heading}\n`)[1]?.split('\n## ')[0]
    const snippet = section?.match(/```html\n([\s\S]+?)\n```/)?.[1]
    expect(snippet, `Missing documented ${heading} example`).toBeDefined()
    expect(
      generate({
        publicUrl: 'https://hourmere.example.com',
        bookingPath: '/ada/intro',
        mode,
      }),
    ).toBe(snippet)
  }
}

function assertDocumentedHeightRange(generate: typeof embedSnippet) {
  const range = docs.match(/whole number from\s+\*\*(\d+)\*\* to \*\*(\d+)\*\*/)
  expect(range, 'The walkthrough must document the allowed height range').not.toBeNull()
  const minimum = Number(range?.[1])
  const maximum = Number(range?.[2])
  const options = {
    publicUrl: 'https://hourmere.example.com',
    bookingPath: '/ada/intro',
    mode: 'inline' as const,
  }
  for (const height of [minimum, Math.floor((minimum + maximum) / 2), maximum]) {
    expect(() => generate({ ...options, height })).not.toThrow()
    expect(generate({ ...options, height })).toContain(`data-hourmere-height="${height}"`)
  }
  for (const height of [minimum - 1, maximum + 1, minimum + 0.5])
    expect(() => generate({ ...options, height })).toThrow('Invalid Hourmere embed height')
}

describe('embed generator walkthrough facts', () => {
  it('accepts documented custom height boundaries and rejects values outside them', () => {
    assertDocumentedHeightRange(embedSnippet)
  })

  it('keeps the documented popup character limit aligned with the editor input', () => {
    const uiSource = readFileSync(
      new URL('../../../apps/web/src/pages/event-types/EventEmbedAction.tsx', import.meta.url),
      'utf8',
    )
    const documentedLimit = docs.match(/nonblank button text, up to (\d+) characters/)?.[1]
    expect(documentedLimit).toBeDefined()
    const assertLimit = (code: string) => {
      const inputLimit = code.match(/maxLength=\{(\d+)\}/)?.[1]
      expect(inputLimit).toBe(documentedLimit)
    }
    assertLimit(uiSource)
    expect(() => assertLimit(uiSource.replace('maxLength={200}', 'maxLength={201}'))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})

describe('embed documentation negative controls', () => {
  it.each([
    ['minimum height', 'height < 240', 'height < 241'],
    ['maximum height', 'height > 2000', 'height > 1999'],
    ['integer height', '!Number.isInteger(height)', 'false'],
  ])('detects a generator change to the documented %s', (_name, before, after) => {
    expect(source).toContain(before)
    assertDocumentedHeightRange(copy(source))
    expect(() => assertDocumentedHeightRange(copy(source.replace(before, after)))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertDocumentedHeightRange(copy(source))
  })

  it.each([
    ['inline default height', 'height = 720', 'height = 800'],
    ['popup default text', "buttonLabel = 'Book a meeting'", "buttonLabel = 'Schedule a call'"],
    ['inline discovery attribute', 'data-hourmere-inline', 'data-hourmere-frame'],
    ['popup discovery attribute', 'data-hourmere-popup', 'data-hourmere-modal'],
    ['booking URL attribute', 'data-hourmere-url', 'data-hourmere-booking-url'],
    ['initial height attribute', 'data-hourmere-height', 'data-hourmere-initial-height'],
    ['button type', 'type="button"', 'type="submit"'],
    ['loader URL', '/hourmere-embed.js', '/hourmere-widget.js'],
    ['deferred loader', ' defer></script>', ' async></script>'],
  ])('detects generator drift in the documented %s', (_name, before, after) => {
    expect(source).toContain(before)
    assertDocumentedDefaults(copy(source))
    expect(() => assertDocumentedDefaults(copy(source.replaceAll(before, after)))).toThrowError(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    assertDocumentedDefaults(copy(source))
  })

  it('keeps embedding references free of main-branch source line links', () => {
    const assertStableLinks = (content: string) =>
      expect(content).not.toMatch(/github\.com\/[^\s)]+\/blob\/main\/[^\s)]+#L\d+/)
    assertStableLinks(docs)
    expect(() =>
      assertStableLinks(
        `${docs}\n[implementation](https://github.com/hourmere/hourmere/blob/main/apps/web/src/public/Embed.tsx#L58)`,
      ),
    ).toThrowError(expect.objectContaining({ name: 'AssertionError' }))
  })
})
