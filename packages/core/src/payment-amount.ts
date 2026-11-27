/** Format a priced booking without performing currency arithmetic in floating point. */
export function formatPaymentAmount(
  { amountMinor, currency }: { amountMinor: number; currency: string },
  locale?: string,
): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
  })
  const places = formatter.resolvedOptions().maximumFractionDigits ?? 0
  if (places === 0) return formatter.format(amountMinor)
  const digits = String(amountMinor).padStart(places + 1, '0')
  // ECMA-402's decimal string input avoids conversion to binary floating point.
  const format = formatter.format as typeof formatter.format & ((decimal: string) => string)
  return format(`${digits.slice(0, -places)}.${digits.slice(-places)}`)
}
