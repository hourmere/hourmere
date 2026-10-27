import { explicitLanguage, type InterfaceLanguage } from '@hourmere/core/language'

export type Catalog = Readonly<Record<string, string>>
const catalogs = new Map<InterfaceLanguage, Catalog[]>()

export function registerCatalog(catalog: Catalog, locale: InterfaceLanguage = 'zh-CN') {
  const existing = catalogs.get(locale) ?? []
  if (!existing.includes(catalog)) existing.push(catalog)
  catalogs.set(locale, existing)
}

/** Vite discovers catalogues; adding a registered locale needs no loader edits. */
export function registerCatalogues(modules: Record<string, Catalog>) {
  for (const [path, catalog] of Object.entries(modules)) {
    const locale = explicitLanguage(path.match(/\/catalogues\/([^/]+)\//)?.[1])
    if (locale) registerCatalog(catalog, locale)
  }
}

export function catalogTemplate(locale: InterfaceLanguage, key: string): string | undefined {
  for (const catalog of catalogs.get(locale) ?? [])
    if (Object.hasOwn(catalog, key) && catalog[key]) return catalog[key]
  return undefined
}

export function knownMessage(key: string): boolean {
  return catalogTemplate('en', key) !== undefined
}

/** Missing translations are allowed; translated placeholders must match English exactly. */
export function catalogueCoverage(english: Catalog, translated: Catalog) {
  const placeholders = (value: string) => {
    const matches = [...value.matchAll(/\{(\w+)\}/g)]
    if (value.replace(/\{\w+\}/g, '').match(/[{}]/)) return undefined
    return matches
      .map((match) => match[1])
      .sort()
      .join(',')
  }
  const missing = Object.keys(english).filter((key) => !translated[key])
  const malformed = Object.entries(translated)
    .filter(
      ([key, value]) =>
        !Object.hasOwn(english, key) ||
        !value ||
        placeholders(value) === undefined ||
        placeholders(value) !== placeholders(english[key] ?? ''),
    )
    .map(([key]) => key)
  return {
    total: Object.keys(english).length,
    translated: Object.keys(english).length - missing.length,
    missing,
    malformed,
  }
}
