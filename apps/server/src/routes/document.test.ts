import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import {
  openApiDocument,
  productApp,
  productRoutes,
  responseAndRequestStrictness,
} from './test-app.ts'

describe('the OpenAPI document', () => {
  it('documents every /api/v1 JSON response as open and every JSON request body as strict', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    const paths = Object.keys(doc.paths).filter((path) => path.startsWith('/api/v1/'))
    // Catalog and booking routes alike.
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/profile',
        '/api/v1/schedules/{id}/overrides/{date}',
        '/api/v1/event-types/{id}',
        '/api/v1/public/{handle}/{slug}',
        '/api/v1/bookings/{id}/cancel',
      ]),
    )
    expect(responseAndRequestStrictness(doc, paths)).toEqual({
      closedResponses: [],
      openRequests: [],
    })
  })

  it('names each component once: route modules can register in any order', async () => {
    // Two different schemas registered under one name would make the document depend on
    // which module registered last.
    const db = {} as Db
    const doc = await openApiDocument(productApp(db))
    const reversed = await openApiDocument(productApp(db, new Map(), productRoutes(db).reverse()))
    expect(reversed.components).toEqual(doc.components)
  })
})
