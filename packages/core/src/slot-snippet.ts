import { interfaceLanguage } from './language.ts'
import { type InterfaceLanguage, localeRegistry } from './locales.ts'
import { isPublicTeamSlug, isReservedName } from './reserved.ts'

export const SLOT_SNIPPET_LIMITS = {
  maxSlots: 10,
  maxPlainTextUtf8Bytes: 32768,
  maxHtmlUtf8Bytes: 65536,
  maxUrlUtf8Bytes: 2048,
} as const

export type SlotSnippetAddress =
  | { kind: 'personal'; handle: string; slug: string }
  | { kind: 'team'; teamSlug: string; slug: string }

export type SlotSnippetInput = {
  /** The instance's configured PUBLIC_URL, never a request origin. */
  publicUrl: string
  /** The saved reusable public address, never an editor draft or capability projection. */
  address: SlotSnippetAddress
  title: string
  durationMinutes: number
  starts: readonly string[]
  locale: InterfaceLanguage
  displayTimeZone: string
}

export type SlotSnippet = {
  bookingUrl: string
  durationMinutes: number
  locale: InterfaceLanguage
  displayTimeZone: string
  slots: { start: string; end: string; label: string; url: string }[]
  text: string
  html: string
}

export type SlotSnippetErrorCode =
  | 'invalid_input'
  | 'invalid_address'
  | 'invalid_title'
  | 'invalid_duration'
  | 'invalid_slots'
  | 'invalid_locale'
  | 'invalid_time_zone'
  | 'snippet_too_large'

/** Safe fixed codes only: callers must not log or echo raw snippet input. */
export class SlotSnippetError extends Error {
  readonly code: SlotSnippetErrorCode

  constructor(code: SlotSnippetErrorCode) {
    super(code)
    this.name = 'SlotSnippetError'
    this.code = code
  }
}

export const slotSnippetTemplates = {
  en: {
    heading: 'Available times for {title} ({duration})',
    notice: 'These times are not reserved. Choose a time and confirm your booking.',
  },
  'zh-CN': {
    heading: '「{title}」的可预约时间（{duration}）',
    notice: '这些时间尚未预留。请选择一个时间，并确认预约。',
  },
  de: {
    heading: 'Verfügbare Termine für {title} ({duration})',
    notice:
      'Diese Termine sind nicht reserviert. Wählen Sie einen Termin und bestätigen Sie Ihre Buchung.',
  },
  fr: {
    heading: 'Créneaux disponibles pour {title} ({duration})',
    notice:
      'Ces créneaux ne sont pas réservés. Choisissez un créneau et confirmez votre réservation.',
  },
  es: {
    heading: 'Horarios disponibles para {title} ({duration})',
    notice: 'Estos horarios no están reservados. Elija uno y confirme su reserva.',
  },
  'pt-BR': {
    heading: 'Horários disponíveis para {title} ({duration})',
    notice: 'Estes horários não estão reservados. Escolha um horário e confirme sua reserva.',
  },
} as const satisfies Record<InterfaceLanguage, { heading: string; notice: string }>

/** Profile preferences are mapped through the public registry; explicit overrides are stricter. */
export function resolveSnippetLocale(profileLocale: unknown): InterfaceLanguage {
  return interfaceLanguage(profileLocale) ?? 'en'
}

function snippetLocale(value: unknown): InterfaceLanguage {
  if (typeof value !== 'string' || !Object.hasOwn(localeRegistry, value))
    throw new SlotSnippetError('invalid_locale')
  return value as InterfaceLanguage
}

function snippetTimeZone(value: unknown): string {
  // Abbreviations and numeric offsets are ambiguous; accept a named identifier or UTC.
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !(value.toUpperCase() === 'UTC' || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))
  )
    throw new SlotSnippetError('invalid_time_zone')
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    throw new SlotSnippetError('invalid_time_zone')
  }
}

export function resolveSnippetTimeZone(profileTimeZone: unknown): string {
  try {
    return snippetTimeZone(profileTimeZone)
  } catch {
    return 'UTC'
  }
}

const INSTANT =
  /^(?!0000)\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/

