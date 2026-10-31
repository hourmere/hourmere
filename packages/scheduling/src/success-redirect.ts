import { isIP } from 'node:net'
import { DomainError } from './errors.ts'
import { isSingleLineText } from './text.ts'

export const SUCCESS_REDIRECT_MAX_LENGTH = 2000
export const SUCCESS_REDIRECT_PARAMETERS = [
  'eventTypeSlug',
  'start',
  'end',
  'timeZone',
  'hostName',
  'inviteeName',
  'inviteeEmail',
] as const
export type SuccessRedirectParameter = (typeof SUCCESS_REDIRECT_PARAMETERS)[number]

export interface SuccessRedirectInput {
  url: string
  parameters?: SuccessRedirectParameter[] | undefined
  /** Name/email become visible to the target website and its analytics. Defaults off. */
  includeInviteePersonalData?: boolean | undefined
  /** Separate permission to leave an embedded booking's parent page. Defaults off. */
  allowEmbedParent?: boolean | undefined
}

export interface SuccessRedirect {
  url: string
  parameters: SuccessRedirectParameter[]
  includeInviteePersonalData: boolean
  allowEmbedParent: boolean
}

export interface SuccessRedirectPolicy {
  /** The instance's own hostname is allowed, including an IP host. HTTPS is still required. */
  publicUrl?: string | undefined
  /** Explicit instance opt-in; IP literals otherwise fail closed. */
  allowIpHosts?: boolean | undefined
}

/** Immutable creation-time destination, returned only by a successful public booking. */
export interface BookingSuccessRedirect {
  url: string
  allowEmbedParent: boolean
}

const invalid = (message: string) => new DomainError('invalid', 'invalid_success_redirect', message)
const hostname = (url: URL) => url.hostname.replace(/\.$/, '').toLowerCase()

/** Shared by all configuration entry points; URL parsing cannot silently discard controls. */
export function validateSuccessRedirect(
  value: unknown,
  policy: SuccessRedirectPolicy = {},
): SuccessRedirect | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value))
    throw invalid('successRedirect must be an object or null')
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).some(
      (key) =>
        !['url', 'parameters', 'includeInviteePersonalData', 'allowEmbedParent'].includes(key),
    )
  )
    throw invalid('successRedirect contains an unknown setting')
  const raw = input.url
  if (
    typeof raw !== 'string' ||
    raw.length > SUCCESS_REDIRECT_MAX_LENGTH ||
    !isSingleLineText(raw) ||
    !/^https:\/\//i.test(raw) ||
    /\s/u.test(raw) ||
    raw.includes('\\')
  )
    throw invalid(
      'successRedirect.url must be an absolute HTTPS URL of at most 2000 characters without control characters',
    )
  const authority = raw.slice(8).split(/[/?#]/, 1)[0] ?? ''
  if (!authority || authority.includes('@'))
    throw invalid('successRedirect.url must not contain user information')
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    throw invalid('successRedirect.url must be an absolute HTTPS URL')
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.href.length > SUCCESS_REDIRECT_MAX_LENGTH
  )
    throw invalid(
      'successRedirect.url must be an absolute HTTPS URL of at most 2000 characters without user information',
    )
  const host = hostname(target)
  const ip = isIP(host.replace(/^\[|\]$/g, '')) !== 0
  if (
    !ip &&
    (host.length > 253 ||
      !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
  )
    throw invalid('successRedirect.url must have a valid hostname')
  let ownHost: string | undefined
  if (policy.publicUrl && URL.canParse(policy.publicUrl))
    ownHost = hostname(new URL(policy.publicUrl))
  if (ip && policy.allowIpHosts !== true && host !== ownHost)
    throw invalid(
      'successRedirect.url cannot use an IP host unless the instance explicitly allows it',
    )
  for (const key of ['includeInviteePersonalData', 'allowEmbedParent'])
    if (input[key] !== undefined && typeof input[key] !== 'boolean')
      throw invalid(`successRedirect.${key} must be true or false`)
  const parameters = input.parameters ?? []
  if (
    !Array.isArray(parameters) ||
    parameters.some((key) => !SUCCESS_REDIRECT_PARAMETERS.includes(key)) ||
    new Set(parameters).size !== parameters.length
  )
    throw invalid(
      `successRedirect.parameters must contain distinct names from ${SUCCESS_REDIRECT_PARAMETERS.join(', ')}`,
    )
  if (
    input.includeInviteePersonalData !== true &&
    parameters.some((key) => key === 'inviteeName' || key === 'inviteeEmail')
  )
    throw invalid(
      'Invitee names and emails become visible to the target website and its analytics. Set includeInviteePersonalData to true to explicitly opt in.',
    )
  return {
    url: target.href,
    parameters: [...parameters] as SuccessRedirectParameter[],
    includeInviteePersonalData: input.includeInviteePersonalData === true,
    allowEmbedParent: input.allowEmbedParent === true,
  }
}

/** Only explicit public fields are selectable; never serialize a booking or request object. */
export function bookingSuccessRedirect(
  settings: SuccessRedirect | null,
  values: Record<SuccessRedirectParameter, string>,
): BookingSuccessRedirect | undefined {
  if (!settings) return undefined
  const url = new URL(settings.url)
  for (const key of settings.parameters) url.searchParams.append(key, values[key])
  return { url: url.href, allowEmbedParent: settings.allowEmbedParent }
}
