import {
  explicitLanguage,
  type InterfaceLanguage,
  interfaceLanguage,
  localeFallbacks,
} from '@hourmere/core/language'

import { INITIAL_LOCALE_WAIT_MS } from '../i18n/catalogue-loader.ts'
import { widget as english } from '../i18n/catalogues/en/widget.ts'

export { embedQueryLanguage } from './query-language.ts'

type WidgetMessages = Readonly<Record<keyof typeof english, string>>
type WidgetCatalogue = Partial<WidgetMessages>
const modules =
  import.meta.env.PROD && !import.meta.env.SSR
    ? {}
    : import.meta.glob<WidgetCatalogue>(
        ['../i18n/catalogues/*/widget.ts', '!../i18n/catalogues/en/widget.ts'],
        { import: 'widget' },
      )

const catalogues = new Map<InterfaceLanguage, WidgetCatalogue>([['en', english]])
const pending = new Map<InterfaceLanguage, Promise<void>>()
let scriptSource: string | undefined

export function setWidgetScriptSource(source: string | undefined) {
  scriptSource = source
}

export function primeWidgetCatalogue(locale: InterfaceLanguage, catalogue: WidgetCatalogue) {
  catalogues.set(locale, catalogue)
}

function fetchWidgetCatalogue(locale: InterfaceLanguage): Promise<WidgetCatalogue> | undefined {
  const load = modules[`../i18n/catalogues/${locale}/widget.ts`]
  if (load) return load()
  if (!scriptSource) return
  const url = new URL(`hourmere-embed-locale-${locale}.js`, scriptSource)
  return new Promise((resolve, reject) => {
    // The classic script uses the host page's existing script permission. It does not
    // require CORS or a separate connect-src permission on third-party sites.
    const script = document.createElement('script') as HTMLScriptElement & {
      hourmereMessages: (messages: WidgetCatalogue) => void
    }
    script.hourmereMessages = resolve
    script.referrerPolicy = 'no-referrer'
    script.src = url.href
    const finish = () => {
      script.remove()
      reject(new Error('Could not load Hourmere widget translations'))
    }
    script.onload = finish
    script.onerror = finish
    document.head.append(script)
  })
}

function loadWidgetCatalogue(locale: InterfaceLanguage) {
  if (catalogues.has(locale)) return
  const current = pending.get(locale)
  if (current) return current
  const request = fetchWidgetCatalogue(locale)
  if (!request) return
  const loaded = request
    .then((catalogue) => {
      catalogues.set(locale, catalogue)
    })
    .finally(() => pending.delete(locale))
  pending.set(locale, loaded)
  return loaded
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
    Object.assign(messages, catalogues.get(locale))
  }
  return messages
}

/** Render ready controls immediately and let a slow catalogue update the same controls later. */
export function withWidgetMessages(
  language: InterfaceLanguage,
  render: (locale: InterfaceLanguage, messages: WidgetMessages) => void,
) {
  const required = localeFallbacks(language).flatMap((locale) => loadWidgetCatalogue(locale) ?? [])
  if (!required.length) {
    render(language, widgetMessages(language))
    return
  }
  let fallbackShown = false
  const fallback = () => {
    if (fallbackShown) return
    fallbackShown = true
    render('en', english)
  }
  const timeout = setTimeout(fallback, INITIAL_LOCALE_WAIT_MS)
  void Promise.all(required).then(
    () => {
      clearTimeout(timeout)
      render(language, widgetMessages(language))
    },
    () => {
      clearTimeout(timeout)
      fallback()
    },
  )
}
