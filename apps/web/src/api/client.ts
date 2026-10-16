// The product API (/api/v1), typed from the server's OpenAPI document: `npm run api:types`
// regenerates schema.d.ts after a route changes.
import createClient, { type Middleware } from 'openapi-fetch'
import { requestError } from './errors.ts'
import type { components, paths } from './schema.d.ts'

export type Schemas = components['schemas']

let unauthorizedHandler: () => void = () => {}

/**
 * Registers what happens when the server says nobody is signed in (401), e.g. a session
 * that expired while the app was open. Returns a function that unregisters it.
 */
export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = () => {}
  }
}

export function notifyUnauthorized() {
  unauthorizedHandler()
}

const watchSession: Middleware = {
  onResponse({ response }) {
    if (response.status === 401) notifyUnauthorized()
  },
}

/**
 * `api.GET('/api/v1/me')` and so on: paths, parameters and bodies are checked against the
 * OpenAPI document. Requests are same-origin, so the session cookie goes along and writes
 * carry the app's Origin (the server's CSRF check).
 */
export const api = createClient<paths>({
  baseUrl: window.location.origin,
  // Looked up on every request rather than captured once, so tests can replace it.
  fetch: (request) => globalThis.fetch(request),
})
api.use(watchSession)

/** The data of a successful openapi-fetch call; throws a RequestError for an error status. */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call
  if (!response.ok) throw requestError(response.status, error)
  return data as T
}
