export const PUBLIC_ROUTING_FORM_API_PREFIX = '/api/v1/public/-/routing'

/** Cover encoded addresses and refused requests without changing request routing. */
export function isPublicRoutingFormPath(path: string): boolean {
  try {
    path = decodeURIComponent(path)
  } catch {}
  const normalized = path.toLowerCase()
  return (
    normalized === PUBLIC_ROUTING_FORM_API_PREFIX ||
    normalized.startsWith(`${PUBLIC_ROUTING_FORM_API_PREFIX}/`)
  )
}
