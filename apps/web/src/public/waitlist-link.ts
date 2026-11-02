import type { Slot, SlotLoader } from './api.ts'

export interface WaitlistLink {
  token: string
  start: string
  expiresAt: number
}

export function parseWaitlistLink(
  token: unknown,
  start: unknown,
  expiresAt: unknown,
): WaitlistLink | undefined {
  if (
    typeof token !== 'string' ||
    !/^[a-f\d-]{36}\.[A-Za-z0-9_-]{43}$/.test(token) ||
    typeof start !== 'string'
  )
    return undefined
  const at = Date.parse(start)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(start) || !Number.isFinite(at))
    return undefined
  if (
    typeof expiresAt !== 'string' ||
    !/^\d{1,16}$/.test(expiresAt) ||
    !Number.isSafeInteger(Number(expiresAt))
  )
    return undefined
  return { token, start: new Date(at).toISOString(), expiresAt: Number(expiresAt) }
}

/** A mail suggestion opens a form only for the exact interval the ordinary engine offers. */
export async function loadWaitlistSuggestion(
  load: SlotLoader,
  start: string,
  durationMinutes: number,
  signal: AbortSignal,
): Promise<Slot | undefined> {
  const at = Date.parse(start)
  const end = new Date(at + durationMinutes * 60_000).toISOString()
  const slots = await load(start, end, signal)
  return slots.find(
    (candidate) =>
      Date.parse(candidate.start) === at && Date.parse(candidate.end) === Date.parse(end),
  )
}

/** Presentation only; notification expiry never grants or removes ordinary booking permission. */
export function waitlistPreviewActive(link: WaitlistLink, now: number): boolean {
  return now < link.expiresAt
}
