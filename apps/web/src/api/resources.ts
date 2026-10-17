// Loaders for the owner-side API (/api/v1) that several pages share.
import { api, type Schemas, unwrap } from './client.ts'
import { RequestError, requestError } from './errors.ts'

export type Profile = Schemas['Profile']
export type Schedule = Schemas['Schedule']
export type EventType = Schemas['EventType']
export type Booking = Schemas['Booking']

/** The caller's profile, or null before they have created one (404 profile_not_found). */
export async function loadProfile(signal: AbortSignal): Promise<Profile | null> {
  const { data, error, response } = await api.GET('/api/v1/profile', { signal })
  if (data) return data
  const err = requestError(response.status, error)
  if (err.status === 404 && err.code === 'profile_not_found') return null
  throw err
}

export async function loadSchedules(signal: AbortSignal): Promise<Schedule[]> {
  return (await unwrap(api.GET('/api/v1/schedules', { signal }))).data
}

export async function loadEventTypes(signal: AbortSignal): Promise<EventType[]> {
  return (await unwrap(api.GET('/api/v1/event-types', { signal }))).data
}

/** Whether `err` is the API's 404 with `code`, e.g. a record deleted meanwhile. */
export const isNotFound = (err: unknown, code: string) =>
  err instanceof RequestError && err.status === 404 && err.code === code

/** Updates only the caller's display name through the validated application API. */
export async function updateDisplayName(name: string) {
  return unwrap(api.PATCH('/api/v1/profile/name', { body: { name } }))
}
