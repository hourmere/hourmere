import { readFileSync } from 'node:fs'
import { z } from '@hono/zod-openapi'
import { RescheduleRequestNoteSchema } from '@hourmere/scheduling'
import { describe, expect, it } from 'vitest'
import { RequestRescheduleBody } from './bookings.ts'

const valid = { idempotencyKey: 'c67d8a80-11b6-4ea6-92e8-5157093566a1', note: 'Choose a time' }
function verify(schema: typeof RequestRescheduleBody) {
  expect(schema.safeParse(valid).success).toBe(true)
  expect(schema.safeParse({ ...valid, note: 'x'.repeat(2001) }).success).toBe(false)
  expect(schema.safeParse({ ...valid, idempotencyKey: 'not-a-uuid' }).success).toBe(false)
  expect(schema.safeParse({ ...valid, manageToken: 'unrelated' }).success).toBe(false)
}
function sourceCopy(from?: string, to?: string): typeof RequestRescheduleBody {
  const source = readFileSync(new URL('./bookings.ts', import.meta.url), 'utf8')
  const declaration = source.slice(
    source.indexOf('export const RequestRescheduleBody ='),
    source.indexOf('export const BookingPage ='),
  )
  if (from) expect(declaration).toContain(from)
  const changed = from ? declaration.replace(from, to ?? '') : declaration
  return new Function(
    'z',
    'RescheduleRequestNoteSchema',
    `${changed.replace('export ', '')}; return RequestRescheduleBody`,
  )(z, RescheduleRequestNoteSchema)
}

describe('request reschedule input protections', () => {
  it('requires bounded notes, explicit UUID replay keys and no unknown fields', () => {
    verify(RequestRescheduleBody)
    verify(sourceCopy())
  })
  it.each([
    // The shared note schema now owns both the bound and plain-text validation.
    // Disconnecting it must still fail the overlong-note assertion above.
    ['note bound', 'RescheduleRequestNoteSchema', 'z.string()'],
    ['UUID replay key', '.uuid()', '.string()'],
    ['unknown-field rejection', '.strictObject(', '.object('],
  ])('detects removing %s with a source-copy assertion failure', (_, from, to) => {
    expect(() => verify(sourceCopy(from, to))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
