/** Lists of user-entered names or selected answers use the interface locale's punctuation. */
export function formatList(values: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { type: 'conjunction', style: 'narrow' }).format(values)
}

/** Space Latin name edges in Chinese prose without adding spaces beside Chinese names. */
export function formatCjkName(name: string, locale: string): string {
  if (!locale.startsWith('zh')) return name
  return `${/^[\p{Script=Latin}\p{Number}]/u.test(name) ? ' ' : ''}${name}${/[\p{Script=Latin}\p{Number}]$/u.test(name) ? ' ' : ''}`
}
