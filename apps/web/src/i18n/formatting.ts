/** Lists of user-entered names or selected answers use the interface locale's punctuation. */
export function formatList(values: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { type: 'conjunction', style: 'narrow' }).format(values)
}

/**
 * Space a Latin or numeric edge of inserted text where it meets Han prose, as the mail
 * templates do: `与{host}的` reads 与 Grace Hopper 的 and 与王小明的 from one template. The
 * inserted text itself is never rewritten.
 */
export function spaceCjkBoundaries(before: string, value: string, after: string): string {
  const leading =
    /\p{Script=Han}$/u.test(before) && /^[\p{Script=Latin}\p{Number}]/u.test(value) ? ' ' : ''
  const trailing =
    /[\p{Script=Latin}\p{Number}]\p{M}*$/u.test(value) && /^\p{Script=Han}/u.test(after) ? ' ' : ''
  return `${leading}${value}${trailing}`
}
