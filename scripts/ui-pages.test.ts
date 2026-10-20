/// <reference lib="dom" />
// @vitest-environment jsdom
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { languageChoice, resetLanguagePreference } from '../apps/web/src/i18n/store.ts'
import { firstDayOfWeek } from '../apps/web/src/public/calendar.ts'
import { preferredLocale } from '../apps/web/src/public/env.ts'
import { formatTime } from '../apps/web/src/public/time.ts'
import {
  AUDIT_DESCRIPTION,
  AUDIT_EMAIL,
  AUDIT_TITLE,
  visualMaskSelector,
  visualMaskText,
} from '../tools/e2e/audit-data.ts'
import {
  auditLocales,
  auditPages,
  prepareAuditLocale,
  verifyAuditPath,
} from '../tools/e2e/audit-pages.ts'

const directory = mkdtempSync(join(tmpdir(), 'hourmere-ui-pages-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

it('covers every requested real page and limits en-GB to the booking page', () => {
  expect(auditPages.map((page) => page.id)).toEqual([
    'host',
    'booking',
    'manage',
    'manage-reschedule',
    'sign-in',
    'event-types',
    'event-type-editor',
    'availability-editor',
    'bookings',
    'booking-detail',
    'analytics',
    'calendars',
    'conferences',
    'api-keys',
    'connected-apps',
    'settings',
    'not-found',
  ])
  for (const page of auditPages)
    expect(auditLocales(page.id)).toEqual(
      page.id === 'booking' ? ['en-US', 'zh-CN', 'en-GB'] : ['en-US', 'zh-CN'],
    )
})

it('uses a long Chinese title, unbroken synthetic URL, and long synthetic attendee email', () => {
  expect(AUDIT_TITLE).toMatch(/[\u4e00-\u9fff]{15,}/)
  expect(AUDIT_DESCRIPTION).toMatch(/https:\/\/hourmere\.invalid\/\S{200,}/)
  expect(AUDIT_DESCRIPTION.match(/https:\/\/hourmere\.invalid\/(\S+)/)?.[1]).toMatch(
    /^[a-z]{300,}$/,
  )
  expect(AUDIT_EMAIL.length).toBeGreaterThan(120)
  expect(AUDIT_EMAIL).toMatch(/@hourmere\.invalid$/)
})

it('preserves en-GB Monday-first and 24-hour formatting after a previous English choice', () => {
  const language = Object.getOwnPropertyDescriptor(navigator, 'language')
  const languages = Object.getOwnPropertyDescriptor(navigator, 'languages')
  localStorage.setItem('hourmere-language', 'en')
  // biome-ignore lint/suspicious/noDocumentCookie: arrange an existing explicit preference
  document.cookie = 'hourmere-language=en; Path=/'
  try {
    prepareAuditLocale('en-GB')
    resetLanguagePreference()
    const locale = languageChoice() ?? preferredLocale()
    expect(locale).toBe('en-GB')
    expect(firstDayOfWeek(locale)).toBe(1)
    expect(formatTime(Date.parse('2030-01-07T14:05:00Z'), 'UTC', locale)).toBe('14:05')
  } finally {
    if (language) Object.defineProperty(navigator, 'language', language)
    else Reflect.deleteProperty(navigator, 'language')
    if (languages) Object.defineProperty(navigator, 'languages', languages)
    else Reflect.deleteProperty(navigator, 'languages')
    resetLanguagePreference()
  }
})

it('rejects authentication redirects without reporting their private URL', () => {
  expect(() =>
    verifyAuditPath('http://127.0.0.1:42317/app/settings', '/app/settings'),
  ).not.toThrow()
  expect(() =>
    verifyAuditPath(
      'http://127.0.0.1:42317/sign-in?token=SYNTHETIC_PRIVATE_CANARY',
      '/app/settings',
    ),
  ).toThrow('Synthetic audit state opened an unexpected route')
})

it('masks private DOM values and links, including values absent from HTML attributes', () => {
  document.body.innerHTML = `
    <input id="private-value" readonly>
    <textarea id="private-text" readonly></textarea>
    <input id="private-email" type="email">
    <input id="private-token" name="token">
    <a id="private-link" href="/booking#token=SYNTHETIC_CANARY">Manage</a>
    <a id="private-mail" href="mailto:synthetic@hourmere.invalid">Email</a>
    <code id="private-code">SYNTHETIC_CANARY</code>
    <p id="private-marked" data-private>SYNTHETIC_CANARY</p>
    <p id="public">Public fixture title</p>`
  const input = document.querySelector<HTMLInputElement>('#private-value')
  if (!input) throw new Error('Missing test fixture')
  input.value = 'SYNTHETIC_CANARY'
  expect(input.getAttribute('value')).toBeNull()
  expect([...document.querySelectorAll(visualMaskSelector)].map((node) => node.id)).toEqual([
    'private-value',
    'private-text',
    'private-email',
    'private-token',
    'private-link',
    'private-mail',
    'private-code',
    'private-marked',
  ])
  expect(visualMaskText.test('Plain text synthetic@hourmere.invalid')).toBe(true)
  expect(visualMaskText.test('hm_synthetic_canary')).toBe(true)
  expect(visualMaskText.test('http://127.0.0.1:42317/fixture-host/layout-audit')).toBe(true)
  expect(visualMaskText.test('127.0.0.1:42317/fixture-host/layout-audit')).toBe(true)
  expect(visualMaskText.test('Public fixture title')).toBe(false)
})

const dataSource = readFileSync('tools/e2e/audit-data.ts', 'utf8')
const pagesSource = readFileSync('tools/e2e/audit-pages.ts', 'utf8')
const visualSource = readFileSync('tools/e2e/specs/visual.spec.ts', 'utf8')
const fixtureSource = readFileSync('tools/e2e/fixtures.ts', 'utf8')
const requiredMasks = [
  'input[readonly]',
  'textarea[readonly]',
  'input[type="email"]',
  'input[name*="token" i]',
  'input[id*="token" i]',
  'input[value*="hm_"]',
  'a[href*="token=" i]',
  'a[href^="mailto:"]',
  '[data-private]',
  '.manage-link',
  'code',
  'pre',
]
const privacyAssertions = `
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const data = await import('./audit-data.ts')
assert.match(data.AUDIT_DESCRIPTION.split('https://hourmere.invalid/')[1] ?? '', /^[a-z]{300,}$/, 'Long URL must have no punctuation break opportunities')
const {openAuditPage,visualScreenshotOptions,prepareAuditLocale,verifyAuditPath} = await import('./audit-pages.ts')
const canary = 'SYNTHETIC_PRIVATE_CANARY'
let failure
try { await openAuditPage({}, { auditState: async()=>{throw new Error(canary)} }, 'manage') }
catch(error) { failure = error }
assert.equal(failure?.message, 'Could not prepare synthetic audit state: manage')
assert.equal(failure?.message.includes(canary), false)
assert.doesNotThrow(()=>verifyAuditPath('http://127.0.0.1:42317/app/settings','/app/settings'))
assert.throws(()=>verifyAuditPath('http://127.0.0.1:42317/sign-in?token='+canary,'/app/settings'),{message:'Synthetic audit state opened an unexpected route'},'Authentication redirect must not be audited as the requested page')
const locators=[]
const options=visualScreenshotOptions({locator:(selector)=>{locators.push(selector);return selector},getByText:(text)=>text})
assert.equal(options.animations,'disabled')
assert.equal(options.caret,'hide')
assert.equal(options.mask.length,2)
assert.equal(locators[0],data.visualMaskSelector)
for(const selector of ${JSON.stringify(requiredMasks)})
  assert.ok(data.visualMaskSelector.includes(selector), 'Missing private DOM mask: '+selector)
assert.ok(options.mask[1].test('synthetic@hourmere.invalid'), 'Missing plain email mask')
assert.ok(options.mask[1].test('hm_synthetic_canary'), 'Missing plain token mask')
assert.ok(options.mask[1].test('http://127.0.0.1:42317/fixture-host/layout-audit'), 'Missing dynamic origin mask')
assert.ok(options.mask[1].test('127.0.0.1:42317/fixture-host/layout-audit'), 'Missing bare dynamic origin mask')
assert.equal(readFileSync(new URL('./visual.spec.ts',import.meta.url),'utf8').match(/page\\.clock\\.setFixedTime\\(new Date\\(AUDIT_NOW\\)\\)/g)?.length,2,'Visual clock must be fixed for English and Chinese captures')
const storage=new Map([['hourmere-language','en']])
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}})
globalThis.localStorage={removeItem:(key)=>storage.delete(key),setItem:(key,value)=>storage.set(key,value)}
globalThis.document={cookie:'hourmere-language=en'}
prepareAuditLocale('en-GB')
assert.equal(storage.has('hourmere-language'),false,'Explicit locale storage overrides en-GB')
assert.ok(document.cookie.includes('Max-Age=0'),'Explicit locale cookie overrides en-GB')
assert.equal(navigator.language,'en-GB')
assert.deepEqual(navigator.languages,['en-GB'])
assert.match(readFileSync(new URL('./fixtures.ts',import.meta.url),'utf8'),/updateTable\\('auth.organization'\\)\\s*\\.set\\(\\{ name: 'Synthetic organization' \\}\\)/,'Organization name must be deterministic')
`

function sourceCopyResult(
  data: string,
  pages: string,
  visual = visualSource,
  fixture = fixtureSource,
) {
  writeFileSync(join(directory, 'audit-data.ts'), data)
  writeFileSync(join(directory, 'audit-pages.ts'), pages)
  writeFileSync(join(directory, 'visual.spec.ts'), visual)
  writeFileSync(join(directory, 'fixtures.ts'), fixture)
  const runner = join(directory, 'privacy.mjs')
  writeFileSync(runner, privacyAssertions)
  const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

describe('source-copy privacy mutations', () => {
  it('passes the real screenshot and error-redaction contract', () => {
    const result = sourceCopyResult(dataSource, pagesSource)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('detects punctuation making the long URL artificially wrappable', () => {
    const mutant = dataSource.replace('unbrokenlayoutmeasurement', 'unbroken-layout-measurement-')
    expect(mutant).not.toBe(dataSource)
    const result = sourceCopyResult(mutant, pagesSource)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Long URL must have no punctuation break opportunities')
    expect(result.stderr).toContain('AssertionError')
  })

  for (const selector of requiredMasks)
    it(`detects removal of the ${selector} screenshot mask`, () => {
      const mutant = dataSource.replace(`  '${selector}',\n`, '')
      expect(mutant).not.toBe(dataSource)
      const result = sourceCopyResult(mutant, pagesSource)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Missing private DOM mask')
    })

  it('detects removal of plain-text email and token masking', () => {
    const mutant = pagesSource.replace('page.getByText(visualMaskText)', 'page.getByText(/PUBLIC/)')
    expect(mutant).not.toBe(pagesSource)
    const result = sourceCopyResult(dataSource, mutant)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Missing plain email mask')
  })

  for (const [pattern, assertion] of [
    [String.raw`[^\s@]+@[^\s@]+`, 'Missing plain email mask'],
    [String.raw`\bhm_[a-z\d_]+`, 'Missing plain token mask'],
    [String.raw`(?:https?:\/\/)?127\.0\.0\.1:\d+`, 'Missing dynamic origin mask'],
  ])
    it(`detects a broken plain-text pattern: ${assertion}`, () => {
      const mutant = dataSource.replace(pattern as string, 'PUBLIC_ONLY')
      expect(mutant).not.toBe(dataSource)
      const result = sourceCopyResult(mutant, pagesSource)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(assertion)
    })

  it('detects propagation of a private navigation/fixture error', () => {
    const mutant = pagesSource
      .replace('} catch {', '} catch (cause) {')
      .replace(/throw new Error\(`Could not prepare synthetic audit state:.*`\)/, 'throw cause')
    expect(mutant).not.toBe(pagesSource)
    const result = sourceCopyResult(dataSource, mutant)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('AssertionError')
  })

  for (const [from, to] of [
    ["animations: 'disabled'", "animations: 'allow'"],
    ["caret: 'hide'", "caret: 'initial'"],
  ])
    it(`detects screenshot instability after removing ${from}`, () => {
      const mutant = pagesSource.replace(from as string, to as string)
      expect(mutant).not.toBe(pagesSource)
      const result = sourceCopyResult(dataSource, mutant)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('AssertionError')
    })

  it('detects removal of the fixed screenshot clock', () => {
    const mutant = visualSource.replaceAll(
      'await page.clock.setFixedTime(new Date(AUDIT_NOW))',
      '// Clock removed by source-copy mutation',
    )
    expect(mutant).not.toBe(visualSource)
    const result = sourceCopyResult(dataSource, pagesSource, mutant)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Visual clock must be fixed')
  })

  for (const [from, to, assertion] of [
    [
      "localStorage.removeItem('hourmere-language')",
      "localStorage.setItem('hourmere-language','en')",
      'Explicit locale storage overrides en-GB',
    ],
    ['Max-Age=0', 'Max-Age=31536000', 'Explicit locale cookie overrides en-GB'],
  ])
    it(`detects regional locale regression: ${assertion}`, () => {
      const mutant = pagesSource.replace(from as string, to as string)
      expect(mutant).not.toBe(pagesSource)
      const result = sourceCopyResult(dataSource, mutant)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(assertion)
    })

  it('detects a random organization name returning to visual fixtures', () => {
    const mutant = fixtureSource.replace("name: 'Synthetic organization'", "name: 'org-random'")
    expect(mutant).not.toBe(fixtureSource)
    const result = sourceCopyResult(dataSource, pagesSource, visualSource, mutant)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Organization name must be deterministic')
  })

  it('detects authentication redirects being accepted as the requested page', () => {
    const mutant = pagesSource.replace('new URL(actualUrl).pathname !== expectedPath', 'false')
    expect(mutant).not.toBe(pagesSource)
    const result = sourceCopyResult(dataSource, mutant)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Authentication redirect must not be audited')
  })
})
