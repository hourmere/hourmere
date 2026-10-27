import { registeredLocales } from '@hourmere/core/language'

export const localeDescription = `BCP 47 language tag. Registered interface and notification languages: ${registeredLocales.map(({ code }) => code).join(', ')}. Regional tags are matched to a registered language; unsupported languages and missing translations fall back to English. Locale does not change the meeting time zone.`
