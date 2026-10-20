// One-off raster exports. Install pinned tools outside the workspace; see ./README.md.
// Text is outlined from the bundled Manrope font, independent of the machine's installed fonts.

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type sharpType from 'sharp'

interface Font {
  unitsPerEm: number
  getVariation(axes: { wght: number }): Font
  layout(text: string): {
    glyphs: { path: { toSVG(): string } }[]
    positions: { xOffset: number; yOffset: number; xAdvance: number }[]
  }
}

const require = createRequire(import.meta.url)
const toolDirectory = process.argv[2]
if (!toolDirectory) throw new Error('Pass the disposable tool directory; see scripts/README.md')
const tools = createRequire(resolve(toolDirectory, 'package.json'))
const { create }: { create: (input: Buffer) => Font | { fonts: Font[] } } = tools('fontkit')
const sharp: typeof sharpType = tools('sharp')
const { decompress }: { decompress: (input: Buffer) => Promise<Uint8Array> } = tools('wawoff2')
const fontFile = require.resolve(
  '@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2',
)
const decodedFont = create(Buffer.from(await decompress(readFileSync(fontFile))))
if (!('layout' in decodedFont)) throw new Error('Expected a single Manrope font')
const font = decodedFont
const publicDir = new URL('../public/', import.meta.url)
const favicon = readFileSync(new URL('favicon.svg', publicDir), 'utf8')
const mark = favicon.slice(favicon.indexOf('<defs>'), favicon.lastIndexOf('</svg>'))

function textPath(text: string, x: number, y: number, size: number, color: string, weight = 500) {
  const face = font.getVariation({ wght: weight })
  const run = face.layout(text)
  const scale = size / face.unitsPerEm
  let cursor = 0
  return run.glyphs
    .map((glyph, index) => {
      const position = run.positions[index]
      if (!position) throw new Error('Missing glyph position')
      const path = `<path fill="${color}" transform="translate(${x + (cursor + position.xOffset) * scale} ${y - position.yOffset * scale}) scale(${scale} ${-scale})" d="${glyph.path.toSVG()}"/>`
      cursor += position.xAdvance
      return path
    })
    .join('')
}

const card = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#EAF0FD"/>
  <path d="M820 0H1200V630H1050C920 500 1010 250 820 0Z" fill="#0A1E4A"/>
  <circle cx="1160" cy="110" r="200" fill="none" stroke="#1F4FD8" stroke-width="2"/>
  <circle cx="1160" cy="110" r="265" fill="none" stroke="#1F4FD8" stroke-width="2"/>
  <svg x="72" y="72" width="92" height="92" viewBox="0 0 100 100">${mark}</svg>
  ${textPath('Hourmere', 186, 139, 64, '#0E1015', 800)}
  ${textPath('Open-source scheduling', 72, 316, 56, '#0A1E4A', 800)}
  ${textPath('for people and AI agents.', 72, 390, 48, '#0A1E4A', 500)}
  <rect x="72" y="491" width="48" height="4" rx="2" fill="#1F4FD8"/>
  ${textPath('hourmere.com', 138, 504, 25, '#0E1015', 600)}
</svg>`
await sharp(Buffer.from(card))
  .png()
  .toFile(fileURLToPath(new URL('og-image.png', publicDir)))

// Home-screen platforms supply their own mask; use an opaque, full-bleed square.
const square = favicon.replace('rx="22" ', '')
for (const size of [180, 192, 512]) {
  const filename = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`
  await sharp(Buffer.from(square))
    .resize(size, size)
    .flatten({ background: '#1F4FD8' })
    .removeAlpha()
    .png()
    .toFile(fileURLToPath(new URL(filename, publicDir)))
}

// ICO permits PNG payloads (Vista and later); 32px also covers older favicon consumers.
const png = await sharp(Buffer.from(favicon)).resize(32, 32).png().toBuffer()
const header = Buffer.alloc(22)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(1, 4)
header[6] = 32
header[7] = 32
header.writeUInt16LE(1, 10)
header.writeUInt16LE(32, 12)
header.writeUInt32LE(png.length, 14)
header.writeUInt32LE(22, 18)
writeFileSync(new URL('favicon.ico', publicDir), Buffer.concat([header, png]))
