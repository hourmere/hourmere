import {
  explicitLanguage,
  formattingLocale,
  type InterfaceLanguage,
  type InterfaceSurface,
  interfaceLanguage,
  interfaceLanguages,
  localeRegistry,
  registeredLocales,
} from '@hourmere/core/language'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { ScopedRouteErrorBoundary } from '../components/route-error-scope.tsx'
import { browserLanguage, chooseLanguage, languageChoice, subscribeLanguage } from './store.ts'
import { renderUiText } from './text.tsx'
import {
  type MessageKey,
  translate,
  translateMessage,
  type UiMessage,
  type UiText,
} from './translate.ts'

const Surface = createContext<InterfaceSurface>('public')
export function InterfaceScope({
  surface,
  children,
}: {
  surface: InterfaceSurface
  children: ReactNode
}) {
  return <Surface value={surface}>{children}</Surface>
}

const ScopedLanguage = createContext<{
  language: InterfaceLanguage | undefined
  setLanguage: (language: InterfaceLanguage) => void
  memoryOnly: boolean
} | null>(null)
export function EmbedLanguage({
  language,
  children,
}: {
  language: InterfaceLanguage | undefined
  children: ReactNode
}) {
  return (
    <LanguageScope language={language} memoryOnly={false}>
      {children}
    </LanguageScope>
  )
}

/** A capability page can offer the language picker without touching the preference store. */
export function MemoryLanguage({ children }: { children: ReactNode }) {
  return <LanguageScope memoryOnly>{children}</LanguageScope>
}

/** Follow the public preference until a language is chosen within the preview. */
export function PreviewLanguage({ children }: { children: ReactNode }) {
  const preference = useSyncExternalStore(subscribeLanguage, languageChoice, emptyPreference)
  return (
    <InterfaceScope surface="public">
      <AccountDefault value={undefined}>
        <LanguageScope fallbackLanguage={preference} memoryOnly>
          {children}
        </LanguageScope>
      </AccountDefault>
    </InterfaceScope>
  )
}

function LanguageScope({
  language,
  fallbackLanguage,
  memoryOnly,
  children,
}: {
  language?: InterfaceLanguage | undefined
  fallbackLanguage?: InterfaceLanguage | undefined
  memoryOnly: boolean
  children: ReactNode
}) {
  const [current, setCurrent] = useState(language)
  return (
    <ScopedLanguage
      value={{ language: current ?? fallbackLanguage, setLanguage: setCurrent, memoryOnly }}
    >
      <ScopedRouteErrorBoundary>{children}</ScopedRouteErrorBoundary>
    </ScopedLanguage>
  )
}
const AccountDefault = createContext<InterfaceLanguage | undefined>(undefined)
/** Only signed-in routes pass an already loaded profile. This never requests a session. */
export function AccountLanguage({
  locale,
  children,
}: {
  locale: string | undefined
  children: ReactNode
}) {
  return (
    <AccountDefault value={interfaceLanguage(locale)}>
      <ScopedRouteErrorBoundary>{children}</ScopedRouteErrorBoundary>
    </AccountDefault>
  )
}
const subscribeInMemory = () => () => {}
const emptyPreference = () => undefined

export function useI18n() {
  const scoped = useContext(ScopedLanguage)
  const memoryOnly = scoped?.memoryOnly === true
  const explicit = useSyncExternalStore(
    memoryOnly ? subscribeInMemory : subscribeLanguage,
    memoryOnly ? emptyPreference : languageChoice,
    emptyPreference,
  )
  const account = useContext(AccountDefault)
  const surface = useContext(Surface)
  const available = interfaceLanguages(surface)
  const supported = (language: InterfaceLanguage | undefined) =>
    language && available.includes(language) ? language : undefined
  const preference = scoped?.language ?? explicit
  const selected = supported(preference)
  const locale = selected ?? supported(account) ?? browserLanguage(surface)
  // Keep the browser's regional conventions for implicit English. Every other active
  // language, including a browser preference, uses its registered formatting locale.
  const formatLanguage = selected ?? (locale === 'en' ? undefined : locale)
  const formatLocale = formatLanguage ? formattingLocale(formatLanguage) : undefined
  const scopedSetLanguage = scoped?.setLanguage
  const setLanguage = useCallback(
    (language: InterfaceLanguage) => {
      const valid = explicitLanguage(language)
      if (!valid || !interfaceLanguages(surface).includes(valid)) return
      scopedSetLanguage?.(valid)
      if (!memoryOnly) chooseLanguage(valid)
    },
    [memoryOnly, scopedSetLanguage, surface],
  )
  const t = useCallback(
    (key: MessageKey, values?: UiMessage['values']) =>
      translate(locale, key, values, { dateLocale: formatLocale }),
    [locale, formatLocale],
  )
  const ui = useCallback(
    (message: UiText | null | undefined) =>
      translateMessage(locale, message, { dateLocale: formatLocale }),
    [locale, formatLocale],
  )
  const text = useCallback(
    (key: MessageKey, values?: UiMessage['values']) => renderUiText(locale, t(key, values)),
    [locale, t],
  )
  const uiText = useCallback(
    (message: UiText | null | undefined) => renderUiText(locale, ui(message)),
    [locale, ui],
  )
  return { locale, explicit: selected, formatLocale, available, setLanguage, t, ui, text, uiText }
}
/** Changing this control updates text in place; router keys and form state do not change. */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, t, available, setLanguage } = useI18n()
  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = localeRegistry[locale].direction
  }, [locale])
  return (
    <label className={`language-picker${compact ? ' language-picker-compact' : ''}`}>
      <span>{t('Interface language')}</span>
      <select
        aria-label={t('Interface language')}
        value={locale}
        onChange={(event) => {
          const value = explicitLanguage(event.target.value)
          if (value) setLanguage(value)
        }}
      >
        {registeredLocales
          .filter(({ code }) => available.includes(code))
          .map(({ code, nativeName }) => (
            <option key={code} value={code} lang={code}>
              {nativeName}
            </option>
          ))}
      </select>
    </label>
  )
}
