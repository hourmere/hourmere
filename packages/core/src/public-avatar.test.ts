import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { publicAvatarImage } from './public-avatar.ts'

describe('public avatar image references', () => {
  it.each([
    '/ada.png',
    '/assets/avatars/ada-lovelace.jpg',
    '/assets/host_2.profile.jpeg',
    '/assets/host.GIF',
    '/assets/host.webp',
    '/assets/host.avif',
  ])('accepts an existing first-party raster path: %s', (image) => {
    expect(publicAvatarImage(image)).toBe(image)
  })

  it.each([
    undefined,
    null,
    {},
    { toString: () => '/assets/host.png' },
    1,
    '',
    'assets/ada.png',
    'https://avatar/ada.png',
    'https://www.gravatar.com/avatar/d41d8cd98f00b204e9800998ecf8427e.png',
    '//avatar/ada.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    '/assets/ada.svg',
    '/assets/ada.html',
    '/assets/ada.png?email=ada@example.test',
    '/assets/ada.png#email=ada@example.test',
    '/assets/ada@example.test.png',
    '/assets/ada%40example.test.png',
    '/assets/%2e%2e/ada.png',
    '/assets/../ada.png',
    '/assets/./ada.png',
    '/assets//ada.png',
    '/\\avatar/ada.png',
    '/assets/ada\n.png',
    '/assets/ada\r.png',
    '/assets/ada\u0000.png',
    '/assets/ada.png\n',
    '/assets/ada photo.png',
  ])('omits a missing or unsafe image: %j', (image) => {
    expect(publicAvatarImage(image)).toBeUndefined()
  })
})

function sourceCopy(before: string, after: string): typeof publicAvatarImage {
  const original = readFileSync('packages/core/src/public-avatar.ts', 'utf8')
  expect(original.includes(before), 'mutation must match source').toBe(true)
  const source = stripTypeScriptTypes(original.replace(before, after)).replace(/\bexport /g, '')
  return new Function(`${source}; return publicAvatarImage`)() as typeof publicAvatarImage
}

describe('public avatar negative controls', () => {
  it('detects accepting coerced non-string image values', () => {
    const mutated = sourceCopy("typeof value === 'string' && ", '')
    const value = { toString: () => '/assets/host.png' }
    expect(() => expect(mutated(value)).toBeUndefined()).toThrowError()
  })

  it('detects removing the root-relative path requirement', () => {
    const mutated = sourceCopy('/^\\/', '/^(?:https?:\\/\\/|\\/\\/|\\/)')
    for (const value of ['https://avatar/ada.png', '//avatar/ada.png']) {
      expect(() => expect(mutated(value)).toBeUndefined()).toThrowError()
    }
  })

  it('detects permitting unsafe path characters and directory segments', () => {
    const mutated = sourceCopy(
      '(?:[a-z0-9_-]+\\/)*[a-z0-9_-]+(?:\\.[a-z0-9_-]+)*',
      '(?:[^\\/]+\\/)*[^\\/]+',
    )
    for (const value of [
      '/assets/ada@example.test.png',
      '/assets/ada%40example.test.png',
      '/assets/../ada.png',
      '/\\avatar/ada.png',
      '/assets/ada\n.png',
      '/assets/ada\u0000.png',
      '/assets/ada photo.png',
    ]) {
      expect(() => expect(mutated(value)).toBeUndefined()).toThrowError()
    }
  })

  it('detects permitting URL parameters or fragments', () => {
    const mutated = sourceCopy('webp)(?![\\s\\S])/i', 'webp)(?:[?#].*)?(?![\\s\\S])/i')
    for (const value of [
      '/assets/ada.png?email=ada@example.test',
      '/assets/ada.png#email=ada@example.test',
    ]) {
      expect(() => expect(mutated(value)).toBeUndefined()).toThrowError()
    }
  })

  it('detects permitting non-raster image formats', () => {
    const mutated = sourceCopy('(?:avif|gif|jpe?g|png|webp)', '[a-z]+')
    expect(() => expect(mutated('/assets/ada.svg')).toBeUndefined()).toThrowError()
  })
})
