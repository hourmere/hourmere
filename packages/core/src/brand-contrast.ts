/** WCAG 2.x sRGB relative luminance and contrast; the page background is white. */
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
