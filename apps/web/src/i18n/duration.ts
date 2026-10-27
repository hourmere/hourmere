import { interfaceLanguage } from '@hourmere/core/language'
import { translate } from './translate.ts'

/** "30 min", "1 h", "1 h 30 min", "2 days", "1 day 4 h". */
export function formatMinutes(total: number, locale = 'en'): string {
  const language = interfaceLanguage(locale) ?? 'en'
  if (total === 0) return translate(language, '{count} min', { count: 0 })
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const minutes = total % 60
  const parts: string[] = []
  if (days)
    parts.push(translate(language, days === 1 ? '{count} day' : '{count} days', { count: days }))
  if (hours) parts.push(translate(language, '{count} h', { count: hours }))
  if (minutes) parts.push(translate(language, '{count} min', { count: minutes }))
  return parts.join(' ')
}

/** `30 min`, `1 h`, `1 h 30 min`. */
export function formatDuration(minutes: number, locale = 'en'): string {
  const language = interfaceLanguage(locale) ?? 'en'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return translate(language, '{count} min', { count: minutes })
  const parts = [translate(language, '{count} h', { count: hours })]
  if (rest) parts.push(translate(language, '{count} min', { count: rest }))
  return parts.join(' ')
}
