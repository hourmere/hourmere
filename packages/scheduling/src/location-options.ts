import { isDeepStrictEqual } from 'node:util'
import { DomainError } from './errors.ts'
import { cleanText } from './text.ts'

/** The original host-selected settings, also used for a resolved booking location. */
export type EventTypeLocation =
  | { kind: 'google_meet'; autoCreate?: true }
  | { kind: 'zoom'; autoCreate?: true }
  | { kind: 'phone'; number: string }
  | { kind: 'in_person'; address: string }
  | { kind: 'link'; url: string }

/** Invitee phone collection is configuration; the resolved location always has a number. */
export type LocationSettings = EventTypeLocation | { kind: 'phone'; askInvitee: true }
export type LocationOption = LocationSettings & {
  /** Stable within an event type; preserved in the booking snapshot. */
  id: string
  label?: string
  isDefault?: true
}

export const LOCATION_OPTION_LIMITS = {
  count: 5,
  id: 64,
  label: 100,
  address: 500,
  url: 2000,
} as const

const OPTION_ID = /^[a-zA-Z0-9_-]+$/
const PHONE_NUMBER = /^\+[1-9][0-9]{6,14}$/
const kinds = ['google_meet', 'zoom', 'phone', 'in_person', 'link'] as const

function invalid(message: string): never {
  throw new DomainError('invalid', 'invalid_locations', message)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize internal configuration without silently dropping a misspelled setting. */
export function validateLocationOptions(value: unknown): LocationOption[] | null {
  if (value === null) return null
  if (!Array.isArray(value) || value.length < 1 || value.length > LOCATION_OPTION_LIMITS.count)
    return invalid('locations must be null or a list of 1–5 location options')
  const ids = new Set<string>()
  const usedKinds = new Set<string>()
  let defaults = 0
  return Array.from(value).map((item) => {
    if (!record(item)) return invalid('Each location option must be an object')
    const { id, kind } = item
    if (typeof id !== 'string' || id.length > LOCATION_OPTION_LIMITS.id || !OPTION_ID.test(id))
      return invalid(
        'A location option id must contain 1–64 letters, digits, underscores or hyphens',
      )
    if (id === '__proto__') return invalid('A location option id must not be __proto__')
    if (ids.has(id)) return invalid('Location option ids must be distinct')
    ids.add(id)
    if (!kinds.includes(kind as (typeof kinds)[number]))
      return invalid('Choose a supported location kind')
    if (usedKinds.has(kind as string)) return invalid('Location option kinds must be distinct')
    usedKinds.add(kind as string)
    const label =
      item.label === undefined
        ? undefined
        : cleanText(item.label, { max: LOCATION_OPTION_LIMITS.label })
    if (item.label !== undefined && label === undefined)
      return invalid('A location label must be one line of 1–100 characters without controls')
    if (item.isDefault !== undefined && item.isDefault !== true)
      return invalid('isDefault must be true when specified')
    if (item.isDefault === true) defaults++
    if (defaults > 1) return invalid('At most one location option may be the default')
    const metadata = {
      id,
      ...(label === undefined ? {} : { label }),
      ...(item.isDefault === true ? { isDefault: true as const } : {}),
    }
    const only = (settings: string[]) => {
      if (
        Object.keys(item).some(
          (key) => !['id', 'kind', 'label', 'isDefault', ...settings].includes(key),
        )
      )
        invalid('A location option contains an unknown setting')
    }
    switch (kind) {
      case 'google_meet':
      case 'zoom':
        only(['autoCreate'])
        if (item.autoCreate !== undefined && item.autoCreate !== true)
          return invalid('autoCreate must be true when specified')
        return {
          ...metadata,
          kind,
          ...(item.autoCreate === true ? { autoCreate: true as const } : {}),
        }
      case 'phone': {
        only(['number', 'askInvitee'])
        if (item.askInvitee !== undefined) {
          if (item.askInvitee !== true || item.number !== undefined)
            return invalid('A phone option requires either a host number or askInvitee: true')
          return { ...metadata, kind, askInvitee: true }
        }
        if (typeof item.number !== 'string' || !PHONE_NUMBER.test(item.number))
          return invalid('A host phone number must use E.164 format')
        return { ...metadata, kind, number: item.number }
      }
      case 'in_person': {
        only(['address'])
        const address = cleanText(item.address, { max: LOCATION_OPTION_LIMITS.address })
        if (address === undefined)
          return invalid('An address must be one line of 1–500 characters without controls')
        return { ...metadata, kind, address }
      }
      case 'link': {
        only(['url'])
        const given = cleanText(item.url, { max: LOCATION_OPTION_LIMITS.url })
        const url = given !== undefined && URL.canParse(given) ? new URL(given) : undefined
        if (
          !url ||
          !['http:', 'https:'].includes(url.protocol) ||
          url.href.length > LOCATION_OPTION_LIMITS.url
        )
          return invalid(
            'A location link must be an HTTP(S) URL of at most 2000 characters without controls',
          )
        return { ...metadata, kind, url: url.href }
      }
      default:
        return invalid('Choose a supported location kind')
    }
  })
}

/** Initial legacy configuration and historical backfills retain their original settings. */
export function locationOptionsFromLegacy(
  location: LocationSettings | null,
): LocationOption[] | null {
  return location === null ? null : [{ ...location, id: 'legacy' }]
}

function settingsOf(option: LocationOption): LocationSettings {
  const { id: _id, label: _label, isDefault: _isDefault, ...settings } = option
  return settings
}

/** The additive read-compatibility field follows the explicit default, or the first option. */
export function compatLocation(
  locations: readonly LocationOption[] | null,
): LocationSettings | null {
  const option = locations?.find((item) => item.isDefault === true) ?? locations?.[0]
  return option ? settingsOf(option) : null
}

/** Exact echoes may include untouched historical settings that current writes would normalize. */
export function isLegacyLocationEcho(
  locations: LocationOption[] | null,
  location: unknown,
): boolean {
  const current = compatLocation(locations)
  return isDeepStrictEqual(current, location)
}

/** Preserve option identity when an older client echoes or edits the compatibility field. */
export function applyLegacyLocation(
  locations: LocationOption[] | null,
  location: LocationSettings | null,
): LocationOption[] | null {
  if (isLegacyLocationEcho(locations, location)) return locations
  if (locations && (locations.length > 1 || locations[0]?.label !== undefined))
    throw new DomainError(
      'conflict',
      'location_options_conflict',
      'Use locations to change or clear multiple or labelled location options.',
    )
  if (location === null) return null
  const previous = locations?.[0]
  return [
    {
      ...location,
      id: previous?.kind === location.kind ? previous.id : crypto.randomUUID(),
      ...(previous?.isDefault === true ? { isDefault: true as const } : {}),
    },
  ]
}

export type PublicLocationOption = Pick<LocationOption, 'id' | 'kind' | 'label' | 'isDefault'> & {
  askInvitee?: true
}

/** Public choice discovery exposes labels and collection requirements, never host settings. */
export function publicLocationOptions(
  locations: readonly LocationOption[] | null,
): PublicLocationOption[] | null {
  return (
    locations?.map((option) => ({
      id: option.id,
      kind: option.kind,
      ...(option.label === undefined ? {} : { label: option.label }),
      ...(option.isDefault === true ? { isDefault: true as const } : {}),
      ...(option.kind === 'phone' && 'askInvitee' in option ? { askInvitee: true as const } : {}),
    })) ?? null
  )
}

export interface LocationChoiceInput {
  optionId?: string
  inviteePhone?: string
}

/** Facts supplied by the booking transaction, after host assignment and connection checks. */
export interface LocationChoiceContext {
  schedulingType: 'individual' | 'collective' | 'round_robin'
  hostUserIds: readonly string[]
  assignedHostUserId?: string
  conferenceOrganizerUserId?: string | null
  meetReadyHostUserIds?: readonly string[]
  zoomReadyHostUserIds?: readonly string[]
}

export interface ResolvedLocationChoice {
  locationOption: LocationOption | null
  location: EventTypeLocation | null
}

function unavailable(): never {
  throw new DomainError(
    'conflict',
    'location_unavailable',
    'The chosen location is unavailable for the assigned host.',
  )
}

/** Pure selection/snapshot step. Provider work and booking persistence happen in the caller. */
export function resolveLocationChoice(
  locations: readonly LocationOption[] | null,
  input: LocationChoiceInput,
  context: LocationChoiceContext,
): ResolvedLocationChoice {
  const options = validateLocationOptions(locations)
  const option =
    input.optionId === undefined
      ? (options?.find((item) => item.isDefault === true) ?? options?.[0])
      : options?.find((item) => item.id === input.optionId)
  if (input.optionId !== undefined && !option)
    throw new DomainError(
      'invalid',
      'invalid_location_choice',
      'Choose one of the available locations.',
    )
  if (!option) return { locationOption: null, location: null }
  const settings = settingsOf(option)
  if (settings.kind === 'phone' && 'askInvitee' in settings) {
    if (typeof input.inviteePhone !== 'string' || !PHONE_NUMBER.test(input.inviteePhone))
      throw new DomainError(
        'invalid',
        'invalid_invitee_phone',
        'Provide a phone number in E.164 format.',
      )
    return { locationOption: option, location: { kind: 'phone', number: input.inviteePhone } }
  }
  if (
    (settings.kind === 'google_meet' || settings.kind === 'zoom') &&
    settings.autoCreate === true
  ) {
    const { schedulingType: mode, hostUserIds: hosts } = context
    if (mode !== 'collective' && context.conferenceOrganizerUserId != null) return unavailable()
    let organizer: string | undefined
    if (mode === 'collective') {
      organizer = context.conferenceOrganizerUserId ?? undefined
    } else if (mode === 'round_robin') {
      organizer = context.assignedHostUserId
    } else {
      if (hosts.length !== 1) return unavailable()
      organizer = context.assignedHostUserId ?? hosts[0]
    }
    if (!organizer || !hosts.includes(organizer)) return unavailable()
    if (settings.kind === 'zoom') {
      if (
        mode !== 'individual' ||
        hosts.length !== 1 ||
        !context.zoomReadyHostUserIds?.includes(organizer)
      )
        return unavailable()
    } else if (!context.meetReadyHostUserIds?.includes(organizer)) {
      return unavailable()
    }
  }
  return { locationOption: option, location: settings }
}
