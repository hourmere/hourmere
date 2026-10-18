// The public API calls behind the booking and manage pages (docs/api-conventions.md, "Public
// endpoints"), through the same typed client as the rest of the app. No credentials: the manage
// token travels in the X-Manage-Token header, never in a URL.
import { api, type Schemas } from '../api/client.ts'
import { errorMessage, RequestError, requestError, UNREACHABLE } from '../api/errors.ts'
import { msg, type UiText } from '../i18n/translate.ts'

export type PublicHost = Schemas['PublicHost']
export type PublicEventType = Schemas['PublicEventType']
export type Slot = Schemas['Slot']
export type Booking = Schemas['Booking']
export type ManagedBooking = Schemas['ManagedBooking']
export type BookingWithToken = Schemas['BookingWithToken']
export type CreateBooking = Schemas['CreateBooking']

/** A request the server refused; `retryAfter` (seconds) comes with 429. */
export class PublicRequestError extends RequestError {
  readonly retryAfter: number | undefined

  constructor(base: RequestError, retryAfter: number | undefined) {
    super(base.status, base.code, base.message, base.displayMessage)
    this.name = 'PublicRequestError'
    this.retryAfter = retryAfter
  }
}

/** The server could not be reached (or answered with something that is not HTTP). */
export class NetworkError extends Error {
  constructor() {
    super(UNREACHABLE)
    this.name = 'NetworkError'
  }
}

function retryAfterOf(response: Response): number | undefined {
  const value = Number(response.headers.get('Retry-After'))
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined
}

/** The data of a call; throws PublicRequestError for an error status, NetworkError offline. */
async function call<T>(
  request: () => Promise<{ data?: T; error?: unknown; response: Response }>,
  signal?: AbortSignal,
): Promise<{ data: T; status: number }> {
  let result: { data?: T; error?: unknown; response: Response }
  try {
    result = await request()
  } catch (err) {
    if (signal?.aborted) throw err
    throw new NetworkError()
  }
  const { data, error, response } = result
  if (!response.ok) {
    throw new PublicRequestError(requestError(response.status, error), retryAfterOf(response))
  }
  return { data: data as T, status: response.status }
}

/** What to tell people about a failed request on a public page. */
export function failureMessage(err: unknown): UiText {
  if (err instanceof PublicRequestError && err.status === 429) {
    return err.retryAfter
      ? msg('Too many requests from your network. Try again in {0} seconds.', {
          '0': err.retryAfter,
        })
      : 'Too many requests from your network. Wait a minute and try again.'
  }
  return errorMessage(err)
}

export const codeOf = (err: unknown) => (err instanceof RequestError ? err.code : undefined)

export async function getHost(handle: string, signal: AbortSignal): Promise<PublicHost> {
  const { data } = await call(
    () => api.GET('/api/v1/public/{handle}', { params: { path: { handle } }, signal }),
    signal,
  )
  return data
}

export async function getEventType(
  handle: string,
  slug: string,
  signal: AbortSignal,
  team = false,
): Promise<PublicEventType> {
  const { data } = await call(
    () =>
      team
        ? api.GET('/api/v1/public/teams/{handle}/{slug}', {
            params: { path: { handle, slug } },
            signal,
          })
        : api.GET('/api/v1/public/{handle}/{slug}', { params: { path: { handle, slug } }, signal }),
    signal,
  )
  return data
}

/** Loads the slots that lie fully inside [start, end] (ISO instants). */
export type SlotLoader = (start: string, end: string, signal: AbortSignal) => Promise<Slot[]>

export function eventSlots(handle: string, slug: string, team = false): SlotLoader {
  return async (start, end, signal) => {
    const { data } = await call(
      () =>
        team
          ? api.GET('/api/v1/public/teams/{handle}/{slug}/slots', {
              params: { path: { handle, slug }, query: { start, end } },
              signal,
            })
          : api.GET('/api/v1/public/{handle}/{slug}/slots', {
              params: { path: { handle, slug }, query: { start, end } },
              signal,
            }),
      signal,
    )
    return data.data
  }
}

export function rescheduleSlots(token: string): SlotLoader {
  return async (start, end, signal) => {
    const { data } = await call(
      () =>
        api.GET('/api/v1/bookings/manage/slots', {
          params: { header: { 'x-manage-token': token }, query: { start, end } },
          signal,
        }),
      signal,
    )
    return data.data
  }
}

/**
 * The slots in [start, end] (milliseconds). When the server finds the range too long for the
 * event type's step (`range_too_long`: very short steps), the range is split in halves that
 * overlap by `overlapMs` (the meeting's length), so no slot across the middle is lost.
 */
export async function loadSlotsInRange(
  load: SlotLoader,
  start: number,
  end: number,
  overlapMs: number,
  signal: AbortSignal,
  depth = 0,
): Promise<Slot[]> {
  try {
    return await load(new Date(start).toISOString(), new Date(end).toISOString(), signal)
  } catch (err) {
    if (codeOf(err) !== 'range_too_long' || depth >= 4 || end - start <= 2 * overlapMs) throw err
    const middle = start + Math.floor((end - start) / 2 / 60_000) * 60_000
    const [first, second] = [
      await loadSlotsInRange(load, start, middle, overlapMs, signal, depth + 1),
      await loadSlotsInRange(load, middle - overlapMs, end, overlapMs, signal, depth + 1),
    ]
    const byStart = new Map<string, Slot>()
    for (const slot of [...first, ...second]) byStart.set(slot.start, slot)
    return [...byStart.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
  }
}

export async function createBooking(
  handle: string,
  slug: string,
  body: CreateBooking,
  idempotencyKey: string,
  team = false,
): Promise<{ result: BookingWithToken; replayed: boolean }> {
  const { data, status } = await call(() =>
    team
      ? api.POST('/api/v1/public/teams/{handle}/{slug}/bookings', {
          params: { path: { handle, slug }, header: { 'idempotency-key': idempotencyKey } },
          body,
        })
      : api.POST('/api/v1/public/{handle}/{slug}/bookings', {
          params: { path: { handle, slug }, header: { 'idempotency-key': idempotencyKey } },
          body,
        }),
  )
  return { result: data, replayed: status === 200 }
}

export async function getManagedBooking(
  token: string,
  signal?: AbortSignal,
): Promise<ManagedBooking> {
  const { data } = await call(
    () =>
      api.GET('/api/v1/bookings/manage', {
        params: { header: { 'x-manage-token': token } },
        ...(signal && { signal }),
      }),
    signal,
  )
  return data
}

export async function cancelManagedBooking(token: string, reason: string): Promise<Booking> {
  const { data } = await call(() =>
    api.POST('/api/v1/bookings/manage/cancel', {
      params: { header: { 'x-manage-token': token } },
      body: reason ? { reason } : {},
    }),
  )
  return data
}

export async function rescheduleManagedBooking(
  token: string,
  start: string,
): Promise<BookingWithToken> {
  const { data } = await call(() =>
    api.POST('/api/v1/bookings/manage/reschedule', {
      params: { header: { 'x-manage-token': token } },
      body: { start },
    }),
  )
  return data
}

/**
 * A random Idempotency-Key (a UUIDv4). crypto.getRandomValues works on plain http too, where
 * crypto.randomUUID is missing (a self-hosted instance on a local network).
 */
export function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
