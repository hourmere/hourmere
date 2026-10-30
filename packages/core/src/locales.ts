export type InterfaceSurface = 'public' | 'admin'

export type LocaleDefinition = {
  readonly code: string
  readonly nativeName: string
  readonly fallbacks: readonly string[]
  readonly formatLocale: string
  readonly direction: 'ltr'
  /** Omit to offer the language on every interface; notification support is independent. */
  readonly interfaces?: readonly InterfaceSurface[]
  readonly excludedRegions?: readonly string[]
  /** When present, accept every script except those listed instead of matching the entry's script. */
  readonly excludedScripts?: readonly string[]
}

/** Add a registry entry and its catalogues to make another interface language available. */
export const localeRegistry = {
  en: {
    code: 'en',
    nativeName: 'English',
    fallbacks: [],
    formatLocale: 'en-US',
    direction: 'ltr',
  },
  'zh-CN': {
    code: 'zh-CN',
    nativeName: '简体中文',
    fallbacks: ['en'],
    formatLocale: 'zh-CN',
    direction: 'ltr',
    excludedRegions: ['TW', 'HK', 'MO'],
    excludedScripts: ['Hant'],
  },
  de: {
    code: 'de',
    nativeName: 'Deutsch',
    fallbacks: ['en'],
    formatLocale: 'de-DE',
    direction: 'ltr',
    interfaces: ['public'],
  },
  fr: {
    code: 'fr',
    nativeName: 'Français',
    fallbacks: ['en'],
    formatLocale: 'fr-FR',
    direction: 'ltr',
    interfaces: ['public'],
  },
  es: {
    code: 'es',
    nativeName: 'Español',
    fallbacks: ['en'],
    formatLocale: 'es-ES',
    direction: 'ltr',
    interfaces: ['public'],
  },
} as const satisfies Record<string, LocaleDefinition>

/** Account locale remains an independent BCP 47 setting. */
export type InterfaceLanguage = keyof typeof localeRegistry
