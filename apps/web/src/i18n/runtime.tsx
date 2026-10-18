import {
  explicitLanguage,
  type InterfaceLanguage,
  interfaceLanguage,
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
import { browserLanguage, chooseLanguage, languageChoice, subscribeLanguage } from './store.ts'
import {
  type MessageKey,
  translate,
  translateMessage,
  type UiMessage,
  type UiText,
} from './translate.ts'

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
      {children}
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
  return <AccountDefault value={interfaceLanguage(locale)}>{children}</AccountDefault>
}
export function useI18n() {
  const explicit = useSyncExternalStore(subscribeLanguage, languageChoice, () => undefined)
  const account = useContext(AccountDefault)
  const embedded = useContext(EmbeddedLanguage)
  const selected = embedded?.language ?? explicit
  const locale = selected ?? account ?? browserLanguage()
  const scopedSetLanguage = embedded?.setLanguage
  const setLanguage = useCallback(
    (language: InterfaceLanguage) => {
      const valid = explicitLanguage(language)
      if (!valid) return
      scopedSetLanguage?.(valid)
      chooseLanguage(valid)
    },
    [scopedSetLanguage],
  )
  const t = useCallback(
    (key: MessageKey, values?: UiMessage['values']) =>
      translate(locale, key, values, { dateLocale: selected }),
    [locale, selected],
  )
  const ui = useCallback(
    (message: UiText | null | undefined) =>
      translateMessage(locale, message, { dateLocale: selected }),
    [locale, selected],
  )
  return { locale, explicit: selected, formatLocale: selected, setLanguage, t, ui }
}
/** Changing this control updates text in place; router keys and form state do not change. */
export function LanguageSwitcher() {
  const { locale, t, setLanguage } = useI18n()
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return (
    <label className="language-picker">
      <span>{t('Interface language')}</span>
      <select
        aria-label={t('Interface language')}
        value={locale}
        onChange={(event) => {
          const value = event.target.value
          if (value === 'en' || value === 'zh-CN') setLanguage(value)
        }}
      >
        <option value="en" lang="en">
          English
        </option>
        <option value="zh-CN" lang="zh-CN">
          简体中文
        </option>
      </select>
    </label>
  )
}
