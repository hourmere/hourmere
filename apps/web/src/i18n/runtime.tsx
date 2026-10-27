import {
  explicitLanguage,
  formattingLocale,
  type InterfaceLanguage,
  type InterfaceSurface,
  interfaceLanguage,
  interfaceLanguages,
  localeFallbacks,
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

const EmbeddedLanguage = createContext<{
  language: InterfaceLanguage | undefined
  setLanguage: (language: InterfaceLanguage) => void
} | null>(null)
export function EmbedLanguage({
  language,
  children,
}: {
  language: InterfaceLanguage | undefined
  children: ReactNode
}) {
  const [current, setCurrent] = useState(language)
  return (
    <EmbeddedLanguage value={{ language: current, setLanguage: setCurrent }}>
      <ScopedRouteErrorBoundary>{children}</ScopedRouteErrorBoundary>
    </EmbeddedLanguage>
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
export function useI18n() {
  const explicit = useSyncExternalStore(subscribeLanguage, languageChoice, () => undefined)
  const account = useContext(AccountDefault)
  const embedded = useContext(EmbeddedLanguage)
  const surface = useContext(Surface)
  const available = interfaceLanguages(surface)
  const supported = (language: InterfaceLanguage) =>
    localeFallbacks(language).find((code) => available.includes(code)) ?? 'en'
  const preference = embedded?.language ?? explicit
  const selected = preference ? supported(preference) : undefined
  const locale = selected ?? supported(account ?? browserLanguage(surface))
  // Keep the browser's regional conventions for implicit English. Every other active
  // language, including a browser preference, uses its registered formatting locale.
  const formatLanguage = selected ?? (locale === 'en' ? undefined : locale)
  const formatLocale = formatLanguage ? formattingLocale(formatLanguage) : undefined
  const scopedSetLanguage = embedded?.setLanguage
  const setLanguage = useCallback(
    (language: InterfaceLanguage) => {
      const valid = explicitLanguage(language)
      if (!valid || !interfaceLanguages(surface).includes(valid)) return
      scopedSetLanguage?.(valid)
      chooseLanguage(valid)
    },
    [scopedSetLanguage, surface],
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
