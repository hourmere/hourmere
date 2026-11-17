import { describe, expect, it } from 'vitest'
import { brandPalette } from './brand-contrast.ts'

// Independently calculate WCAG luminance rather than reusing the palette's checks.
function contrast(a: string, b: string) {
  const luminance = (color: string) => {
    const rgb = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722
  }
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

describe('public brand palette', () => {
  it.each([null, undefined, '', 'red', '#fff', '#000000ff', 'url(https://example.com)', '#GG0000'])(
    'retains the default theme for invalid or missing colour %s',
    (color) => expect(brandPalette(color)).toBeNull(),
  )

  it('keeps text, hover, links and focus readable on both themes including extreme colours', () => {
    const colors = ['#FFFFFF', '#FFFFFE', '#000000', '#000001', '#FF0000', '#00FF00', '#0000FF']
    for (let value = 0; value < 256; value++)
      colors.push(`#${value.toString(16).padStart(2, '0').repeat(3)}`)
    for (const color of colors) {
      const palette = brandPalette(color)
      expect(palette).not.toBeNull()
      if (!palette) throw new Error('Expected a valid palette')
      for (const mode of ['light', 'dark'] as const) {
        const theme = palette[mode]
        expect(contrast(theme.accent, theme.accentText)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(theme.accentHover, theme.accentText)).toBeGreaterThanOrEqual(4.5)
        expect(contrast(theme.accentSoft, theme.accentSoftText)).toBeGreaterThanOrEqual(4.5)
        const surfaces =
          mode === 'light' ? ['#FFFFFF', '#F7F9FE', '#EAF0FD'] : ['#0E1015', '#151C2E', '#111A33']
        for (const background of [...surfaces, theme.accentSoft]) {
          expect(contrast(theme.link, background)).toBeGreaterThanOrEqual(4.5)
          expect(contrast(theme.focus, background)).toBeGreaterThanOrEqual(3)
          expect(contrast(theme.accent, background)).toBeGreaterThanOrEqual(3)
        }
      }
    }
  })
})
