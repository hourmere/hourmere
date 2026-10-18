import {
  cookieLanguage,
  explicitLanguage,
  type InterfaceLanguage,
  interfaceLanguage,
  LANGUAGE_COOKIE,
} from '@hourmere/core/language'

const STORAGE_KEY = LANGUAGE_COOKIE
let choice: InterfaceLanguage | undefined
let initialized = false
const listeners = new Set<() => void>()
export function browserLanguage(): InterfaceLanguage {
  try {
    for (const locale of navigator.languages?.length ? navigator.languages : [navigator.language]) {
      const known = interfaceLanguage(locale)
      if (known) return known
    }
  } catch {
    /* Browser APIs can be absent or denied. */
  }
  return 'en'
}
function readPreference() {
  if (initialized) return
  initialized = true
  try {
    choice = explicitLanguage(localStorage.getItem(STORAGE_KEY))
  } catch {
    /* Storage may be disabled. */
  }
  try {
    choice ??= cookieLanguage(document.cookie)
  } catch {
    /* Cookie access can be disabled too. */
  }
}
export function languageChoice(): InterfaceLanguage | undefined {
  readPreference()
  return choice
}
export function subscribeLanguage(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function chooseLanguage(language: InterfaceLanguage) {
  const valid = explicitLanguage(language)
  if (!valid) return
  initialized = true
  choice = valid
  try {
    localStorage.setItem(STORAGE_KEY, valid)
  } catch {
    /* The current tab still works. */
  }
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: synchronous preference works in Safari and browsers without Cookie Store
    document.cookie = `${LANGUAGE_COOKIE}=${valid}; Path=/; SameSite=Lax; Max-Age=31536000${location.protocol === 'https:' ? '; Secure' : ''}`
  } catch {
    /* The current tab still works. */
  }
  for (const listener of listeners) listener()
}
/** Test-only reset and browser changes never contain account data or capabilities. */
export function resetLanguagePreference() {
  choice = undefined
  initialized = false
  for (const listener of listeners) listener()
}
