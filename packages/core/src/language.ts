/** The two interface languages. Account locale remains an independent BCP 47 setting. */
export type InterfaceLanguage = 'en' | 'zh-CN'
export const LANGUAGE_COOKIE = 'hourmere-language'
export function explicitLanguage(value: unknown): InterfaceLanguage | undefined {
  return value === 'en' || value === 'zh-CN' ? value : undefined
}
export function interfaceLanguage(value: unknown): InterfaceLanguage | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined
  try {
    const locale = new Intl.Locale(value)
    if (locale.language === 'en') return 'en'
    if (
      locale.language === 'zh' &&
      locale.script !== 'Hant' &&
      !['TW', 'HK', 'MO'].includes(locale.region ?? '')
    )
      return 'zh-CN'
  } catch {
    /* Invalid or unsupported preferences fall through to the next source. */
  }
  return undefined
}
export function cookieLanguage(cookie: string | undefined): InterfaceLanguage | undefined {
  if (!cookie || cookie.length > 16384) return undefined
  for (const item of cookie.split(';')) {
    const pair = item.trim()
    const separator = pair.indexOf('=')
    const name = pair.slice(0, separator)
    const value = separator < 0 ? undefined : pair.slice(separator + 1)
    if (name === LANGUAGE_COOKIE) return explicitLanguage(value)
  }
  return undefined
}
export function acceptLanguage(header: string | undefined): InterfaceLanguage {
  if (!header || header.length > 4096) return 'en'
  const candidates = header
    .split(',')
    .slice(0, 32)
    .map((part, index) => {
      const [tag, ...parameters] = part.trim().split(';')
      const quality = parameters
        .find((v) => v.trim().startsWith('q='))
        ?.trim()
        .slice(2)
      const q =
        quality === undefined
          ? 1
          : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality)
            ? Number(quality)
            : 0
      return { language: interfaceLanguage(tag), q, index }
    })
    .filter((entry) => entry.language && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
  return candidates[0]?.language ?? 'en'
}
