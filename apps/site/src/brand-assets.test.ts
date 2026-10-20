import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { siteCopy } from './ui-copy.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url))

describe('brand raster exports and delivery', () => {
  it('keeps one-off font tools outside the workspace and site tools out of production installs', () => {
    const lock = JSON.parse(read('../../../package-lock.json').toString()) as {
      packages: Record<string, { dev?: boolean; devOptional?: boolean }>
    }
    const tools = ['sharp', 'jsdom', 'parse5', 'fontkit', 'wawoff2', 'postcss']
    for (const [path, metadata] of Object.entries(lock.packages)) {
      if (!path.includes('node_modules')) {
        const manifest = JSON.parse(read(`../../../${path}/package.json`).toString())
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          expect(manifest[field]?.fontkit, `${path}: ${field}`).toBeUndefined()
          expect(manifest[field]?.['@types/fontkit'], `${path}: ${field}`).toBeUndefined()
          expect(manifest[field]?.wawoff2, `${path}: ${field}`).toBeUndefined()
        }
        for (const tool of tools) {
          expect(manifest.dependencies?.[tool], `${path}: production ${tool}`).toBeUndefined()
          expect(manifest.optionalDependencies?.[tool], `${path}: optional ${tool}`).toBeUndefined()
        }
      } else if (
        tools.some(
          (tool) => path.endsWith(`/node_modules/${tool}`) || path === `node_modules/${tool}`,
        )
      ) {
        expect(metadata.dev || metadata.devOptional, `${path}: production lock entry`).toBe(true)
      }
    }
  })

  it('ships a 1200×630 PNG sharing image', async () => {
    const metadata = await sharp(read('../public/og-image.png')).metadata()
    expect([metadata.format, metadata.width, metadata.height]).toEqual(['png', 1200, 630])
    const script = read('../scripts/generate-brand-assets.ts').toString()
    expect(script).toContain('manrope-latin-wght-normal.woff2')
    expect(script).toContain("new URL('favicon.svg', publicDir)")
    for (const color of ['#1F4FD8', '#0A1E4A', '#EAF0FD', '#0E1015'])
      expect(script).toContain(color)
  })

  it.each([
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512],
  ] as const)(
    'ships an opaque square %s with full-bleed cobalt corners',
    async (filename, size) => {
      const source = read(`../public/${filename}`)
      const metadata = await sharp(source).metadata()
      expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([size, size, false])
      for (const [left, top] of [
        [0, 0],
        [size - 1, 0],
        [0, size - 1],
        [size - 1, size - 1],
      ]) {
        const pixel = await sharp(source)
          .extract({ left: left ?? 0, top: top ?? 0, width: 1, height: 1 })
          .raw()
          .toBuffer()
        expect([...pixel]).toEqual([31, 79, 216])
      }
    },
  )

  it('ships a valid ICO with a 32px PNG entry', async () => {
    const ico = read('../public/favicon.ico')
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 1])
    expect([ico[6], ico[7]]).toEqual([32, 32])
    const offset = ico.readUInt32LE(18)
    const length = ico.readUInt32LE(14)
    expect(offset + length).toBe(ico.length)
    const metadata = await sharp(ico.subarray(offset)).metadata()
    expect([metadata.format, metadata.width, metadata.height]).toEqual(['png', 32, 32])
  })

  it('declares both manifest sizes and existing-site launch URL', () => {
    const manifest = JSON.parse(read('../public/site.webmanifest').toString())
    expect(manifest.start_url).toBe('/')
    expect(manifest.icons).toEqual([
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ])
  })

  it('caches only fingerprinted Astro assets immutably', () => {
    const headers = read('../public/_headers').toString()
    const blocks = headers
      .trim()
      .split(/\n\s*\n/)
      .map((block) => block.split('\n'))
    const immutable = blocks.filter((block) => block.some((line) => line.includes('immutable')))
    expect(immutable).toEqual([
      ['/_astro/*', '  Cache-Control: public, max-age=31536000, immutable'],
    ])
  })

  it('provides English and Simplified Chinese counterparts for every new label', () => {
    expect(Object.keys(siteCopy.en)).toEqual(Object.keys(siteCopy['zh-CN']))
    for (const [key, value] of Object.entries(siteCopy['zh-CN'])) {
      expect(value, key).toMatch(/[\u4e00-\u9fff]/)
      expect(value).not.toMatch(/ [（［【]|[,;:!?]/)
    }
  })
})
