const privateRoutingApiPrefixes = ['/api/v1/public/-/routing', '/api/v1/routing-continuations']

export const hasRouteToken = (args: unknown) =>
  typeof args === 'object' && args !== null && 'routeToken' in args

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

function decodedPage(path: string): string {
  // The web router decodes each segment without turning encoded slashes into separators.
  try {
    return path
      .split('/')
      .map((segment) => decodeURIComponent(segment).replaceAll('/', '%2F'))
      .join('/')
  } catch {
    return path
  }
}

export function isPublicRoutingContinuationPage(path: string): boolean {
  return /^\/route\/continue\/*$/i.test(decodedPage(path))
}

export function isPublicRoutingFormPage(path: string): boolean {
  return /^\/route\/(?:team\/[^/]+|[^/]+)\/[^/]+\/*$/i.test(decodedPage(path))
}