function instant(value: unknown): Date {
  if (typeof value !== 'string' || !INSTANT.test(value)) throw new SlotSnippetError('invalid_slots')
  try {
    const [dateTime, offset = 'Z'] = value.split(/(?=Z|[+-]\d{2}:\d{2}$)/)
    const [year, month, day, hour, minute, second, fraction = ''] = (dateTime ?? '').split(/[-T:.]/)
    const components = [year, month, day, hour, minute, second].map(Number)
    const [y = 0, m = 0, d = 0, h = 0, min = 0, sec = 0] = components
    // UTC setters avoid Date.UTC's special interpretation of years 00–99.
    const local = new Date(0)
    local.setUTCFullYear(y, m - 1, d)
    local.setUTCHours(h, min, sec, Number(fraction.padEnd(3, '0')))
    if (local.getUTCFullYear() !== y || local.getUTCMonth() !== m - 1 || local.getUTCDate() !== d)
      throw new Error()
    const offsetMinutes =
      offset === 'Z'
        ? 0
        : (offset.startsWith('-') ? -1 : 1) *
          (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)))
    const parsed = new Date(local.getTime() - offsetMinutes * 60000)
    iso(parsed)
    return parsed
  } catch {
    throw new SlotSnippetError('invalid_slots')
  }
}

function iso(value: Date): string {
  const result = value.toISOString()
  if (!/^(?!0000)\d{4}-/.test(result)) throw new SlotSnippetError('invalid_slots')
  return result
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function size(value: string, maximum: number): string {
  if (utf8Bytes(value) > maximum) throw new SlotSnippetError('snippet_too_large')
  return value
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** Build only an ordinary canonical personal/team address; no capability routes or query input. */
export function buildSlotSnippetBookingUrl(publicUrl: string, address: SlotSnippetAddress): string {
  let origin: URL
  try {
    origin = new URL(publicUrl)
  } catch {
    throw new SlotSnippetError('invalid_address')
  }
  if (
    typeof publicUrl !== 'string' ||
    /[\s\\]/.test(publicUrl) ||
    !['https:', 'http:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !address ||
    typeof address !== 'object' ||
    typeof address.slug !== 'string' ||
    !SLUG.test(address.slug)
  )
    throw new SlotSnippetError('invalid_address')
  let parts: string[]
  if (
    address.kind === 'personal' &&
    exactKeys(address, ['kind', 'handle', 'slug']) &&
    typeof address.handle === 'string' &&
    HANDLE.test(address.handle) &&
    !isReservedName(address.handle)
  ) {
    parts = [address.handle, address.slug]
  } else if (
    address.kind === 'team' &&
    exactKeys(address, ['kind', 'teamSlug', 'slug']) &&
    typeof address.teamSlug === 'string' &&
    isPublicTeamSlug(address.teamSlug)
  ) {
    // Team slugs retain their saved case, matching the current public namespace.
    parts = ['team', address.teamSlug, address.slug]
  } else {
    throw new SlotSnippetError('invalid_address')
  }
  return size(
    new URL(`/${parts.map((part) => encodeURIComponent(part)).join('/')}`, origin.origin).href,
    SLOT_SNIPPET_LIMITS.maxUrlUtf8Bytes,
  )
}

/** Only a normalized absolute instant and explicit elapsed length enter the URL. */
export function buildSlotSnippetLink(
  publicUrl: string,
  address: SlotSnippetAddress,
  start: string,
  durationMinutes: number,
): string {
  duration(durationMinutes)
  const parsed = instant(start)
  iso(new Date(parsed.getTime() + durationMinutes * 60000))
  const url = new URL(buildSlotSnippetBookingUrl(publicUrl, address))
  url.searchParams.set('start', iso(parsed))
  url.searchParams.set('durationMinutes', String(durationMinutes))
  return size(url.href, SLOT_SNIPPET_LIMITS.maxUrlUtf8Bytes)
}

function duration(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 1440)
    throw new SlotSnippetError('invalid_duration')
}

const FORBIDDEN_CONTROLS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove unsafe plain-text controls
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

function normalizeTitle(value: string): string {
  if (typeof value !== 'string' || !value.isWellFormed())
    throw new SlotSnippetError('invalid_title')
  const title = value
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(FORBIDDEN_CONTROLS, '')
    .trim()
  if (!title || title.length > 200) throw new SlotSnippetError('invalid_title')
  return title
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? ''
  })
}

