import type { InterfaceLanguage } from '@hourmere/core/language'
import type { admin } from './admin.ts'
import { common } from './common.ts'
import { spaceCjkBoundaries } from './formatting.ts'
export type MessageKey = keyof typeof common | keyof typeof admin
export type Catalog = Readonly<Record<string, string>>
export interface UiMessage {
  readonly key: MessageKey
  readonly values: Readonly<
    Record<string, string | number | UiMessage | UiLiteral | UiDate | UiList>
  >
}
export interface UiLiteral {
  readonly literal: string
}
export interface UiDate {
  readonly date: string
}
export interface UiList {
  readonly items: readonly UiText[]
  readonly separator: '; ' | ' · '
}
export type UiText = string | UiMessage | UiLiteral | UiDate | UiList
export function joinMessages(
  items: readonly UiText[],
  separator: UiList['separator'] = '; ',
): UiList {
  return { items, separator }
}
export function dateMessage(date: string): UiDate {
  return { date }
}
export function literal(text: string): UiLiteral {
  return { literal: text }
}
export function msg(key: MessageKey, values: UiMessage['values'] = {}): UiMessage {
  return { key, values }
}
const catalogs: Catalog[] = [common]
/** Registered by the lazy session graph; public routes never import the admin catalog. */
export function registerCatalog(catalog: Catalog) {
  if (!catalogs.includes(catalog)) catalogs.push(catalog)
}
export interface TranslationFormat {
  /** Undefined deliberately retains the browser’s full default BCP 47 date format. */
  readonly dateLocale: string | undefined
}
export function translate(
  locale: InterfaceLanguage,
  key: MessageKey,
  values: UiMessage['values'] = {},
  formatting?: TranslationFormat,
): string {
  let template: string = key
  if (locale === 'zh-CN')
    for (const catalog of catalogs)
      if (Object.hasOwn(catalog, key)) {
        template = catalog[key] ?? key
        break
      }
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string, offset: number) => {
    if (!Object.hasOwn(values, name)) return placeholder
    const value = values[name]
    const text =
      typeof value === 'object' && value !== null
        ? translateMessage(locale, value, formatting)
        : typeof value === 'number'
          ? new Intl.NumberFormat(locale, { useGrouping: false }).format(value)
          : String(value)
    // Chinese templates butt against inserted names and titles; only Latin edges get a space.
    return locale === 'zh-CN'
      ? spaceCjkBoundaries(
          template.slice(0, offset),
          text,
          template.slice(offset + placeholder.length),
        )
      : text
  })
}
/** Plain strings here are local semantic keys; dynamic arguments remain untouched user data. */
export function translateMessage(
  locale: InterfaceLanguage,
  message: UiText | null | undefined,
  formatting?: TranslationFormat,
): string {
  if (!message) return ''
  if (typeof message !== 'string') {
    if ('literal' in message) return message.literal
    if ('items' in message)
      return message.items
        .map((item) => translateMessage(locale, item, formatting))
        .join(message.separator)
    if ('date' in message)
      return new Intl.DateTimeFormat(formatting ? formatting.dateLocale : locale, {
        calendar: 'gregory',
        timeZone: 'UTC',
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }).format(new Date(`${message.date}T00:00:00Z`))
    return translate(locale, message.key, message.values, formatting)
  }
  if (locale === 'en') return message
  for (const catalog of catalogs)
    if (Object.hasOwn(catalog, message)) return catalog[message] ?? message
  return message
}

/** History state is untrusted; only bounded records with known keys are accepted. */
export function isUiText(value: unknown, depth = 0): value is UiText {
  if (typeof value === 'string') return value.length <= 5000
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const record = value as Record<string, unknown>
  if (Object.hasOwn(record, 'items'))
    return (
      Object.keys(record).length === 2 &&
      Array.isArray(record.items) &&
      record.items.length <= 1000 &&
      (record.separator === '; ' || record.separator === ' · ') &&
      record.items.every((item) => isUiText(item, depth + 1))
    )
  if (Object.hasOwn(record, 'date'))
    return (
      Object.keys(record).length === 1 &&
      typeof record.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(record.date) &&
      Number.isFinite(Date.parse(`${record.date}T00:00:00Z`))
    )
  if (Object.hasOwn(record, 'literal'))
    return (
      Object.keys(record).length === 1 &&
      typeof record.literal === 'string' &&
      record.literal.length <= 5000
    )
  if (
    Object.keys(record).some((key) => key !== 'key' && key !== 'values') ||
    typeof record.key !== 'string' ||
    !catalogs.some((catalog) => Object.hasOwn(catalog, record.key as string))
  )
    return false
  if (!record.values || typeof record.values !== 'object' || Array.isArray(record.values))
    return false
  const valuesPrototype = Object.getPrototypeOf(record.values)
  if (valuesPrototype !== Object.prototype && valuesPrototype !== null) return false
  const entries = Object.entries(record.values)
  return (
    entries.length <= 32 &&
    entries.every(
      ([key, argument]) =>
        /^\w{1,32}$/.test(key) &&
        (typeof argument === 'number' ? Number.isFinite(argument) : isUiText(argument, depth + 1)),
    )
  )
}
