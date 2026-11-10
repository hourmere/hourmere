import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const publicRoot = resolve('apps/web/public')
const manifest = JSON.parse(readFileSync(`${publicRoot}/app/manifest.webmanifest`, 'utf8'))

it('provides an installable manifest confined to the admin app', () => {
  expect(manifest).toMatchObject({
    id: '/app/',
    name: 'Hourmere',
    short_name: 'Hourmere',
    start_url: '/app/',
    scope: '/app/',
    display: 'standalone',
    theme_color: '#1f4fd8',
    background_color: '#f7f9fe',
  })
  const styles = readFileSync('apps/web/src/styles.css', 'utf8')
  expect(styles).toContain(`--cobalt: ${manifest.theme_color};`)
  expect(styles).toContain(`--bg: ${manifest.background_color};`)
})

it('ships actual PNGs at each declared size, including both maskable sizes and Apple', () => {
  for (const purpose of ['any', 'maskable']) {
    for (const size of [192, 512]) {
      const icon = manifest.icons.find(
        (entry: { purpose: string; sizes: string }) =>
          entry.purpose === purpose && entry.sizes === `${size}x${size}`,
      )
      expect(icon).toBeDefined()
      expect(icon.type).toBe('image/png')
      expect(icon.src).toMatch(/^\/app\/[a-z0-9-]+\.png$/)
      assertPngSize(`${publicRoot}${icon.src}`, size)
    }
  }
  assertPngSize(`${publicRoot}/app/apple-touch-icon.png`, 180)
})

function assertPngSize(path: string, size: number) {
  const bytes = readFileSync(path)
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect(bytes.readUInt32BE(16)).toBe(size)
  expect(bytes.readUInt32BE(20)).toBe(size)
}
