import { Hono } from 'hono'
import { securityHeaders } from './security-headers.ts'

export interface WorkerHealthDeps {
  /** Resolves when the database answers; rejects otherwise. */
  checkDb: () => Promise<void>
  /** Resolves while the job workers run and pg-boss's pool answers; rejects otherwise. */
  checkJobs: () => Promise<void>
}

/**
 * All a worker (HOURMERE_ROLE=worker) serves: GET /api/health, so the image's HEALTHCHECK
 * and orchestrators probe every role the same way. Healthy means the database answers and
 * the workers are taking jobs (stopping counts as unhealthy). Everything else is a 404.
 */
export function createWorkerHealthApp({ checkDb, checkJobs }: WorkerHealthDeps) {
  const app = new Hono()
  // The same headers as the web role's (no HSTS: nothing but health checks reaches a worker).
  app.use(securityHeaders())
  app.use(async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })
  app.get('/api/health', async (c) => {
    const [database, jobs] = await Promise.all([
      checkDb().then(
        () => 'ok' as const,
        () => 'unreachable' as const,
      ),
      checkJobs().then(
        () => 'running' as const,
        () => 'unavailable' as const,
      ),
    ])
    const ok = database === 'ok' && jobs === 'running'
    return c.json({ status: ok ? 'ok' : 'degraded', database, jobs }, ok ? 200 : 503)
  })
  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  app.onError((_err, c) => c.json({ error: 'internal_error' }, 500))
  return app
}