/** Full human-readable interval, using each endpoint's own local date and offset. */
export function formatSlotLabel(
  start: string,
  end: string,
  locale: InterfaceLanguage,
  displayTimeZone: string,
): string {
  const language = snippetLocale(locale)
  const zone = snippetTimeZone(displayTimeZone)
  const first = instant(start)
  const last = instant(end)
  if (first.getTime() >= last.getTime()) throw new SlotSnippetError('invalid_slots')
  const options = { timeZone: zone, calendar: 'gregory' } as const
  const formattingLocale = localeRegistry[language].formatLocale
  const dateFormat = new Intl.DateTimeFormat(formattingLocale, {
    ...options,
    weekday: 'short',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const timeFormat = new Intl.DateTimeFormat(formattingLocale, {
    ...options,
    hour: 'numeric',
    minute: '2-digit',
  })
  const startDate = dateFormat.format(first.getTime())
  const endDate = dateFormat.format(last.getTime())
  const startTime = timeFormat.format(first.getTime())
  const endTime = timeFormat.format(last.getTime())
  const offsetFormat = new Intl.DateTimeFormat('en', {
    ...options,
    timeZoneName: 'longOffset',
  })
  const offset = (date: Date) => {
    const name = offsetFormat
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value
    return name === 'GMT' ? 'UTC+00:00' : (name ?? '').replace('GMT', 'UTC')
  }
  const startOffset = offset(first)
  const endOffset = offset(last)
  const datesDiffer = startDate !== endDate
  const offsetsDiffer = startOffset !== endOffset
  if (offsetsDiffer) {
    return `${startDate}, ${startTime} (${startOffset}) – ${datesDiffer ? `${endDate}, ` : ''}${endTime} (${endOffset}) [${zone}]`
  }
  return `${startDate}, ${startTime} – ${datesDiffer ? `${endDate}, ` : ''}${endTime} [${zone}, ${startOffset}]`
}

/** Pure rendering only. Callers must authorize and recheck every exact interval before copying. */
export function formatSlotSnippet(input: SlotSnippetInput): SlotSnippet {
  if (
    !input ||
    typeof input !== 'object' ||
    !exactKeys(input, [
      'publicUrl',
      'address',
      'title',
      'durationMinutes',
      'starts',
      'locale',
      'displayTimeZone',
    ])
  )
    throw new SlotSnippetError('invalid_input')
  const locale = snippetLocale(input.locale)
  const displayTimeZone = snippetTimeZone(input.displayTimeZone)
  duration(input.durationMinutes)
  const title = normalizeTitle(input.title)
  if (
    !Array.isArray(input.starts) ||
    input.starts.length < 1 ||
    input.starts.length > SLOT_SNIPPET_LIMITS.maxSlots
  )
    throw new SlotSnippetError('invalid_slots')
  const starts = input.starts
    .map((start) => instant(start))
    .sort((a, b) => a.getTime() - b.getTime())
  if (new Set(starts.map((start) => iso(start))).size !== starts.length)
    throw new SlotSnippetError('invalid_slots')
  const bookingUrl = buildSlotSnippetBookingUrl(input.publicUrl, input.address)
  const slots = starts.map((value) => {
    const start = iso(value)
    const end = iso(new Date(value.getTime() + input.durationMinutes * 60000))
    return {
      start,
      end,
      label: formatSlotLabel(start, end, locale, displayTimeZone),
      url: buildSlotSnippetLink(input.publicUrl, input.address, start, input.durationMinutes),
    }
  })
  const template = slotSnippetTemplates[locale]
  // A single replacement pass leaves any placeholder-like title text untouched.
  const durationLabel = new Intl.NumberFormat(localeRegistry[locale].formatLocale, {
    style: 'unit',
    unit: 'minute',
    unitDisplay: 'long',
  }).format(input.durationMinutes)
  const heading = template.heading.replace(/\{(title|duration)\}/g, (_, key: string) =>
    key === 'title' ? title : durationLabel,
  )
  const text = size(
    `${heading}\n\n${slots.map((slot) => `${slot.label}\n${slot.url}`).join('\n\n')}\n\n${template.notice}`,
    SLOT_SNIPPET_LIMITS.maxPlainTextUtf8Bytes,
  )
  const html = size(
    `<div lang="${escapeHtml(locale)}"><p>${escapeHtml(heading)}</p><ul>${slots.map((slot) => `<li><a href="${escapeHtml(slot.url)}" rel="noopener noreferrer">${escapeHtml(slot.label)}</a></li>`).join('')}</ul><p>${escapeHtml(template.notice)}</p></div>`,
    SLOT_SNIPPET_LIMITS.maxHtmlUtf8Bytes,
  )
  return {
    bookingUrl,
    durationMinutes: input.durationMinutes,
    locale,
    displayTimeZone,
    slots,
    text,
    html,
  }
}
