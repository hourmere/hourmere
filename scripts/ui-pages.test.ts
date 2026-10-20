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
    'booking-form',
    'booking-confirmation',
    'booking-time-zone',
    'embedded-booking',
    'team-booking',
    'manage',
    'manage-reschedule',
    'sign-in',
    'oauth-consent',
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
const shellSource = readFileSync('apps/web/src/components/AppShell.tsx', 'utf8')
const apiKeysSource = readFileSync('apps/web/src/pages/ApiKeys.tsx', 'utf8')
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
  assertions = privacyAssertions,
) {
  writeFileSync(join(directory, 'audit-data.ts'), data)
  writeFileSync(join(directory, 'audit-pages.ts'), pages)
  writeFileSync(join(directory, 'visual.spec.ts'), visual)
  writeFileSync(join(directory, 'fixtures.ts'), fixture)
  const runner = join(directory, 'privacy.mjs')
  writeFileSync(runner, assertions)
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

const coverageAssertions = `
import assert from 'node:assert/strict'
const {auditPages,openAuditPage}=await import('./audit-pages.ts')
const data=await import('./audit-data.ts')
assert.notEqual(data.AUDIT_CONFIRMATION_EMAIL,data.AUDIT_EMAIL,'Confirmation email must not duplicate the admin-list fixture')
assert.match(data.AUDIT_CONFIRMATION_EMAIL,/^[a-z.]+[a-z]@hourmere[.]invalid$/,'Confirmation email must pass real form validation')
const expected={
  'booking-form':{path:'/fixture-host/layout-audit',public:true,wait:'.details-step form input[type="email"]'},
  'booking-confirmation':{path:'/fixture-host/layout-audit',public:true,wait:'.confirmation .booking-details'},
  'booking-time-zone':{path:'/fixture-host/layout-audit',public:true,wait:'.tz-panel [role="listbox"]:visible'},
  'embedded-booking':{path:'/embed/fixture-host/layout-audit',public:true,wait:'.public-embedded .event-title'},
  'team-booking':{path:'/team/FixtureTeam/layout-audit',public:true,wait:'heading'},
  'oauth-consent':{path:'/oauth/consent',public:false,wait:'Synthetic audit connector'},
}
for(const [id,state] of Object.entries(expected)) {
  assert.ok(auditPages.some(page=>page.id===id),'Missing coverage state: '+id)
  let path='',signedIn,query=''
  const calls=[]
  const locator=(selector)=>({
    waitFor:async()=>calls.push(['wait',selector]),
    first:()=>locator(selector),
    filter:()=>locator(selector),
    getByText:(text)=>locator(selector+' '+text),
    getByRole:(role)=>locator(selector+' '+role),
    click:async()=>{if(['button.day-available','.slots button'].includes(selector))throw new Error('Synthetic clipped pointer target');calls.push(['click',selector]);if(selector.includes('Continue'))path='/oauth/consent'},
    press:async(key)=>{calls.push(['press',selector,key]);if(selector.includes('Continue'))path='/oauth/consent'},
    fill:async()=>calls.push(['fill',selector]),
    selectOption:async(value)=>calls.push(['select',selector,value]),
  })
  const page={
    addInitScript:async()=>{},goto:async(url)=>{path=new URL(url).pathname;query=new URL(url).search;calls.push(['goto',path])},
    locator,getByRole:(role,options)=>locator(role+':'+(options?.name ?? '')),
    getByLabel:(label)=>locator('label:'+label),getByText:(text)=>locator(text),
    waitForFunction:async()=>{},evaluate:async()=>{},url:()=> 'http://127.0.0.1:42421'+path,
  }
  const app={url:'http://127.0.0.1:42421',parentUrl:'http://127.0.0.1:42422',auditState:async()=>({organizationId:'synthetic-org',bookingPath:'/fixture-host/layout-audit',teamBookingPath:'/team/FixtureTeam/layout-audit'}),auditSignIn:async(value)=>{signedIn=value},auditOAuthQuery:async()=>'?signed=fixture'}
  await assert.doesNotReject(()=>openAuditPage(page,app,id),'Could not prepare coverage state: '+id)
  assert.equal(path,state.path,'Wrong coverage route: '+id)
  assert.equal(signedIn,!state.public,'Wrong authentication state: '+id)
  assert.ok(calls.some(call=>call[0]==='wait'&&call[1].includes(state.wait)),'Missing content verification: '+id)
  if(id==='booking-form'||id==='booking-confirmation') {
    assert.ok(calls.some(call=>call[0]==='press'&&call[1]==='button.day-available'&&call[2]==='Enter'),'Booking state must choose a day')
    assert.ok(calls.some(call=>call[0]==='press'&&call[1]==='.slots button'&&call[2]==='Enter'),'Booking state must choose a time')
  }
  if(id==='booking-confirmation') {
    assert.equal(calls.filter(call=>call[0]==='fill').length,2,'Confirmation must fill invitee fields')
    assert.ok(calls.some(call=>call[0]==='press'&&call[1].includes('Confirm booking')&&call[2]==='Enter'),'Confirmation must submit booking')
  }
  if(id==='booking-time-zone')
    assert.ok(calls.some(call=>call[0]==='press'&&call[1]==='.tz-toggle'&&call[2]==='Enter'),'Time-zone panel must open')
  if(id==='embedded-booking') {
    assert.equal(new URLSearchParams(query).get('parentOrigin'),app.parentUrl,'Embed must use the owned allowed parent')
    assert.match(new URLSearchParams(query).get('embedId') ?? '',/^[a-zA-Z0-9_-]{16,64}$/,'Embed must provide a valid correlation ID')
  }
  if(id==='oauth-consent') {
    assert.ok(calls.some(call=>call[0]==='select'&&call[1]==='#oauth-organization'&&call[2]==='synthetic-org'),'Consent must select the fixture organization')
    assert.ok(calls.some(call=>call[0]==='press'&&call[1].includes('Continue')&&call[2]==='Enter'),'Consent must continue to approval')
  }
}
`

describe('source-copy coverage mutations', () => {
  const run = (pages: string) =>
    sourceCopyResult(dataSource, pages, visualSource, fixtureSource, coverageAssertions)

  it('opens and verifies every requested page state through its real preparation branch', () => {
    const result = run(pagesSource)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  for (const id of [
    'booking-form',
    'booking-confirmation',
    'booking-time-zone',
    'embedded-booking',
    'team-booking',
    'oauth-consent',
  ])
    it(`detects removal of ${id} from the shared scan list`, () => {
      const mutant = pagesSource.replace(new RegExp(`^  \\{ id: '${id}'.*\\n`, 'm'), '')
      expect(mutant).not.toBe(pagesSource)
      const result = run(mutant)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`Missing coverage state: ${id}`)
    })

  for (const [from, to, assertion] of [
    [
      "await page.locator('button.day-available').first().press('Enter')",
      '',
      'Booking state must choose a day',
    ],
    [
      "await page.locator('.slots button').first().press('Enter')",
      '',
      'Booking state must choose a time',
    ],
    [
      "await page.locator('button.day-available').first().press('Enter')",
      "await page.locator('button.day-available').first().click()",
      'Could not prepare coverage state: booking-form',
    ],
    [
      "await page.locator('.slots button').first().press('Enter')",
      "await page.locator('.slots button').first().click()",
      'Could not prepare coverage state: booking-form',
    ],
    [
      'await page.getByLabel(/^(Email|邮箱)$/, { exact: true }).fill(AUDIT_CONFIRMATION_EMAIL)',
      '',
      'Confirmation must fill invitee fields',
    ],
    [
      "await page.getByRole('button', { name: /^(Confirm booking|确认预约)$/ }).press('Enter')",
      '',
      'Confirmation must submit booking',
    ],
    [
      "await page.getByRole('button', { name: /^(Confirm booking|确认预约)$/ }).press('Enter')",
      "await page.getByRole('button', { name: /^(Confirm booking|确认预约)$/ }).click()",
      'Confirmation must submit booking',
    ],
    ["await page.locator('.tz-toggle').press('Enter')", '', 'Time-zone panel must open'],
    [
      "await page.locator('.tz-toggle').press('Enter')",
      "await page.locator('.tz-toggle').click()",
      'Time-zone panel must open',
    ],
    [
      'await organization.selectOption(fixture.organizationId)',
      '',
      'Consent must select the fixture organization',
    ],
    [
      "await page.getByRole('button', { name: /^(Continue|继续)$/ }).press('Enter')",
      '',
      'Could not prepare coverage state: oauth-consent',
    ],
    [
      "await page.getByRole('button', { name: /^(Continue|继续)$/ }).press('Enter')",
      "await page.getByRole('button', { name: /^(Continue|继续)$/ }).click()",
      'Consent must continue to approval',
    ],
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: mutate the literal source text
      "'embedded-booking': `/embed${fixture.bookingPath}`",
      "'embedded-booking': fixture.bookingPath",
      'Wrong coverage route: embedded-booking',
    ],
    [
      "'team-booking': fixture.teamBookingPath",
      "'team-booking': fixture.bookingPath",
      'Wrong coverage route: team-booking',
    ],
    [
      'parentOrigin: app.parentUrl',
      "parentOrigin: 'https://invalid.invalid'",
      'Embed must use the owned allowed parent',
    ],
    [
      "embedId: 'synthetic-layout-audit'",
      "embedId: 'short'",
      'Embed must provide a valid correlation ID',
    ],
  ])
    it(`detects broken state preparation: ${assertion}`, () => {
      const mutant = pagesSource.replace(from as string, to as string)
      expect(mutant).not.toBe(pagesSource)
      const result = run(mutant)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(assertion)
      expect(result.stderr).toContain('AssertionError')
    })

  it('detects confirmation reusing the admin-list attendee email', () => {
    const mutant = dataSource.replace(
      /export const AUDIT_CONFIRMATION_EMAIL = .*/,
      'export const AUDIT_CONFIRMATION_EMAIL = AUDIT_EMAIL',
    )
    expect(mutant).not.toBe(dataSource)
    const result = sourceCopyResult(
      mutant,
      pagesSource,
      visualSource,
      fixtureSource,
      coverageAssertions,
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Confirmation email must not duplicate the admin-list fixture')
    expect(result.stderr).toContain('AssertionError')
  })
})

function assertIntentionalScrollers(shell: string, keys: string) {
  expect(shell).toMatch(/<nav\s+className="sidenav"[^>]*>\s*<ul data-layout-scroll="horizontal">/)
  expect(keys.match(/<pre\b[^>]*\bdata-layout-scroll="horizontal"[^>]*>/g)).toHaveLength(2)
}

it('marks the mobile navigation and code examples as intentional horizontal scrollers', () => {
  assertIntentionalScrollers(shellSource, apiKeysSource)
})

it('detects removal of either intentional horizontal-scroller markup protection', () => {
  for (const [shell, keys] of [
    [shellSource.replace(' data-layout-scroll="horizontal"', ''), apiKeysSource],
    [shellSource, apiKeysSource.replace(' data-layout-scroll="horizontal"', '')],
  ])
    expect(() => assertIntentionalScrollers(shell as string, keys as string)).toThrow()
})
