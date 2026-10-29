import { type InterfaceSurface, type LocaleDefinition, localeRegistry } from './locales.ts'

export {
  type InterfaceLanguage,
  type InterfaceSurface,
  type LocaleDefinition,
  localeRegistry,
} from './locales.ts'

export const LANGUAGE_COOKIE = 'hourmere-language'

/** The same resolver accepts test-only registries without registering a production language. */
export function createLocaleResolver<
  const Registry extends Record<string, LocaleDefinition> & { en: LocaleDefinition },
>(registry: Registry) {
  type Language = 'en' | Extract<keyof Registry, string>
  const localeCodes = Object.keys(registry) as [Language, ...Language[]]
  const registeredLocales = localeCodes.map((code) => ({ ...registry[code], code }))

  function interfaceLanguages(surface: InterfaceSurface): Language[] {
    return localeCodes.filter((code) => {
      const definition: LocaleDefinition = registry[code]
      return !definition.interfaces || definition.interfaces.includes(surface)
    })
  }

  function explicitLanguage(value: unknown): Language | undefined {
    return typeof value === 'string' && Object.hasOwn(registry, value)
      ? (value as Language)
      : undefined
  }

  function interfaceLanguage(value: unknown): Language | undefined {
    if (typeof value !== 'string' || value.length > 128) return undefined
    try {
      const locale = new Intl.Locale(value)
      const exact = explicitLanguage(locale.baseName)
      if (exact) return exact
      // Regional likely-subtag data must not change the language's default script.
      const script = locale.script ?? new Intl.Locale(locale.language).maximize().script
      const matches = localeCodes.filter((code) => {
        const candidate = new Intl.Locale(code)
        const definition: LocaleDefinition = registry[code]
        if (
          candidate.language !== locale.language ||
          definition.excludedRegions?.includes(locale.region ?? '')
        )
          return false
        if (definition.excludedScripts) return !definition.excludedScripts.includes(script ?? '')
        // Language-wide entries accept variants; other regional entries keep their script.
        return (!candidate.script && !candidate.region) || candidate.maximize().script === script
      })
      return (
        matches.find((code) => new Intl.Locale(code).region === locale.region) ??
        matches.find((code) => !new Intl.Locale(code).region) ??
        matches[0]
      )
    } catch {
      /* Invalid or unsupported preferences fall through to the next source. */
    }
    return undefined
  }

  function localeFallbacks(language: Language): Language[] {
    return [...new Set([language, ...(registry[language] ?? registry.en).fallbacks, 'en'])].filter(
      (code): code is Language => explicitLanguage(code) !== undefined,
    )
  }

  function formattingLocale(language: Language): string {
    return (registry[language] ?? registry.en).formatLocale
  }

  function cookieLanguage(cookie: string | undefined): Language | undefined {
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

  function acceptLanguage(header: string | undefined, surface?: InterfaceSurface): Language {
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
      .filter(
        (entry) =>
          entry.language &&
          entry.q > 0 &&
          (!surface || interfaceLanguages(surface).includes(entry.language)),
      )
      .sort((a, b) => b.q - a.q || a.index - b.index)
    return candidates[0]?.language ?? 'en'
  }

  /** Server sign-in paths use only account defaults their caller already knows. */
  function resolveAdminLanguage({
    cookie,
    accountLocale,
    acceptLanguage: header,
  }: {
    cookie?: string | undefined
    accountLocale?: string | undefined
    acceptLanguage?: string | undefined
  } = {}): Language {
    const available = interfaceLanguages('admin')
    const supported = (language: Language | undefined) =>
      language && available.includes(language) ? language : undefined
    return (
      supported(cookieLanguage(cookie)) ??
      supported(interfaceLanguage(accountLocale)) ??
      acceptLanguage(header, 'admin')
    )
  }

  return {
    registeredLocales,
    interfaceLanguages,
    localeCodes,
    explicitLanguage,
    interfaceLanguage,
    localeFallbacks,
    formattingLocale,
    cookieLanguage,
    acceptLanguage,
    resolveAdminLanguage,
  }
}

export const {
  registeredLocales,
  interfaceLanguages,
  localeCodes,
  explicitLanguage,
  interfaceLanguage,
  localeFallbacks,
  formattingLocale,
  cookieLanguage,
  acceptLanguage,
  resolveAdminLanguage,
} = createLocaleResolver(localeRegistry)

/**
 * Space Han substitution boundaries next to Latin-script letters or ASCII digits, excluding
 * U+FF00–U+FFEF (Halfwidth and Fullwidth Forms). Trailing combining marks stay with their
 * letter or digit; other scripts and punctuation stay unspaced. Inserted text is unchanged.
 */
export function spaceCjkBoundaries(before: string, value: string, after: string): string {
  // Use Unicode-mode lookahead instead of v-mode set subtraction for older browsers.
  const leading =
    /\p{Script=Han}$/u.test(before) && /^(?![\uFF00-\uFFEF])[\p{Script=Latin}0-9]/u.test(value)
      ? ' '
      : ''
  const trailing =
    /(?![\uFF00-\uFFEF])[\p{Script=Latin}0-9]\p{M}*$/u.test(value) && /^\p{Script=Han}/u.test(after)
      ? ' '
      : ''
  return `${leading}${value}${trailing}`
}
