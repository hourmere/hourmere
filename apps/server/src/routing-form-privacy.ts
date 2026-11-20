const privateRoutingApiPrefixes = ['/api/v1/public/-/routing', '/api/v1/routing-continuations']

/** Cover encoded addresses and refused requests without changing request routing. */
function decodedPath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

export function isPublicRoutingFormPath(path: string): boolean {
  return privateRoutingApiPrefix(path) !== undefined
}

export function privateRoutingApiPrefix(path: string): string | undefined {
  const normalized = decodedPath(path).toLowerCase()
  return privateRoutingApiPrefixes.find(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
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
