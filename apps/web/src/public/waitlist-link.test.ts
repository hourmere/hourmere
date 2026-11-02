import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import {
  loadWaitlistSuggestion,
  parseWaitlistLink,
  waitlistPreviewActive,
} from './waitlist-link.ts'

const token = `00000000-0000-4000-8000-000000000091.${'w'.repeat(43)}`
const start = '2026-11-02T14:00:00.000Z'
const deadline = String(Date.parse('2026-11-02T12:00:00Z'))
const end = '2026-11-02T14:30:00.000Z'
type Helpers = {
  loadWaitlistSuggestion: typeof loadWaitlistSuggestion
  parseWaitlistLink: typeof parseWaitlistLink
  waitlistPreviewActive: typeof waitlistPreviewActive
}
const original = { loadWaitlistSuggestion, parseWaitlistLink, waitlistPreviewActive }
function sourceCopy(before?: string, after = ''): Helpers {
  let source = readFileSync('apps/web/src/public/waitlist-link.ts', 'utf8')
  if (before) {
    expect(source.includes(before), 'mutation must match the source').toBe(true)
    source = source.replace(before, after)
  }
  return new Function(
    `${stripTypeScriptTypes(source).replace(/\bexport /g, '')}; return {loadWaitlistSuggestion,parseWaitlistLink,waitlistPreviewActive}`,
  )()
}
async function assertExact(h: Helpers) {
  const signal = new AbortController().signal
  for (const slots of [
    [],
    [{ start: '2026-11-02T14:01:00Z', end }],
    [{ start, end: '2026-11-02T14:31:00Z' }],
  ]) {
    const load = vi.fn(async () => slots)
    expect(await h.loadWaitlistSuggestion(load, start, 30, signal)).toBeUndefined()
    expect(load).toHaveBeenCalledWith(start, end, signal)
  }
  expect(await h.loadWaitlistSuggestion(async () => [{ start, end }], start, 30, signal)).toEqual({
    start,
    end,
  })
  const unavailable = new Error('calendar_sync_unavailable')
  await expect(
    h.loadWaitlistSuggestion(
      async () => {
        throw unavailable
      },
      start,
      30,
      signal,
    ),
  ).rejects.toBe(unavailable)
}
function assertInput(h: Helpers) {
  expect(h.parseWaitlistLink(token, start, 'invalid')).toBeUndefined()
  expect(h.parseWaitlistLink(token, start, '9999999999999999')).toBeUndefined()
  const link = h.parseWaitlistLink(token, start, deadline)
  expect(link).toBeDefined()
  if (!link) return
  expect(h.waitlistPreviewActive(link, Number(deadline) - 1)).toBe(true)
  expect(h.waitlistPreviewActive(link, Number(deadline))).toBe(false)
  expect(h.waitlistPreviewActive(link, Number(deadline) + 1)).toBe(false)
  expect(h.parseWaitlistLink('not-a-capability', start, deadline)).toBeUndefined()
  expect(h.parseWaitlistLink(token, 'November 2, 2026', deadline)).toBeUndefined()
  expect(h.parseWaitlistLink(token, 'invalid', deadline)).toBeUndefined()
  expect(h.parseWaitlistLink(token, start, deadline)?.token === token).toBe(true)
}
describe('waitlist link exact-interval protections', () => {
  it('validates the input and preserves authoritative errors and exact availability', async () => {
    assertInput(original)
    await assertExact(original)
    assertInput(sourceCopy())
    await assertExact(sourceCopy())
  })
  it.each([
    ['preview deadline equality', 'now < link.expiresAt', 'now <= link.expiresAt'],
    ['preview deadline', 'now < link.expiresAt', 'true'],
    ['capability shape', '!/^[a-f\\d-]{36}\\.[A-Za-z0-9_-]{43}$/.test(token)', 'false'],
    [
      'ISO instant',
      '!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$/.test(start)',
      'false',
    ],
  ])('detects removal of %s in an isolated source copy', (_name, before, after) => {
    const copied = sourceCopy(before, after)
    expect(() => assertInput(copied)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
  it.each([
    ['exact start', 'Date.parse(candidate.start) === at', 'true'],
    ['exact end', 'Date.parse(candidate.end) === Date.parse(end)', 'true'],
    [
      'authoritative read',
      'const slots = await load(start, end, signal)',
      'const slots = [{start,end}]',
    ],
  ])('detects bypassing %s in an isolated source copy', async (_name, before, after) => {
    const copied = sourceCopy(before, after)
    await expect(assertExact(copied)).rejects.toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})

describe('late waitlist preview response source-copy control', () => {
  const source = readFileSync('apps/web/src/public/BookingPage.tsx', 'utf8')
  const startAt = source.indexOf('(offered) => {')
  const callback = source
    .slice(startAt, source.indexOf('(error) => {', startAt))
    .trim()
    .replace(/,$/, '')
  function assertLateResponse(value: string) {
    const setSlot = vi.fn()
    const setNotice = vi.fn()
    const handler = new Function(
      'controller',
      'waitlist',
      'currentTime',
      'waitlistPreviewActive',
      'setNotice',
      'setSuggestion',
      'setSlot',
      `return (${value})`,
    )(
      { signal: { aborted: false } },
      { token, start, expiresAt: Number(deadline) },
      () => Number(deadline),
      waitlistPreviewActive,
      setNotice,
      vi.fn(),
      setSlot,
    )
    handler({ start, end })
    expect(setSlot).not.toHaveBeenCalled()
    expect(setNotice).toHaveBeenCalledWith(
      'These suggestions have expired. Check the current available times.',
    )
  }
  it('checks expiry again after the asynchronous availability read', () => {
    assertLateResponse(callback)
    const before = '!waitlistPreviewActive(waitlist, currentTime())'
    expect(callback.includes(before)).toBe(true)
    expect(() => assertLateResponse(callback.replace(before, 'false'))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
