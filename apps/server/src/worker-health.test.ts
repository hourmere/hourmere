import { describe, expect, it } from 'vitest'
import { createWorkerHealthApp } from './worker-health.ts'

const ok = async () => {}
const down = async () => {
  throw new Error('connection refused')
}

async function health(deps: Parameters<typeof createWorkerHealthApp>[0], path = '/api/health') {
  const res = await createWorkerHealthApp(deps).request(path)
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() }
}

describe('createWorkerHealthApp', () => {
  it('is healthy while the database answers and the workers run', async () => {
    expect(await health({ checkDb: ok, checkJobs: ok })).toEqual({
      status: 200,
      cache: 'no-store',
      body: { status: 'ok', database: 'ok', jobs: 'running' },
    })
  })

  it('answers 503 when the database is unreachable', async () => {
    expect(await health({ checkDb: down, checkJobs: ok })).toMatchObject({
      status: 503,
      body: { status: 'degraded', database: 'unreachable', jobs: 'running' },
    })
  })

  it('answers 503 when the workers have stopped or their pool does not answer', async () => {
    expect(await health({ checkDb: ok, checkJobs: down })).toMatchObject({
      status: 503,
      body: { status: 'degraded', database: 'ok', jobs: 'unavailable' },
    })
  })

  it('serves nothing else', async () => {
    for (const path of ['/', '/api/v1/openapi.json', '/api/health/x']) {
      expect(await health({ checkDb: ok, checkJobs: ok }, path)).toMatchObject({
        status: 404,
        cache: 'no-store',
        body: { error: 'not_found' },
      })
    }
  })
})
