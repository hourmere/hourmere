import { randomUUID } from 'node:crypto'
import { type ListBookingsInput, MAX_PAGE_SIZE } from '@hourmere/scheduling'
import { describe, expect, it } from 'vitest'
import {
  type BulkPageBinding,
  BulkPreviewSelectionSchema,
  issueBulkPageProof,
  MAX_BULK_PAGE_TOKEN_LENGTH,
  verifyBulkPageSelection,
} from './team-booking-bulk-proof.ts'

const secret = 'test-only secret for a signed bulk page'
const binding = { userId: randomUUID(), sessionId: randomUUID(), organizationId: randomUUID() }
const issuedAt = new Date('2026-11-25T12:00:00Z')
const expiresAt = new Date('2026-11-25T12:10:00Z')
const first = randomUUID()
const second = randomUUID()
const bookingIds = [first, second, ...Array.from({ length: MAX_PAGE_SIZE - 2 }, () => randomUUID())]
const changed = expect.objectContaining({ kind: 'conflict', code: 'bulk_selection_changed' })

function issue(query: ListBookingsInput = {}) {
  return issueBulkPageProof(secret, binding, query, bookingIds, issuedAt)
}

function payload(query: ListBookingsInput, signingSecret = secret): { queryDigest: string } {
  const page = issueBulkPageProof(signingSecret, binding, query, bookingIds, issuedAt)
  const [encoded = ''] = page.bulkPageToken.split('.')
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
}

describe('team booking bulk page proof', () => {
  it('binds every ID on the maximum page and returns selected IDs in page order', () => {
    const page = issue()
    expect(page.bulkPageExpiresAt).toBe(expiresAt.toISOString())
    expect(page.bulkPageToken.length).toBeLessThanOrEqual(MAX_BULK_PAGE_TOKEN_LENGTH)

    const selected = bookingIds
      .slice(-25)
      .reverse()
      .map((id) => id.toUpperCase())
    expect(
      verifyBulkPageSelection(secret, binding, page.bulkPageToken, selected, issuedAt),
    ).toEqual({
      bookingIds: bookingIds.slice(-25),
      expiresAt,
    })
  })

  it('keeps the normalized page query and cursor in a keyed digest', () => {
    const q = 'invitee@example.test'
    const from = Temporal.Instant.from('2026-11-25T10:00:00Z')
    const cursor = Buffer.from(JSON.stringify(['2026-11-25T10:30:00Z', first])).toString(
      'base64url',
    )
    const sameCursor = Buffer.from(
      JSON.stringify(['2026-11-25T11:30:00+01:00', first.toUpperCase()]),
    ).toString('base64url')
    const query = { from, q, cursor }
    const data = payload(query)
    expect(data).toEqual({
      ...binding,
      bookingIds,
      expiresAt: expiresAt.getTime(),
      queryDigest: expect.stringMatching(/^[\w-]{43}$/),
    })
    expect(payload({ ...query, q: ` ${q} `, cursor: sameCursor, order: 'asc', limit: 50 })).toEqual(
      data,
    )
    expect(payload({ ...query, q: 'other@example.test' }).queryDigest).not.toBe(data.queryDigest)
    expect(payload({ ...query, order: 'desc' }).queryDigest).not.toBe(data.queryDigest)
    expect(payload({ from, q }).queryDigest).not.toBe(data.queryDigest)
    expect(payload(query, 'other test-only secret').queryDigest).not.toBe(data.queryDigest)
  })

  it('rejects the entire selection if a booking is absent from the proof', () => {
    const { bulkPageToken } = issue()
    expect(() =>
      verifyBulkPageSelection(secret, binding, bulkPageToken, [first, randomUUID()], issuedAt),
    ).toThrow(changed)
  })

  it('rejects altered, malformed and incorrectly signed tokens', () => {
    const { bulkPageToken } = issue()
    const [encoded = '', signature = ''] = bulkPageToken.split('.')
    const forged = `${encoded}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`
    for (const token of [forged, `${bulkPageToken}.`, '', 'a'.repeat(6_001)]) {
      expect(() => verifyBulkPageSelection(secret, binding, token, [first], issuedAt)).toThrow(
        changed,
      )
    }
    expect(() =>
      verifyBulkPageSelection(
        'different test-only secret',
        binding,
        bulkPageToken,
        [first],
        issuedAt,
      ),
    ).toThrow(changed)
  })

  it.each(['userId', 'sessionId', 'organizationId'] satisfies (keyof BulkPageBinding)[])(
    'rejects an otherwise valid proof with a different %s',
    (field) => {
      const { bulkPageToken } = issue()
      const otherBinding = { ...binding, [field]: randomUUID() }
      expect(() =>
        verifyBulkPageSelection(secret, otherBinding, bulkPageToken, [first], issuedAt),
      ).toThrow(changed)
    },
  )

  it('expires exactly ten minutes after issuance', () => {
    const { bulkPageToken } = issue()
    expect(
      verifyBulkPageSelection(
        secret,
        binding,
        bulkPageToken,
        [first],
        new Date(expiresAt.getTime() - 1),
      ),
    ).toEqual({ bookingIds: [first], expiresAt })
    expect(() =>
      verifyBulkPageSelection(secret, binding, bulkPageToken, [first], expiresAt),
    ).toThrow(changed)
  })

  it('rejects invalid IDs, empty and oversized selections and case-variant duplicates', () => {
    const { bulkPageToken } = issue()
    for (const ids of [[], ['invalid'], bookingIds.slice(0, 26), [first, first.toUpperCase()]]) {
      expect(
        BulkPreviewSelectionSchema.safeParse({ pageToken: bulkPageToken, bookingIds: ids }).success,
      ).toBe(false)
      expect(() => verifyBulkPageSelection(secret, binding, bulkPageToken, ids, issuedAt)).toThrow(
        expect.objectContaining({ kind: 'invalid', code: 'invalid_request' }),
      )
    }
    expect(
      BulkPreviewSelectionSchema.parse({
        pageToken: bulkPageToken,
        bookingIds: [second.toUpperCase()],
      }).bookingIds,
    ).toEqual([second])
    expect(
      BulkPreviewSelectionSchema.safeParse({
        pageToken: bulkPageToken,
        bookingIds: [first],
        reason: 'extra field',
      }).success,
    ).toBe(false)
  })
})
