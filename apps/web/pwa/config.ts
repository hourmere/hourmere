/** Build-time only; an empty copied setting follows the current default. */
export function pwaEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'true') return true
  if (value === 'false') return false
  throw new Error('VITE_PWA_ENABLED must be empty, true, or false')
}
