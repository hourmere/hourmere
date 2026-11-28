import { explicitLanguage, type InterfaceLanguage } from '@hourmere/core/language'

/** The iframe query overrides language only when one supported value is present. */
export function embedQueryLanguage(search: string): InterfaceLanguage | undefined {
  const query = new URLSearchParams(search)
  return query.getAll('language').length === 1 ? explicitLanguage(query.get('language')) : undefined
}
