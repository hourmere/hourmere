import { describe, expect, it } from 'vitest'
import { openApiDocument } from './openapi-document.ts'

describe('openApiDocument', () => {
  it("lists every route group's paths, without a database", async () => {
    const doc = (await openApiDocument()) as { openapi: string; paths: Record<string, unknown> }
    expect(doc.openapi).toBe('3.1.0')
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/health',
        '/api/v1/me',
        '/api/v1/readiness/self',
        '/api/v1/teams/{teamId}/readiness',
        '/api/v1/instance',
        '/api/v1/profile',
        '/api/v1/schedules',
        '/api/v1/event-types',
        '/api/v1/public/{handle}/{slug}',
        '/api/v1/bookings',
        '/api/v1/calendar-connections',
        '/api/v1/calendar-connections/google/authorize',
      ]),
    )
  })
})
