/**
 * Additive aliases for stable /api/v1 error codes. Keep the original code for all of v1;
 * register new aliases here so response mapping and the documented code set stay together.
 */
export const errorAliases = {
  zoom_refresh_in_progress: 'zoom_operation_busy',
} as const

export function errorAliasFor(code: string) {
  return Object.hasOwn(errorAliases, code)
    ? errorAliases[code as keyof typeof errorAliases]
    : undefined
}
