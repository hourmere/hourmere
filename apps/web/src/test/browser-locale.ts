import { vi } from 'vitest'

/** Model an Intl browser default, without selecting an interface language. */
export function browserLocale(locale: string) {
  const DateTimeFormat = Intl.DateTimeFormat
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
    function BrowserDateTimeFormat(locales, options) {
      return new DateTimeFormat(locales ?? locale, options)
    },
  )
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue([locale])
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale)
}
