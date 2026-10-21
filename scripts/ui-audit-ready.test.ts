/// <reference lib="dom" />
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settleAuditLayout } from '../tools/e2e/audit-pages.ts'

type Settle = typeof settleAuditLayout

function sourceCopy(replacement?: [string, string]): Settle {
  let source = readFileSync('tools/e2e/audit-pages.ts', 'utf8')
  source = source.slice(source.indexOf('export async function settleAuditLayout'))
  source = source.slice(0, source.indexOf('export function visualScreenshotOptions'))
  if (replacement) {
    expect(source).toContain(replacement[0])
    source = source.replace(...replacement)
  }
  return new Function(
    `${stripTypeScriptTypes(source).replace('export ', '')}; return settleAuditLayout`,
  )() as Settle
}

let fontStatus = 'loaded'
let fontsReady: Promise<void>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  document.body.replaceChildren(document.createElement('div'))
  fontStatus = 'loaded'
  fontsReady = Promise.resolve()
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      get status() {
        return fontStatus
      },
      get ready() {
        return fontsReady
      },
    },
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  )
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'fonts')
  document.body.replaceChildren()
})

async function verifyFonts(settle: Settle) {
  let release = () => {}
  fontsReady = new Promise<void>((resolve) => {
    release = resolve
  })
  // Font bytes may be loaded while fonts.ready still awaits layout completion.
  fontStatus = 'loaded'
  let completed = false
  const pending = settle().then(() => {
    completed = true
  })
  await vi.advanceTimersByTimeAsync(500)
  expect(completed, 'measurement must wait for fonts.ready').toBe(false)
  fontStatus = 'loaded'
  release()
  await vi.advanceTimersByTimeAsync(96)
  expect(completed, 'font readiness still requires stable paints').toBe(false)
  await vi.advanceTimersByTimeAsync(48)
  expect(completed).toBe(true)
  await pending
}

async function verifyGeometry(settle: Settle) {
  const element = document.body.firstElementChild as HTMLElement
  let width = 100
  element.getBoundingClientRect = () => new DOMRect(0, 0, width, 20)
  let completed = false
  const pending = settle().then(() => {
    completed = true
  })
  // CSS layout can change without a DOM mutation (for example a font swap).
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(64)
    width += 10
  }
  await vi.advanceTimersByTimeAsync(32)
  expect(completed, 'measurement must wait through layout shifts').toBe(false)
  await vi.advanceTimersByTimeAsync(112)
  expect(completed).toBe(true)
  await pending
}

async function verifyMutations(settle: Settle) {
  let completed = false
  const pending = settle().then(() => {
    completed = true
  })
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(64)
    // Same geometry, different React-rendered state: restart the quiet interval.
    document.body.firstElementChild?.setAttribute('data-state', String(i))
  }
  await vi.advanceTimersByTimeAsync(32)
  expect(completed, 'measurement must wait through DOM updates').toBe(false)
  await vi.advanceTimersByTimeAsync(112)
  expect(completed).toBe(true)
  await pending
}

async function verifyLoadingStatus(settle: Settle) {
  let completed = false
  const pending = settle().then(() => {
    completed = true
  })
  await vi.advanceTimersByTimeAsync(64)
  // A late render can introduce another font after the first ready promise.
  fontStatus = 'loading'
  await vi.advanceTimersByTimeAsync(256)
  expect(completed, 'measurement must reject a new loading font').toBe(false)
  fontStatus = 'loaded'
  await vi.advanceTimersByTimeAsync(112)
  expect(completed).toBe(true)
  await pending
}

async function verifyDeadline(settle: Settle) {
  let release = () => {}
  fontsReady = new Promise<void>((resolve) => {
    release = resolve
  })
  let error: Error | undefined
  const pending = settle().catch((failure: Error) => {
    error = failure
  })
  await vi.advanceTimersByTimeAsync(5000)
  try {
    expect(error?.message, 'stuck fonts must fail within five seconds').toBe(
      'Audit layout did not settle',
    )
    release()
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount(), 'a late font promise must not restart a timed-out scan').toBe(0)
    await pending
  } finally {
    release()
    await vi.advanceTimersByTimeAsync(1200)
  }
}

describe('audit layout readiness', () => {
  it('awaits loaded fonts followed by stable paints', () => verifyFonts(settleAuditLayout))
  it('restarts the quiet interval for geometry changes', () => verifyGeometry(settleAuditLayout))
  it('restarts the quiet interval for DOM updates', () => verifyMutations(settleAuditLayout))
  it('waits for fonts introduced by a late render', () => verifyLoadingStatus(settleAuditLayout))

  it('fails a stuck font load within five seconds and cleans up', () =>
    verifyDeadline(settleAuditLayout))

  it('fails continuous layout changes instead of measuring an arbitrary frame', async () => {
    const element = document.body.firstElementChild as HTMLElement
    element.getBoundingClientRect = () => new DOMRect(0, 0, performance.now(), 20)
    const assertion = expect(settleAuditLayout()).rejects.toThrow('Audit layout did not settle')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes the unchanged source copy', async () => {
    const settle = sourceCopy()
    await verifyFonts(settle)
    await verifyGeometry(settle)
    await verifyMutations(settle)
    await verifyLoadingStatus(settle)
    await verifyDeadline(settle)
  })

  for (const [name, replacement, verify] of [
    ['font readiness', ['document.fonts.ready.then', 'Promise.resolve().then'], verifyFonts],
    ['layout stability', ['current !== previous', "previous === ''"], verifyGeometry],
    ['DOM stability', ['() => revision++', '() => {}'], verifyMutations],
    ['late font load', ["document.fonts.status !== 'loaded'", 'false'], verifyLoadingStatus],
    ['settling deadline', ['5000)', '6000)'], verifyDeadline],
    ['timeout cleanup', ['if (!finished) frame', 'frame'], verifyDeadline],
  ] satisfies [string, [string, string], (settle: Settle) => Promise<void>][])
    it(`detects removal of ${name} with a real assertion`, async () => {
      await expect(verify(sourceCopy(replacement))).rejects.toMatchObject({
        name: 'AssertionError',
      })
    })
})
