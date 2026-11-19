export const PUBLIC_ROUTING_FORM_API_PREFIX = '/api/v1/public/-/routing'

/** Cover encoded addresses and refused requests without changing request routing. */
function decodedPath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

export function isPublicRoutingFormPath(path: string): boolean {
  const normalized = decodedPath(path).toLowerCase()
  return (
    normalized === PUBLIC_ROUTING_FORM_API_PREFIX ||
    normalized.startsWith(`${PUBLIC_ROUTING_FORM_API_PREFIX}/`)
  )
}

export function isPublicRoutingFormPage(path: string): boolean {
  // The web router decodes each segment without turning encoded slashes into separators.
  let normalized = path
  try {
    normalized = path
      .split('/')
      .map((segment) => decodeURIComponent(segment).replaceAll('/', '%2F'))
      .join('/')
  } catch {}
  return /^\/route\/(?:team\/[^/]+|[^/]+)\/[^/]+\/*$/i.test(normalized)
}
