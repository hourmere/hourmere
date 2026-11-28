import { type InterfaceLanguage, localeFallbacks } from '@hourmere/core/language'
import { type Catalog, registerCatalog } from './catalogues.ts'

export const INITIAL_LOCALE_WAIT_MS = 300

export type CatalogueSource = (attempt: number) => Promise<Catalog>
type CatalogueStatus = 'pending' | 'ready' | 'failed'

const listeners = new Set<() => void>()
export function subscribeCatalogues(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify() {
  for (const listener of listeners) listener()
}

export function createCatalogueLoader(sources: Record<string, CatalogueSource>, group: string) {
  const states = new Map<InterfaceLanguage, CatalogueStatus>()
  const attempts = new Map<InterfaceLanguage, number>()
  const source = (locale: InterfaceLanguage) => sources[`./catalogues/${locale}/${group}.ts`]
  return {
    status(language: InterfaceLanguage): CatalogueStatus {
      const fallbacks = localeFallbacks(language)
      if (fallbacks.some((locale) => states.get(locale) === 'failed')) return 'failed'
      return fallbacks.some((locale) => source(locale) && states.get(locale) !== 'ready')
        ? 'pending'
        : 'ready'
    },
    load(language: InterfaceLanguage, retry = false) {
      for (const locale of localeFallbacks(language)) {
        const load = source(locale)
        const state = states.get(locale)
        if (!load || (state && !(retry && state === 'failed'))) continue
        const attempt = attempts.get(locale) ?? 0
        states.set(locale, 'pending')
        attempts.set(locale, attempt + 1)
        notify()
        void load(attempt).then(
          (catalogue) => {
            registerCatalog(catalogue, locale)
            states.set(locale, 'ready')
            notify()
          },
          () => {
            states.set(locale, 'failed')
            notify()
          },
        )
      }
    },
    prime(locale: InterfaceLanguage, catalogue: Catalog) {
      registerCatalog(catalogue, locale)
      states.set(locale, 'ready')
    },
  }
}

export type CatalogueLoader = ReturnType<typeof createCatalogueLoader>
