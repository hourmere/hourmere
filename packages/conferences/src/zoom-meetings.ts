import { zoomJoinUrl, zoomMeetingId } from '@hourmere/scheduling/conference-url'
import { isSingleLineText } from '@hourmere/scheduling/text'
import { z } from 'zod'
import { boundedZoomJson, ZOOM_NOT_FOUND, ZoomError } from './transport.ts'

export { zoomJoinUrl, zoomMeetingId } from '@hourmere/scheduling/conference-url'
export interface ZoomMeetingInput {
  topic: string
  start: Date
  end: Date
}
export interface ZoomMeeting {
  id: string
  hostId: string
  joinUrl: string | null
  start: string | null
  duration: number | null
}
const host = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const responseSchema = z.object({
  id: z.unknown(),
  host_id: host,
  type: z.literal(2),
  join_url: z.unknown().optional(),
  start_time: z.unknown().optional(),
  duration: z.unknown().optional(),
  settings: z.object({ use_pmi: z.boolean().optional() }).optional(),
})
function payload(input: ZoomMeetingInput) {
  const start = input.start.getTime(),
    duration = (input.end.getTime() - start) / 60000
  if (
    !input.topic ||
    Array.from(input.topic).length > 200 ||
    !isSingleLineText(input.topic) ||
    !Number.isFinite(start) ||
    start <= 0 ||
    start % 1000 !== 0 ||
    !Number.isInteger(duration) ||
    duration < 1 ||
    duration > 1440
  )
    throw new ZoomError('provider_unavailable')
  return {
    topic: input.topic,
    start_time: input.start.toISOString().replace('.000Z', 'Z'),
    duration,
    timezone: 'UTC',
  }
}
function parse(value: unknown, expectedHost: string, expectedId?: string): ZoomMeeting {
  const parsed = responseSchema.safeParse(value)
  if (!parsed.success) throw new ZoomError('provider_unavailable')
  const result = parsed.data,
    id = zoomMeetingId(result.id)
  if (
    !id ||
    result.host_id !== expectedHost ||
    (expectedId !== undefined && id !== expectedId) ||
    result.settings?.use_pmi === true
  )
    throw new ZoomError('provider_unavailable')
  // Once identity is validated, retain it even when details are unusable. A worker can
  // reconcile/clean up that same ID; malformed details must not license another POST.
  const rawStart = result.start_time,
    time =
      typeof rawStart === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(rawStart)
        ? Date.parse(rawStart)
        : Number.NaN
  return {
    id,
    hostId: result.host_id,
    joinUrl: zoomJoinUrl(result.join_url, id),
    start:
      Number.isFinite(time) &&
      new Date(time).toISOString().replace('.000Z', 'Z') === String(rawStart).replace('.000Z', 'Z')
        ? new Date(time).toISOString()
        : null,
    duration:
      typeof result.duration === 'number' &&
      Number.isInteger(result.duration) &&
      result.duration >= 1 &&
      result.duration <= 1440
        ? result.duration
        : null,
  }
}
/** No POST retry, list inference, arbitrary URL adoption, host links or provider raw data. */
export function createZoomMeetingsClient(request: typeof fetch = fetch) {
  const endpoint = 'https://api.zoom.us/v2'
  async function call(
    access: string,
    path: string,
    method: string,
    signal: AbortSignal,
    body?: object,
    missing = false,
  ) {
    return boundedZoomJson(
      request,
      `${endpoint}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${access}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      signal,
      { missing, empty: method === 'PATCH' || method === 'DELETE' },
    )
  }
  async function get(
    access: string,
    expectedHost: string,
    id: string,
    signal: AbortSignal,
  ): Promise<ZoomMeeting | null> {
    if (zoomMeetingId(id) !== id || !host.safeParse(expectedHost).success)
      throw new ZoomError('provider_unavailable')
    const value = await call(access, `/meetings/${id}`, 'GET', signal, undefined, true)
    return value === ZOOM_NOT_FOUND ? null : parse(value, expectedHost, id)
  }
  return {
    async create(
      access: string,
      expectedHost: string,
      input: ZoomMeetingInput,
      signal: AbortSignal,
    ) {
      if (!host.safeParse(expectedHost).success) throw new ZoomError('provider_unavailable')
      const body = {
        ...payload(input),
        type: 2,
        default_password: true,
        settings: { use_pmi: false },
      }
      return parse(await call(access, '/users/me/meetings', 'POST', signal, body), expectedHost)
    },
    get,
    async update(
      access: string,
      expectedHost: string,
      id: string,
      input: ZoomMeetingInput,
      signal: AbortSignal,
    ) {
      const body = payload(input),
        existing = await get(access, expectedHost, id, signal)
      if (!existing) return null
      await call(access, `/meetings/${id}`, 'PATCH', signal, body)
      return get(access, expectedHost, id, signal)
    },
    async remove(access: string, expectedHost: string, id: string, signal: AbortSignal) {
      if (!(await get(access, expectedHost, id, signal))) return
      await call(access, `/meetings/${id}`, 'DELETE', signal, undefined, true)
    },
  }
}
export type ZoomMeetingsClient = ReturnType<typeof createZoomMeetingsClient>
