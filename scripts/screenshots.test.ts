import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  screenshotCases,
  validateScreenshotBytes,
  validateScreenshotImage,
  validateScreenshotSet,
} from '../tools/e2e/screenshot-plan.ts'

const expectedPages = [
  'booking',
  'booking-form',
  'confirmation',
  'event-types',
  'availability',
  'bookings',
]
const expectedNames = [
  ...expectedPages.flatMap((page) => [`${page}-light.png`, `${page}-dark.png`]),
  'booking-mobile-light.png',
]

it('plans six desktop pages in both themes and a light 390px booking page', () => {
  expect(screenshotCases.map((screenshot) => screenshot.name)).toEqual(expectedNames)
  for (const screenshot of screenshotCases) {
    expect(screenshot).toEqual({
      name: screenshot.name,
      page: screenshot.name === 'booking-mobile-light.png' ? 'booking' : screenshot.page,
      theme: screenshot.name.endsWith('-dark.png') ? 'dark' : 'light',
      viewport:
        screenshot.name === 'booking-mobile-light.png'
          ? { width: 390, height: 844 }
          : { width: 1280, height: 900 },
      isMobile: screenshot.name === 'booking-mobile-light.png',
    })
    expect(screenshot.name).toBe(
      `${screenshot.page}${screenshot.isMobile ? '-mobile' : ''}-${screenshot.theme}.png`,
    )
  }
})

it('accepts exactly the complete screenshot set in any order', () => {
  expect(() => validateScreenshotSet(expectedNames)).not.toThrow()
  expect(() => validateScreenshotSet([...expectedNames].reverse())).not.toThrow()
  expect(() => validateScreenshotSet(expectedNames.slice(1))).toThrow('Missing')
  expect(() => validateScreenshotSet([...expectedNames, expectedNames[0] as string])).toThrow(
    'Duplicate',
  )
  expect(() => validateScreenshotSet([...expectedNames, 'stale.png'])).toThrow('Unexpected')
})

it('requires 2x image pixels while allowing a taller full-page capture', () => {
  for (const screenshot of screenshotCases) {
    const { width, height } = screenshot.viewport
    expect(() => validateScreenshotImage(screenshot.name, width * 2, height * 2)).not.toThrow()
    expect(() => validateScreenshotImage(screenshot.name, width * 2, height * 3)).not.toThrow()
    expect(() => validateScreenshotImage(screenshot.name, width, height * 2)).toThrow('2x')
    expect(() => validateScreenshotImage(screenshot.name, width * 2, height)).toThrow('2x')
  }
  expect(() => validateScreenshotImage('stale.png', 2560, 1800)).toThrow('Unknown')
  for (const height of [Number.NaN, Number.POSITIVE_INFINITY, 1800.5])
    expect(() => validateScreenshotImage('booking-light.png', 2560, height)).toThrow('2x')
})

it('keeps the complete optimized set strictly below 3 MB', () => {
  for (const size of [1, 2_999_999]) expect(() => validateScreenshotBytes(size)).not.toThrow()
  for (const size of [0, -1, 3_000_000, 3_000_001, Number.NaN, Number.POSITIVE_INFINITY, 1.5])
    expect(() => validateScreenshotBytes(size)).toThrow('less than 3 MB')
})

