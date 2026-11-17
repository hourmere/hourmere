/** WCAG 2.x sRGB relative luminance and contrast; the reference background is white (#FFFFFF). */
export function brandContrast(color: string) {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const luminance =
    0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
  const white = 1.05 / (luminance + 0.05)
  const black = (luminance + 0.05) / 0.05
  return {
    buttonTextColor: white >= black ? ('#FFFFFF' as const) : ('#000000' as const),
    backgroundContrast: white,
    buttonTextContrast: Math.max(white, black),
  }
}

export interface BrandTheme {
  accent: string
  accentHover: string
  accentText: string
  accentSoft: string
  accentSoftText: string
  link: string
  focus: string
}

/** Contrast between two opaque, validated sRGB colours. */
export function brandColorContrast(first: string, second: string): number {
  const a = brandContrast(first).backgroundContrast
  const b = brandContrast(second).backgroundContrast
  return Math.max(a, b) / Math.min(a, b)
}

function mix(color: string, target: string, amount: number): string {
  return `#${[1, 3, 5]
    .map((offset) => {
      const start = Number.parseInt(color.slice(offset, offset + 2), 16)
      const end = Number.parseInt(target.slice(offset, offset + 2), 16)
      return Math.round(start + (end - start) * amount)
        .toString(16)
        .padStart(2, '0')
    })
    .join('')}`.toUpperCase()
}

function readable(color: string, backgrounds: string[], target: string): string {
  // Quantized sRGB steps, checked after rounding so edge colours also meet the target.
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, target, step / 100)
    if (backgrounds.every((background) => brandColorContrast(candidate, background) >= 4.5))
      return candidate
  }
  return target
}

/**
 * Revalidate stored values at the rendering boundary. Keep hue where possible while
 * deriving text, controls and focus rings for the actual public light/dark surfaces.
 * Null means the consumer must retain the default Hourmere theme.
 */
export function brandPalette(color: string | null | undefined): {
  light: BrandTheme
  dark: BrandTheme
} | null {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return null
  if (brandContrast(color).buttonTextContrast < 4.5) return null
  const theme = (dark: boolean): BrandTheme => {
    const target = dark ? '#FFFFFF' : '#000000'
    const backgrounds = dark ? ['#0E1015', '#151C2E', '#111A33'] : ['#FFFFFF', '#F7F9FE', '#EAF0FD']
    const accentSoft = mix(color, dark ? '#151C2E' : '#FFFFFF', 0.92)
    const accent = readable(color, [...backgrounds, accentSoft], target)
    return {
      accent,
      accentHover: mix(accent, target, 0.12),
      accentText: brandContrast(accent).buttonTextColor,
      accentSoft,
      accentSoftText: accent,
      link: accent,
      focus: accent,
    }
  }
  return { light: theme(false), dark: theme(true) }
}
