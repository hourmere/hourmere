export type LocaleDefinition = {
  readonly code: string
  readonly nativeName: string
  readonly fallbacks: readonly string[]
  readonly formatLocale: string
  readonly direction: 'ltr'
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
  },
} as const satisfies Record<string, LocaleDefinition>

/** Account locale remains an independent BCP 47 setting. */
export type InterfaceLanguage = keyof typeof localeRegistry
