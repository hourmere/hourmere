import {
  explicitLanguage,
  type InterfaceLanguage,
  interfaceLanguage,
} from '@hourmere/core/language'

const messages = {
  en: {
    iframe: 'Book a meeting with Hourmere',
    title: 'Book a meeting',
    close: 'Close',
    closeLabel: 'Close booking',
    failure:
      'The booking widget could not load. Check its Hourmere URL and the instance embedding settings.',
  },
  'zh-CN': {
    iframe: '通过 Hourmere 预约会议',
    title: '预约会议',
    close: '关闭',
    closeLabel: '关闭预约窗口',
    failure: '预约组件无法加载。请检查 Hourmere 地址和实例的嵌入设置。',
  },
} as const

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
export const widgetMessages = (language: InterfaceLanguage) => messages[language]
