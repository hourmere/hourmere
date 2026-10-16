import { Hono } from 'hono'

export interface WorkerHealthDeps {
  /** Resolves when the database answers; rejects otherwise. */
  checkDb: () => Promise<void>
  /** Whether the job workers are running (false once shutdown has begun). */
  jobsRunning: () => boolean
}

/**
 * All a worker (HOURMERE_ROLE=worker) serves: GET /api/health, so the image's HEALTHCHECK
 * and orchestrators probe every role the same way. Healthy means the database answers and
 * the workers are taking jobs. Everything else is a 404; nothing else is exposed.
 */
export function createWorkerHealthApp({ checkDb, jobsRunning }: WorkerHealthDeps) {
  const app = new Hono()
  app.use(async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })
  app.get('/api/health', async (c) => {
    const database = await checkDb().then(
      () => 'ok' as const,
      () => 'unreachable' as const,
    )
    const jobs = jobsRunning() ? ('running' as const) : ('stopped' as const)
    const ok = database === 'ok' && jobs === 'running'
    return c.json({ status: ok ? 'ok' : 'degraded', database, jobs }, ok ? 200 : 503)
  })
  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  app.onError((_err, c) => c.json({ error: 'internal_error' }, 500))
  return app
}
