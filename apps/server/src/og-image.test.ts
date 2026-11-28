import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { type OgImageInputs, renderOgImage } from './og-image.ts'

const samples = {
  long: {
    title:
      'Quarterly planning, roadmap alignment, research priorities and cross-functional project updates across the whole organization',
    name: 'Studio North',
    durationMinutes: 45,
    primaryColor: '#5638AC',
  },
  cjk: {
    title: '产品体验交流与新功能演示｜製品相談・디자인 검토 📅',
    name: '青禾设计团队',
    durationMinutes: 30,
    primaryColor: '#087A6D',
  },
  rtl: {
    title: 'جلسة تخطيط المنتج — פגישת תכנון המוצר 🗓️',
    name: 'فريق التصميم',
    durationMinutes: 60,
    primaryColor: '#A34536',
  },
} satisfies Record<string, OgImageInputs>

/** Snapshot the actual pixels in the title area at a scale insensitive to antialiasing. */
async function titleSilhouette(png: Buffer) {
  const { data, info } = await sharp(png)
    .extract({ left: 80, top: 210, width: 1040, height: 240 })
    .resize(26, 6, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return Array.from({ length: info.height }, (_, y) =>
    Array.from({ length: info.width }, (_, x) =>
      (data[(y * info.width + x) * info.channels] ?? 255) < 211 ? '█' : '·',
    ).join(''),
  ).join('\n')
}

describe('booking preview raster', () => {
  it('returns an exact 1200 × 630 PNG for both generic and event previews', async () => {
    for (const inputs of [undefined, samples.cjk]) {
      const image = await renderOgImage(inputs)
      expect(await sharp(image).metadata()).toMatchObject({
        format: 'png',
        width: 1200,
        height: 630,
      })
    }
  })

  it('wraps a long title, truncating it with an ellipsis within the safe area', async () => {
    const image = await renderOgImage(samples.long)
    expect(
      image.equals(
        await renderOgImage({
          ...samples.long,
          title: 'Quarterly planning, roadmap alignment, resea…',
        }),
      ),
    ).toBe(true)
    expect(await titleSilhouette(image)).toMatchInlineSnapshot(`
      "··························
      ·████████████████·········
      ················█·········
      ····█·····█·····█·········
      ·████████████████·█████···
      ··························"
    `)
  })

  it('renders distinct Chinese, Japanese, Hangul and emoji glyphs', async () => {
    expect(await titleSilhouette(await renderOgImage(samples.cjk))).toMatchInlineSnapshot(`
      "··························
      ·█████████████████████····
      ···██·····█··█··█████·····
      ·█···█··········█·██······
      ·███████··████████·█······
      ··························"
    `)
  })

  it('shapes and reorders Arabic and Hebrew together with an emoji', async () => {
    expect(await titleSilhouette(await renderOgImage(samples.rtl))).toMatchInlineSnapshot(`
      "··························
      ·█████··██████████████····
      ········█·················
      ···········█··············
      ···········██·████████····
      ··························"
    `)
  })

  it('renders markup as text instead of letting saved text style the image', async () => {
    const image = await renderOgImage({
      title: 'A <span foreground="#FF0000">red</span> & B',
      name: 'Studio North',
      durationMinutes: 30,
    })
    const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true })
    for (let index = 0; index < data.length; index += info.channels) {
      if (data[index] === 255 && data[index + 1] === 0 && data[index + 2] === 0)
        throw new Error('Saved markup supplied an opaque red pixel')
    }
  })
})
