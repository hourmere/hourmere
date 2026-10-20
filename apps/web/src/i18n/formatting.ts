/** Lists of user-entered names or selected answers use the interface locale's punctuation. */
export function formatList(values: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { type: 'conjunction', style: 'narrow' }).format(values)
}
