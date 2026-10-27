import {
  explicitLanguage,
  type InterfaceLanguage,
  interfaceLanguage,
  localeFallbacks,
} from '@hourmere/core/language'

import type { widget as english } from '../i18n/catalogues/en/widget.ts'

type WidgetMessages = Readonly<Record<keyof typeof english, string>>
const catalogs = import.meta.glob<Partial<WidgetMessages>>('../i18n/catalogues/*/widget.ts', {
  eager: true,
  import: 'widget',
})

/** The iframe query overrides language only when one supported value is present. */
export function embedQueryLanguage(search: string): InterfaceLanguage | undefined {
  const query = new URLSearchParams(search)
  return query.getAll('language').length === 1 ? explicitLanguage(query.get('language')) : undefined
}

export function widgetLanguage(value?: unknown): InterfaceLanguage {
  if (value !== undefined) {
    const language = explicitLanguage(value)
    if (!language) throw new Error('Invalid Hourmere interface language')
    return language
  }
  const pageLanguage = interfaceLanguage(document.documentElement.lang)
  if (pageLanguage) return pageLanguage
  try {
    for (const candidate of navigator.languages?.length
      ? navigator.languages
      : [navigator.language]) {
      const language = interfaceLanguage(candidate)
      if (language) return language
    }
  } catch {
    /* Browser language access is optional. */
  }
  return 'en'
}
export function widgetMessages(language: InterfaceLanguage): WidgetMessages {
  const messages = {} as Record<keyof typeof english, string>
  // Apply English first, then progressively more specific translated keys.
  for (const locale of localeFallbacks(language).reverse()) {
    Object.assign(messages, catalogs[`../i18n/catalogues/${locale}/widget.ts`])
  }
  return messages
}
