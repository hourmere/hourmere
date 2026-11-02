/** Stable additive field names for redirect errors; value validation stays in the service. */
export const SUCCESS_REDIRECT_ERROR_FIELDS = [
  'successRedirect',
  'successRedirect.url',
  'successRedirect.parameters',
  'successRedirect.includeInviteePersonalData',
  'successRedirect.allowEmbedParent',
] as const
export type SuccessRedirectErrorField = (typeof SUCCESS_REDIRECT_ERROR_FIELDS)[number]

export function successRedirectErrorField(
  code: string,
  detail: string | undefined,
): SuccessRedirectErrorField | undefined {
  if (code !== 'invalid_success_redirect') return undefined
  for (const field of SUCCESS_REDIRECT_ERROR_FIELDS.slice(1))
    if (detail?.startsWith(`${field} `)) return field
  // The service's privacy warning names the required opt-in, without echoing input.
  if (detail?.includes('Set includeInviteePersonalData to true'))
    return 'successRedirect.includeInviteePersonalData'
  return 'successRedirect'
}

export function successRedirectIssueField(
  issues: readonly { path: readonly PropertyKey[] }[],
): SuccessRedirectErrorField | undefined {
  const issue = issues.find((item) => item.path[0] === 'successRedirect')
  if (!issue) return undefined
  const field = `successRedirect.${String(issue.path[1])}`
  return SUCCESS_REDIRECT_ERROR_FIELDS.find((known) => known === field) ?? 'successRedirect'
}

/** Reuse the transport's text guard and expose only known field names, never input. */
export function successRedirectUnsafeField(
  value: unknown,
  unsafe: (value: unknown) => boolean,
): SuccessRedirectErrorField | undefined {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'successRedirect'))
    return undefined
  const settings = (value as Record<string, unknown>).successRedirect
  if (!unsafe(settings)) return undefined
  if (typeof settings === 'object' && settings !== null)
    for (const field of SUCCESS_REDIRECT_ERROR_FIELDS.slice(1)) {
      const key = field.slice('successRedirect.'.length)
      if (unsafe((settings as Record<string, unknown>)[key])) return field
    }
  return 'successRedirect'
}
