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
import {
  type CatalogueLoader,
  INITIAL_LOCALE_WAIT_MS,
  subscribeCatalogues,
} from './catalogue-loader.ts'
import { commonCatalogue } from './common.ts'
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
  fallback,
  initialLanguage,
  memoryOnly,
  children,
}: {
  surface: InterfaceSurface
  fallback?: ReactNode
  initialLanguage?: InterfaceLanguage | undefined
  memoryOnly?: boolean | undefined
  children: ReactNode
}) {
  return (
    <Surface value={surface}>
      <CatalogueBoundary fallback={fallback} language={initialLanguage} memoryOnly={memoryOnly}>
        {children}
      </CatalogueBoundary>
    </Surface>
  )
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
    <AdminCatalogue value={undefined}>
      <AccountDefault value={undefined}>
        <Surface value="public">
          <LanguageScope fallbackLanguage={preference} memoryOnly>
            {children}
          </LanguageScope>
        </Surface>
      </AccountDefault>
    </AdminCatalogue>
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
      <CatalogueBoundary>
        <ScopedRouteErrorBoundary>{children}</ScopedRouteErrorBoundary>
      </CatalogueBoundary>
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
      <CatalogueBoundary>
        <ScopedRouteErrorBoundary>{children}</ScopedRouteErrorBoundary>
      </CatalogueBoundary>
    </AccountDefault>
  )
}
const subscribeInMemory = () => () => {}
const emptyPreference = () => undefined

const AdminCatalogue = createContext<CatalogueLoader | undefined>(undefined)
const ActiveLocale = createContext<{ locale: InterfaceLanguage; pending: boolean } | undefined>(
  undefined,
)

export function AdminCatalogueScope({
  catalogue,
  children,
}: {
  catalogue: CatalogueLoader
  children: ReactNode
}) {
  return <AdminCatalogue value={catalogue}>{children}</AdminCatalogue>
}

function useLanguagePreference(override?: {
  language?: InterfaceLanguage | undefined
  memoryOnly?: boolean | undefined
}) {
  const scoped = useContext(ScopedLanguage)
  const memoryOnly = override?.memoryOnly ?? scoped?.memoryOnly ?? false
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
  const selected = supported(override?.language ?? scoped?.language ?? explicit)
  const requested = selected ?? supported(account) ?? browserLanguage(surface)
  return {
    requested,
    selected,
    available,
    surface,
    memoryOnly,
    scopedSetLanguage: scoped?.setLanguage,
  }
}

/** An initial wait covers both profile resolution and the catalogue it selects. */
export function CatalogueBoundary({
  children,
  fallback,
  awaitingProfile = false,
  language,
  memoryOnly,
}: {
  children: ReactNode
  fallback?: ReactNode
  awaitingProfile?: boolean
  language?: InterfaceLanguage | undefined
  memoryOnly?: boolean | undefined
}) {
  const { requested, selected, available } = useLanguagePreference({ language, memoryOnly })
  const admin = useContext(AdminCatalogue)
  const status = useSyncExternalStore(
    subscribeCatalogues,
    () => {
      const commonStatus = commonCatalogue.status(requested)
      const adminStatus = admin?.status(requested)
      if (commonStatus === 'failed' || adminStatus === 'failed') return 'failed'
      return commonStatus === 'pending' || adminStatus === 'pending' ? 'pending' : 'ready'
    },
    () => 'ready',
  )
  useEffect(() => {
    if (awaitingProfile && !selected) return
    commonCatalogue.load(requested)
    admin?.load(requested)
  }, [requested, awaitingProfile, selected, admin])

  const [previous, setPrevious] = useState<InterfaceLanguage>('en')
  const locale =
    status === 'ready'
      ? requested
      : status === 'pending' && available.includes(previous)
        ? previous
        : 'en'
  if (locale !== previous) setPrevious(locale)

  const [revealed, setRevealed] = useState(fallback === undefined)
  const waiting = (awaitingProfile && !selected) || status === 'pending'
  if (!revealed && !waiting) setRevealed(true)
  useEffect(() => {
    if (revealed) return
    const timeout = setTimeout(() => setRevealed(true), INITIAL_LOCALE_WAIT_MS)
    return () => clearTimeout(timeout)
  }, [revealed])
  return (
    <ActiveLocale value={{ locale, pending: status === 'pending' }}>
      {revealed || !waiting ? children : fallback}
    </ActiveLocale>
  )
}

export function useI18n() {
  const { requested, selected, available, scopedSetLanguage, memoryOnly, surface } =
    useLanguagePreference()
  const active = useContext(ActiveLocale)
  const locale = active?.locale ?? requested
  const admin = useContext(AdminCatalogue)
  // Keep the browser's regional conventions for implicit English. Every other active
  // language, including a browser preference, uses its registered formatting locale.
  const formatLanguage = locale !== 'en' || selected === 'en' ? locale : undefined
  const formatLocale = formatLanguage ? formattingLocale(formatLanguage) : undefined
  const setLanguage = useCallback(
    (language: InterfaceLanguage) => {
      const valid = explicitLanguage(language)
      if (!valid || !interfaceLanguages(surface).includes(valid)) return
      commonCatalogue.load(valid, true)
      admin?.load(valid, true)
      scopedSetLanguage?.(valid)
      if (!memoryOnly) chooseLanguage(valid)
    },
    [admin, memoryOnly, scopedSetLanguage, surface],
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
  return {
    locale,
    requested,
    selecting: active?.pending ? requested : locale,
    explicit: selected,
    formatLocale,
    available,
    setLanguage,
    t,
    ui,
    text,
    uiText,
  }
}
export function useDocumentLanguage(locale: InterfaceLanguage) {
  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = localeRegistry[locale].direction
  }, [locale])
}

/** Changing this control updates text in place; router keys and form state do not change. */
export function LanguageSwitcher() {
  const { locale, selecting, t, available, setLanguage } = useI18n()
  useDocumentLanguage(locale)
  return (
    <label className="language-picker">
      <span>{t('Interface language')}</span>
      <select
        aria-label={t('Interface language')}
        value={selecting}
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
