import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { screenshotsWithinTolerance } from '../tools/e2e/screenshot-comparison.ts'

type Compare = typeof screenshotsWithinTolerance

async function png({
  width = 12,
  height = 12,
  channels = 4,
  compressionLevel = 9,
  change = (_data: Buffer) => {},
}: {
  width?: number
  height?: number
  channels?: 3 | 4
  compressionLevel?: number
  change?: (data: Buffer) => void
} = {}) {
  const data = Buffer.alloc(width * height * channels, 128)
  change(data)
  return sharp(data, { raw: { width, height, channels } }).png({ compressionLevel }).toBuffer()
}

function changePixels(data: Buffer, count: number, delta: number) {
  for (let pixel = 0; pixel < count; pixel++) {
    for (let channel = 0; channel < 4; channel++)
      data.writeUInt8(128 + (pixel % 2 === 0 ? delta : -delta), pixel * 4 + channel)
  }
}

function sourceCopy(before?: string, after = ''): Compare {
  const source = readFileSync('tools/e2e/screenshot-comparison.ts', 'utf8')
  if (before) expect(source).toContain(before)
  const copy = stripTypeScriptTypes(before ? source.replace(before, after) : source)
    .replace(/^import .*\n/gm, '')
    .replace(/\bexport /g, '')
  return new Function('sharp', `${copy}; return screenshotsWithinTolerance`)(sharp) as Compare
}

async function verifyLimits(compare: Compare) {
  const original = await png()
  expect(await compare(original, original), 'identical pixels').toBe(true)
  expect(
    await compare(original, await png({ change: (data) => changePixels(data, 8, 1) })),
    'eight pixels with positive and negative channel deltas of one',
  ).toBe(true)
  expect(
    await compare(original, await png({ change: (data) => changePixels(data, 64, 2) })),
    'exactly 64 pixels, including alpha, with channel deltas of two',
  ).toBe(true)
  expect(
    await compare(original, await png({ change: (data) => changePixels(data, 65, 1) })),
    '65 differing pixels',
  ).toBe(false)
  for (let channel = 0; channel < 4; channel++) {
    expect(
      await compare(original, await png({ change: (data) => data.writeUInt8(131, channel) })),
      `a delta of three in RGBA channel ${channel}`,
    ).toBe(false)
  }
  expect(await compare(original, await png({ width: 13 })), 'different widths').toBe(false)
  expect(await compare(original, await png({ height: 13 })), 'different heights').toBe(false)
  expect(
    await compare(original, await png({ width: 6, height: 24 })),
    'different dimensions with the same pixel count',
  ).toBe(false)
}

describe('product screenshot PNG comparison', () => {
  it('enforces the dimensions, channel tolerance and distinct-pixel budget', () =>
    verifyLimits(screenshotsWithinTolerance))

  it('compares decoded pixels instead of encoded PNG bytes', async () => {
    const first = await png({ compressionLevel: 0 })
    const second = await png({ compressionLevel: 9 })
    expect(first.equals(second)).toBe(false)
    expect(await screenshotsWithinTolerance(first, second)).toBe(true)
  })

  it('normalizes RGB and RGBA PNGs to opaque RGBA', async () => {
    const rgb = await png({ channels: 3 })
    const rgba = await png({
      change: (data) => {
        for (let alpha = 3; alpha < data.length; alpha += 4) data.writeUInt8(255, alpha)
      },
    })
    expect(await screenshotsWithinTolerance(rgb, rgba)).toBe(true)
    expect(await screenshotsWithinTolerance(rgba, rgb)).toBe(true)
  })

  it('leaves both input buffers unchanged', async () => {
    const first = await png()
    const second = await png({ change: (data) => changePixels(data, 8, 1) })
    const firstBefore = Buffer.from(first)
    const secondBefore = Buffer.from(second)
    await screenshotsWithinTolerance(first, second)
    expect(first).toEqual(firstBefore)
    expect(second).toEqual(secondBefore)
  })

  it('passes the same assertions against an unmodified source copy', () =>
    verifyLimits(sourceCopy()))

  for (const [name, before, after] of [
    ['width equality', 'leftImage.info.width !== rightImage.info.width', 'false'],
    ['height equality', 'leftImage.info.height !== rightImage.info.height', 'false'],
    ['channel tolerance', 'difference > 2', 'difference > 3'],
    ['distinct-pixel budget', '++differingPixels > 64', '++differingPixels > 65'],
  ])
    it(`detects a broken ${name} protection with a real assertion failure`, async () => {
      await expect(verifyLimits(sourceCopy(before, after))).rejects.toMatchObject({
        name: 'AssertionError',
      })
    })
})
