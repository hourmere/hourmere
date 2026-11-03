import { formattingLocale, type InterfaceLanguage } from '@hourmere/core/language'

/** Internal mail formatter: use the supplied zone and normalize ICU's non-breaking spaces. */
export const formatMailDateTime = (
  time: Temporal.ZonedDateTime,
  options: Intl.DateTimeFormatOptions,
  language: InterfaceLanguage,
) =>
  new Intl.DateTimeFormat(formattingLocale(language), {
    ...options,
    timeZone: time.timeZoneId,
  })
    .format(time.epochMilliseconds)
    .replace(/[\u00a0\u202f]/g, ' ')
