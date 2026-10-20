/** Lists of user-entered names or selected answers use the interface locale's punctuation. */
export function formatList(values: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { type: 'conjunction', style: 'narrow' }).format(values)
}

/**
 * Space only between Han and half-width [A-Za-z0-9], never next to full-width punctuation.
 * Thus `与{host}的` reads 与 Grace Hopper 的 and 与王小明的 from one template. Other scripts,
 * full-width letters/digits and punctuation at an insertion's edge stay unspaced; the
 * inserted text itself is never rewritten.
 */
export function spaceCjkBoundaries(before: string, value: string, after: string): string {
  const leading = /\p{Script=Han}$/u.test(before) && /^[A-Za-z0-9]/.test(value) ? ' ' : ''
  const trailing = /[A-Za-z0-9]$/.test(value) && /^\p{Script=Han}/u.test(after) ? ' ' : ''
  return `${leading}${value}${trailing}`
}
