interface RegisteredRoute {
  method: string
  path: string
}

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const

/** Hono registers each middleware separately and uses :id where OpenAPI uses {id}. */
export function undocumentedWriteRoutes(
  routes: readonly RegisteredRoute[],
  document: { paths: Record<string, Record<string, unknown>> },
): string[] {
  const missing = new Set<string>()
  for (const { method, path } of routes) {
    if (!WRITE_METHODS.some((write) => write === method)) continue
    if (path !== '/api/v1' && !path.startsWith('/api/v1/')) continue
    const openApiPath = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    if (!Object.hasOwn(document.paths[openApiPath] ?? {}, method.toLowerCase())) {
      missing.add(`${method} ${path}: register every /api/v1 write with app.openapi().`)
    }
  }
  return [...missing].sort()
}
