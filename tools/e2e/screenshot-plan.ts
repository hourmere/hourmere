export type ScreenshotPage =
  | 'booking'
  | 'booking-form'
  | 'confirmation'
  | 'event-types'
  | 'availability'
  | 'bookings'

export type ScreenshotCase = {
  readonly name: string
  readonly page: ScreenshotPage
  readonly theme: 'light' | 'dark'
  readonly viewport: { readonly width: number; readonly height: number }
  readonly isMobile: boolean
}

const desktopPages: readonly ScreenshotPage[] = [
  'booking',
  'booking-form',
  'confirmation',
  'event-types',
  'availability',
  'bookings',
]

export const screenshotCases: readonly ScreenshotCase[] = [
  ...desktopPages.flatMap((page) =>
    (['light', 'dark'] as const).map((theme) => ({
      name: `${page}-${theme}.png`,
      page,
      theme,
      viewport: { width: 1280, height: 900 },
      isMobile: false,
    })),
  ),
  {
    name: 'booking-mobile-light.png',
    page: 'booking',
    theme: 'light',
    viewport: { width: 390, height: 844 },
    isMobile: true,
  },
]

/** Refuse stale or incomplete output instead of silently committing a partial set. */
export function validateScreenshotSet(names: readonly string[]) {
  const actual = new Set(names)
  if (actual.size !== names.length) throw new Error('Duplicate screenshot names')
  const expected = new Set(screenshotCases.map((screenshot) => screenshot.name))
  if (names.some((name) => !expected.has(name))) throw new Error('Unexpected screenshot names')
  if (screenshotCases.some((screenshot) => !actual.has(screenshot.name)))
    throw new Error('Missing screenshot names')
}

/** Full-page images may be taller than the viewport, but must retain their 2x pixels. */
export function validateScreenshotImage(name: string, width: number, height: number) {
  const screenshot = screenshotCases.find((screenshot) => screenshot.name === name)
  if (!screenshot) throw new Error('Unknown screenshot name')
  if (
    width !== screenshot.viewport.width * 2 ||
    !Number.isInteger(height) ||
    height < screenshot.viewport.height * 2
  )
    throw new Error('Screenshot must use 2x viewport dimensions')
}

export function validateScreenshotBytes(total: number) {
  if (!Number.isSafeInteger(total) || total <= 0 || total >= 3_000_000)
    throw new Error('Screenshot set must contain less than 3 MB of PNG data')
}