const source = readFileSync(new URL('../tools/e2e/screenshot-plan.ts', import.meta.url), 'utf8')
const directory = mkdtempSync(join(tmpdir(), 'hourmere-screenshot-plan-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

// Execute the actual helpers from a source copy; each mutant must fail these same assertions.
const assertions = `
import assert from 'node:assert/strict'
const {screenshotCases,validateScreenshotSet,validateScreenshotImage,validateScreenshotBytes}=await import('./screenshot-plan.ts')
const pages=['booking','booking-form','confirmation','event-types','availability','bookings']
const names=[...pages.flatMap(page=>[page+'-light.png',page+'-dark.png']),'booking-mobile-light.png']
assert.deepEqual(screenshotCases.map(screenshot=>screenshot.name),names,'All requested screenshot states must be planned')
for(const screenshot of screenshotCases) {
  const mobile=screenshot.name==='booking-mobile-light.png'
  assert.deepEqual(screenshot.viewport,mobile?{width:390,height:844}:{width:1280,height:900},'Capture viewport must stay fixed')
  assert.equal(screenshot.isMobile,mobile,'Mobile state must use mobile layout')
  assert.equal(screenshot.name,screenshot.page+(mobile?'-mobile':'')+'-'+screenshot.theme+'.png','File name must match requested page and theme')
}
assert.doesNotThrow(()=>validateScreenshotSet(names),'Complete set must pass')
assert.throws(()=>validateScreenshotSet(names.slice(1)),/Missing/,'Missing screenshots must fail')
assert.throws(()=>validateScreenshotSet([...names,names[0]]),/Duplicate/,'Duplicate screenshots must fail')
assert.throws(()=>validateScreenshotSet([...names,'stale.png']),/Unexpected/,'Unexpected screenshots must fail')
assert.doesNotThrow(()=>validateScreenshotImage('booking-light.png',2560,1800),'2x image must pass')
assert.doesNotThrow(()=>validateScreenshotImage('booking-light.png',2560,2700),'Full-page image must pass')
assert.throws(()=>validateScreenshotImage('stale.png',2560,1800),/Unknown/,'Unknown images must fail')
assert.throws(()=>validateScreenshotImage('booking-light.png',1280,1800),/2x/,'1x width must fail')
assert.throws(()=>validateScreenshotImage('booking-light.png',2560,900),/2x/,'1x height must fail')
assert.throws(()=>validateScreenshotImage('booking-light.png',2560,Infinity),/2x/,'Non-pixel heights must fail')
assert.doesNotThrow(()=>validateScreenshotBytes(1),'Nonempty set must pass')
assert.doesNotThrow(()=>validateScreenshotBytes(2_999_999),'Set below size budget must pass')
assert.throws(()=>validateScreenshotBytes(0),/less than 3 MB/,'Empty PNG set must fail')
assert.throws(()=>validateScreenshotBytes(3_000_000),/less than 3 MB/,'Size budget must be strict')
assert.throws(()=>validateScreenshotBytes(NaN),/less than 3 MB/,'Invalid byte count must fail')
`

function sourceCopyResult(copy: string) {
  writeFileSync(join(directory, 'screenshot-plan.ts'), copy)
  const runner = join(directory, 'assertions.mjs')
  writeFileSync(runner, assertions)
  const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

describe('source-copy screenshot protection mutations', () => {
  it('passes the original helper implementation', () => {
    const result = sourceCopyResult(source)
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  for (const [from, to, assertion] of [
    ["  'confirmation',\n", '', 'All requested screenshot states must be planned'],
    ['width: 1280, height: 900', 'width: 1280, height: 800', 'Capture viewport must stay fixed'],
    ['isMobile: true', 'isMobile: false', 'Mobile state must use mobile layout'],
    [
      "page: 'booking',\n    theme",
      "page: 'booking-form',\n    theme",
      'File name must match requested page and theme',
    ],
    ['actual.size !== names.length', 'false', 'Duplicate screenshots must fail'],
    ['names.some((name) => !expected.has(name))', 'false', 'Unexpected screenshots must fail'],
    [
      'screenshotCases.some((screenshot) => !actual.has(screenshot.name))',
      'false',
      'Missing screenshots must fail',
    ],
    ["if (!screenshot) throw new Error('Unknown screenshot name')", '', 'Unknown images must fail'],
    ['width !== screenshot.viewport.width * 2 ||', '', '1x width must fail'],
    ['!Number.isInteger(height) ||', '', 'Non-pixel heights must fail'],
    ['height < screenshot.viewport.height * 2', 'false', '1x height must fail'],
    ['!Number.isSafeInteger(total) ||', '', 'Invalid byte count must fail'],
    ['total <= 0 ||', '', 'Empty PNG set must fail'],
    ['total >= 3_000_000', 'false', 'Size budget must be strict'],
  ] as const)
    it(`detects removed protection: ${assertion}`, () => {
      const mutant = source.replace(from, to)
      expect(mutant).not.toBe(source)
      const result = sourceCopyResult(mutant)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('AssertionError')
      expect(result.stderr).toContain(assertion)
    })
})
