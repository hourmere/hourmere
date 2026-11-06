import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { brandContrast } from './brand-contrast.ts'

describe('WCAG brand contrast', () => {
  it('uses white for black, black for white, and exact endpoint ratios', () => {
    expect(brandContrast('#000000')).toEqual({
      buttonTextColor: '#FFFFFF',
      backgroundContrast: 21,
      buttonTextContrast: 21,
    })
    expect(brandContrast('#FFFFFF')).toEqual({
      buttonTextColor: '#000000',
      backgroundContrast: 1,
      buttonTextContrast: 21,
    })
  })
  it('chooses readable text around the crossover and across every grayscale', () => {
    for (let i = 0; i < 256; i++) {
      const result = brandContrast(`#${i.toString(16).padStart(2, '0').repeat(3)}`)
      expect(result.buttonTextContrast).toBeGreaterThanOrEqual(4.5)
    }
    expect(brandContrast('#757575').buttonTextColor).toBe('#FFFFFF')
    expect(brandContrast('#767676').buttonTextColor).toBe('#000000')
    expect(brandContrast('#FF0000').backgroundContrast).toBeCloseTo(3.998, 2)
  })
})

it('kills a copied readable-text selection regression at the crossover', () => {
  const original = readFileSync(new URL('./brand-contrast.ts', import.meta.url), 'utf8')
  const check = (source: string) => {
    const fn = new Function(
      `${stripTypeScriptTypes(source).replace(/\bexport /g, '')};return brandContrast`,
    )() as typeof brandContrast
    expect(fn('#767676').buttonTextColor).toBe('#000000')
    expect(fn('#FF0000').backgroundContrast).toBeCloseTo(3.998, 2)
  }
  check(original)
  expect(original).toContain("white >= black ? ('#FFFFFF' as const) : ('#000000' as const)")
  const mutant = original.replace(
    "white >= black ? ('#FFFFFF' as const) : ('#000000' as const)",
    "'#FFFFFF' as const",
  )
  expect(() => check(mutant)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  check(original)
})
