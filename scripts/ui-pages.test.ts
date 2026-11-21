/// <reference lib="dom" />
// @vitest-environment jsdom
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { languageChoice, resetLanguagePreference } from '../apps/web/src/i18n/store.ts'
import { firstDayOfWeek } from '../apps/web/src/public/calendar.ts'
import { preferredLocale } from '../apps/web/src/public/env.ts'
import { formatTime } from '../apps/web/src/public/time.ts'
import {
  AUDIT_DESCRIPTION,
  AUDIT_EMAIL,
  AUDIT_GUEST_NAME,
  AUDIT_TEAM_NAME,
  AUDIT_TITLE,
  visualMaskSelector,
  visualMaskText,
} from '../tools/e2e/audit-data.ts'
import {
  auditLocales,
  auditPages,
  expandEventSettings,
  prepareAuditLocale,
  verifyAuditPath,
} from '../tools/e2e/audit-pages.ts'

const directory = mkdtempSync(join(tmpdir(), 'hourmere-ui-pages-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

it('covers every requested real page and limits en-GB to the booking page', () => {
  expect(auditPages.map((page) => page.id)).toEqual([
    'poll-unavailable',
    'poll-enroll',
    'poll-check-email',
    'poll-verify',
    'poll-ballot',
    'poll-saved',
    'poll-withdrawn',
    'poll-closed',
    'poll-recover',
    'poll-opt-out',
    'poll-opted-out',
    'host-poll-create',
    'host-poll-create-team',
    'host-poll-create-loading',
    'host-poll-create-empty',
    'host-poll-create-error',
    'host-poll-create-forbidden',
    'host-poll-create-no-address',
    'host-poll-create-times-loading',
    'host-poll-create-unavailable',
    'host-poll-create-times-error',
    'host-poll-create-deadline',
    'host-poll-create-repeated-deadline',
    'host-poll-create-stale',
    'host-poll-create-stale-times',
    'host-poll-create-retry',
    'host-poll-create-recovered',
    'host-poll-create-invited',
    'host-poll-create-link',
    'host-poll-list',
    'host-poll-list-empty',
    'host-poll-list-loading',
    'host-poll-list-forbidden',
    'host-poll-list-error',
    'host-poll-results',
    'host-poll-results-loading',
    'host-poll-results-forbidden',
    'host-poll-results-error',
    'host-poll-results-missing',
    'host-poll-other-space',
    'host-poll-no-available-times',
    'host-poll-conditional',
    'host-poll-stale',
    'host-poll-retry',
    'host-poll-close-confirm',
    'host-poll-cancel-confirm',
    'host-poll-delete-confirm',
    'host-poll-closed',
    'host-poll-canceled',
    'host-poll-scheduled',
    'host-poll-roster-empty',
    'host-poll-roster-invite',
    'host-poll-roster-queued',
    'host-poll-roster-full',
    'host-poll-roster-limited',
    'host-poll-roster-stale',
    'host-poll-roster-retry',
    'host-poll-roster-remove',
    'host-poll-roster-remove-unverified',
    'host-poll-roster-rotate',
    'host-poll-roster-link',
    'host-poll-roster-rotated',
    'routing-form',
    'team-routing-form',
    'routing-form-loading',
    'routing-form-unavailable',
    'routing-form-load-error',
    'routing-form-invalid',
    'routing-form-changed',
    'routing-form-submitting',
    'routing-form-submit-error',
    'routing-form-message',
    'routing-continuation-loading',
    'routing-continuation-unavailable',
    'routing-continuation-load-error',
    'routing-continuation',
    'routing-continuation-slots-loading',
    'routing-continuation-slots-empty',
    'routing-continuation-slots-error',
    'routing-continuation-slots',
    'routing-continuation-details',
    'routing-continuation-invalid',
    'routing-continuation-booking',
    'routing-continuation-booking-error',
    'routing-continuation-confirmation',
    'routing-manager-off',
    'routing-manager-list',
    'routing-manager-team-list',
    'routing-manager-list-empty',
    'routing-manager-list-loading',
    'routing-manager-list-denied',
    'routing-manager-list-error',
    'routing-manager-new',
    'routing-manager-creation-retry',
    'routing-manager-edit',
    'routing-manager-edit-loading',
    'routing-manager-edit-denied',
    'routing-manager-edit-error',
    'routing-manager-edit-missing',
    'routing-manager-context-changed',
    'routing-manager-invalid',
    'routing-manager-saving',
    'routing-manager-saved',
    'routing-manager-save-error',
    'routing-manager-stale',
    'routing-manager-archive-confirm',
    'routing-manager-archiving',
    'routing-manager-archive-error',
    'routing-manager-rules',
    'routing-manager-rules-targets-loading',
    'routing-manager-rules-targets-denied',
    'routing-manager-rules-targets-error',
    'routing-manager-rules-targets-empty',
    'routing-manager-rules-fields-loading',
    'routing-manager-rules-fields-denied',
    'routing-manager-rules-fields-error',
    'routing-manager-rules-invalid-mapping',
    'routing-manager-publication-review',
    'routing-manager-publication-pending',
    'routing-manager-publication-published',
    'routing-manager-publication-disable',
    'routing-manager-publication-disabled',
    'routing-manager-publication-repair',
    'routing-manager-publication-conflict',
    'routing-manager-publication-denied',
    'routing-manager-publication-error',
    'workflows',
    'team-workflows',
    'workflows-empty',
    'workflows-loading',
    'workflows-forbidden',
    'workflows-error',
    'workflows-enable-confirm',
    'workflows-disable-confirm',
    'workflows-delete-confirm',
    'workflows-updating',
    'workflows-enabled',
    'workflows-disabled',
    'workflows-deleted',
    'workflows-stale',
    'workflows-context-changed',
    'workflows-unavailable',
    'workflows-update-error',
    'workflow-create',
    'team-workflow-edit',
    'workflow-edit-built-in',
    'workflow-edit-loading',
    'workflow-edit-forbidden',
    'workflow-edit-error',
    'workflow-webhooks-loading',
    'workflow-webhooks-empty',
    'workflow-webhooks-forbidden',
    'workflow-webhooks-error',
    'workflow-preview-loading',
    'workflow-preview',
    'workflow-preview-fallback',
    'workflow-preview-scope-mismatch',
    'workflow-preview-condition-false',
    'workflow-preview-error',
    'workflow-save-pending',
    'workflow-save-stale',
    'workflow-save-context-changed',
    'workflow-save-error',
    'workflow-run-history',
    'team-workflow-run-history',
    'workflow-run-history-empty',
    'workflow-run-history-loading',
    'workflow-run-history-error',
    'workflow-run-history-forbidden',
    'sso-providers',
    'sso-providers-empty',
    'sso-provider-create',
    'sso-provider-replace-secret',
    'sso-provider-retire',
    'sso-domains',
    'sso-domain-challenge',
    'sso-domain-retire',
    'sso-setup-loading',
    'sso-setup-forbidden',
    'sso-setup-error',
    'sso-setup-conflict',
    'sso-provider-enable',
    'sso-enforcement-recovery-required',
    'sso-proof-mailbox',
    'sso-proof-step-up',
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
    'event-type-editor-expanded',
    'availability-editor',
    'bookings',
    'booking-detail',
    'team-bookings',
    'team-booking-detail',
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

it('expands every settings group and refuses an empty audit state', () => {
  document.body.innerHTML =
    '<details class="event-settings-group"><summary>Booking rules</summary><input></details><details class="event-settings-group" open><summary>Notifications</summary><input></details><details class="event-settings-group"><summary>Booking form</summary><input></details>'
  expandEventSettings()
  expect([...document.querySelectorAll('details')].every((group) => group.open)).toBe(true)
  document.body.innerHTML = ''
  expect(expandEventSettings).toThrow('Event settings disclosures are missing')
})

it('uses a long Chinese title, unbroken synthetic URL, and long synthetic attendee email', () => {
  expect(AUDIT_TITLE).toMatch(/[\u4e00-\u9fff]{15,}/)
  expect(AUDIT_DESCRIPTION).toMatch(/https:\/\/hourmere\.invalid\/\S{200,}/)
  expect(AUDIT_DESCRIPTION.match(/https:\/\/hourmere\.invalid\/(\S+)/)?.[1]).toMatch(
    /^[a-z]{300,}$/,
  )
  expect(AUDIT_EMAIL.length).toBeGreaterThan(120)
  expect(AUDIT_EMAIL).toMatch(/@hourmere\.invalid$/)
  expect(AUDIT_TEAM_NAME.length).toBeGreaterThan(150)
  expect(AUDIT_GUEST_NAME.length).toBeGreaterThan(150)
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
const routingAuditUrl = pathToFileURL(resolve('tools/e2e/routing-form-audit.ts')).href
const routingManagerAuditUrl = pathToFileURL(
  resolve('tools/e2e/routing-form-manager-audit.ts'),
).href
const hostPollAuditUrl = pathToFileURL(resolve('tools/e2e/host-meeting-poll-audit.ts')).href
const workflowAuditUrl = pathToFileURL(resolve('tools/e2e/workflow-audit.ts')).href
const workflowEditorAuditUrl = pathToFileURL(resolve('tools/e2e/workflow-editor-audit.ts')).href
const workflowRunHistoryAuditUrl = pathToFileURL(
  resolve('tools/e2e/workflow-run-history-audit.ts'),
).href
const ssoSetupAuditUrl = pathToFileURL(resolve('tools/e2e/sso-setup-audit.ts')).href
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
  writeFileSync(
    join(directory, 'audit-pages.ts'),
    pages
      .replace("'./routing-form-audit.ts'", JSON.stringify(routingAuditUrl))
      .replace("'./routing-form-manager-audit.ts'", JSON.stringify(routingManagerAuditUrl))
      .replace("'./host-meeting-poll-audit.ts'", JSON.stringify(hostPollAuditUrl))
      .replace("'./workflow-audit.ts'", JSON.stringify(workflowAuditUrl))
      .replace("'./workflow-editor-audit.ts'", JSON.stringify(workflowEditorAuditUrl))
      .replace("'./workflow-run-history-audit.ts'", JSON.stringify(workflowRunHistoryAuditUrl))
      .replace("'./sso-setup-audit.ts'", JSON.stringify(ssoSetupAuditUrl)),
  )
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
const routingEditorPath='/app/routing-forms/72100000-0000-4000-8000-000000000001'
const expected={
  'poll-unavailable':{path:'/poll',public:true,wait:'[data-poll-state="unavailable"]'},
  'poll-enroll':{path:'/poll',public:true,wait:'[data-poll-state="enroll"]'},
  'poll-check-email':{path:'/poll',public:true,wait:'[data-poll-state="check-email"]'},
  'poll-verify':{path:'/poll/voter',public:true,wait:'[data-poll-state="verify"]'},
  'poll-ballot':{path:'/poll/voter',public:true,wait:'[data-poll-state="ballot"]'},
  'poll-saved':{path:'/poll/voter',public:true,wait:'[data-poll-state="saved"]'},
  'poll-withdrawn':{path:'/poll/voter',public:true,wait:'[data-poll-state="withdrawn"]'},
  'poll-closed':{path:'/poll/voter',public:true,wait:'[data-poll-state="closed"]'},
  'poll-recover':{path:'/poll/recover',public:true,wait:'[data-poll-state="recover"]'},
  'poll-opt-out':{path:'/poll/reminder-opt-out',public:true,wait:'[data-poll-state="opt-out"]'},
  'poll-opted-out':{path:'/poll/reminder-opt-out',public:true,wait:'[data-poll-state="opted-out"]'},
  'routing-form':{path:'/route/fixture-host/layout-audit',public:true,wait:'heading:Appointment questions'},
  'team-routing-form':{path:'/route/team/fixture-host/layout-audit',public:true,wait:'heading:Appointment questions'},
  'routing-form-loading':{path:'/route/fixture-host/layout-audit',public:true,wait:'Loading form…'},
  'routing-form-unavailable':{path:'/route/fixture-host/layout-audit',public:true,wait:'This form is unavailable'},
  'routing-form-load-error':{path:'/route/fixture-host/layout-audit',public:true,wait:'We couldn’t load this form.'},
  'routing-form-invalid':{path:'/route/fixture-host/layout-audit',public:true,wait:'Review the highlighted answers.'},
  'routing-form-changed':{path:'/route/fixture-host/layout-audit',public:true,wait:'This form has changed.'},
  'routing-form-submitting':{path:'/route/fixture-host/layout-audit',public:true,wait:'Submitting…'},
  'routing-form-submit-error':{path:'/route/fixture-host/layout-audit',public:true,wait:'We couldn’t submit your answers.'},
  'routing-form-message':{path:'/route/fixture-host/layout-audit',public:true,wait:'Please contact our reception team.'},
  'routing-continuation-loading':{path:'/route/continue',public:true,wait:'status Loading…'},
  'routing-continuation-unavailable':{path:'/route/continue',public:true,wait:'heading:This booking link is unavailable'},
  'routing-continuation-load-error':{path:'/route/continue',public:true,wait:'alert Something went wrong'},
  'routing-continuation':{path:'/route/continue',public:true,wait:'button.day-available'},
  'routing-continuation-slots-loading':{path:'/route/continue',public:true,wait:'status Loading available times…'},
  'routing-continuation-slots-empty':{path:'/route/continue',public:true,wait:'status No available times this month.'},
  'routing-continuation-slots-error':{path:'/route/continue',public:true,wait:'alert Something went wrong'},
  'routing-continuation-slots':{path:'/route/continue',public:true,wait:'.slots button'},
  'routing-continuation-details':{path:'/route/continue',public:true,wait:'heading:Your details'},
  'routing-continuation-invalid':{path:'/route/continue',public:true,wait:'alert Please check the form'},
  'routing-continuation-booking':{path:'/route/continue',public:true,wait:'button:Booking…'},
  'routing-continuation-booking-error':{path:'/route/continue',public:true,wait:'alert Something went wrong'},
  'routing-continuation-confirmation':{path:'/route/continue',public:true,wait:'heading:You’re booked'},
  'routing-manager-off':{path:'/app/routing-forms',public:false,wait:'heading:Page not found'},
  'routing-manager-list':{path:'/app/routing-forms',public:false,wait:'testid:routing-forms-list'},
  'routing-manager-team-list':{path:'/app/routing-forms',public:false,wait:'testid:routing-forms-list',space:'team'},
  'routing-manager-list-empty':{path:'/app/routing-forms',public:false,wait:'testid:routing-forms-empty'},
  'routing-manager-list-loading':{path:'/app/routing-forms',public:false,wait:'testid:routing-forms-loading'},
  'routing-manager-list-denied':{path:'/app/routing-forms',public:false,wait:'testid:routing-forms-denied'},
  'routing-manager-list-error':{path:'/app/routing-forms',public:false,wait:'testid:routing-forms-error'},
  'routing-manager-new':{path:'/app/routing-forms/new',public:false,wait:'testid:routing-form-editor'},
  'routing-manager-creation-retry':{path:'/app/routing-forms/new',public:false,wait:'Could not confirm creation.'},
  'routing-manager-edit':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'testid:routing-form-editor'},
  'routing-manager-edit-loading':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'testid:routing-form-loading'},
  'routing-manager-edit-denied':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'testid:routing-form-denied'},
  'routing-manager-edit-error':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'testid:routing-form-error'},
  'routing-manager-edit-missing':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'testid:routing-form-missing'},
  'routing-manager-context-changed':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'Your team context changed.'},
  'routing-manager-invalid':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'link:Enter a title.'},
  'routing-manager-saving':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'button:Saving…'},
  'routing-manager-saved':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'Draft saved.'},
  'routing-manager-save-error':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'Could not save the routing form.'},
  'routing-manager-stale':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'This routing form changed elsewhere.'},
  'routing-manager-archive-confirm':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'button:Archive form'},
  'routing-manager-archiving':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'button:Archiving…'},
  'routing-manager-archive-error':{path:'/app/routing-forms/72100000-0000-4000-8000-000000000001',public:false,wait:'Could not archive the routing form.'},
  'routing-manager-rules':{path:routingEditorPath,public:false,space:'team',wait:'testid:routing-answer-mappings',preview:'result'},
  'routing-manager-rules-targets-loading':{path:routingEditorPath,public:false,space:'team',wait:'testid:routing-event-types-loading',preview:'loading'},
  'routing-manager-rules-targets-denied':{path:routingEditorPath,public:false,space:'team',wait:'testid:routing-event-types-denied',preview:'denied'},
  'routing-manager-rules-targets-error':{path:routingEditorPath,public:false,space:'team',wait:'testid:routing-event-types-error',preview:'error'},
  'routing-manager-rules-targets-empty':{path:routingEditorPath,public:false,space:'team',wait:'testid:routing-event-types-empty',preview:'result'},
  'routing-manager-rules-fields-loading':{path:routingEditorPath,public:false,space:'team',wait:'testid:routing-booking-fields-loading'},
  'routing-manager-rules-fields-denied':{path:routingEditorPath,public:false,space:'team',wait:'testid:routing-booking-fields-denied'},
  'routing-manager-rules-fields-error':{path:routingEditorPath,public:false,space:'team',wait:'testid:routing-booking-fields-error',preview:'stale'},
  'routing-manager-rules-invalid-mapping':{path:routingEditorPath,public:false,space:'team',wait:'rules.0.target.mappings.0.options-error'},
  'routing-manager-publication-review':{path:routingEditorPath,public:false,space:'team',wait:'testid:routing-publication-review Support with the coordinator'},
  'routing-manager-publication-pending':{path:routingEditorPath,public:false,space:'team',wait:'testid:routing-publication-pending Publishing…'},
  'routing-manager-publication-published':{path:routingEditorPath,public:false,space:'team',wait:'Published version 1.',preview:'result'},
  'routing-manager-publication-disable':{path:routingEditorPath,public:false,space:'team',wait:'checkbox:I understand that while this form is disabled, submissions and pending booking links are blocked.'},
  'routing-manager-publication-disabled':{path:routingEditorPath,public:false,space:'team',wait:'testid:routing-enable-confirmation'},
  'routing-manager-publication-repair':{path:routingEditorPath,public:false,space:'team',wait:'[id="fallback.kind"]:focus'},
  'routing-manager-publication-conflict':{path:routingEditorPath,public:false,space:'team',wait:'button:Reload'},
  'routing-manager-publication-denied':{path:routingEditorPath,public:false,space:'team',wait:"You don't have permission to do that."},
  'routing-manager-publication-error':{path:routingEditorPath,public:false,space:'team',wait:'Could not confirm publication.'},
  'workflows':{path:'/app/workflows',public:false,wait:'SyntheticAppointmentFollowUp'},
  'team-workflows':{path:'/app/workflows',public:false,space:'team',wait:'SyntheticAppointmentFollowUp'},
  'workflows-empty':{path:'/app/workflows',public:false,wait:'No workflows yet.'},
  'workflows-loading':{path:'/app/workflows',public:false,wait:'Loading workflows…'},
  'workflows-forbidden':{path:'/app/workflows',public:false,wait:'Workflows are unavailable in this space.'},
  'workflows-error':{path:'/app/workflows',public:false,wait:'Could not load workflows.'},
  'workflows-enable-confirm':{path:'/app/workflows',public:false,wait:'Enable workflow'},
  'workflows-disable-confirm':{path:'/app/workflows',public:false,wait:'Disable workflow'},
  'workflows-delete-confirm':{path:'/app/workflows',public:false,wait:'Delete workflow'},
  'workflows-updating':{path:'/app/workflows',public:false,wait:'Updating workflow…'},
  'workflows-enabled':{path:'/app/workflows',public:false,wait:'Workflow enabled.'},
  'workflows-disabled':{path:'/app/workflows',public:false,wait:'Workflow disabled.'},
  'workflows-deleted':{path:'/app/workflows',public:false,wait:'Workflow deleted.'},
  'workflows-stale':{path:'/app/workflows',public:false,wait:'Updated appointment follow-up'},
  'workflows-context-changed':{path:'/app/workflows',public:false,wait:'Your space changed. Reload before making changes.'},
  'workflows-unavailable':{path:'/app/workflows',public:false,wait:'This workflow is unavailable.'},
  'workflows-update-error':{path:'/app/workflows',public:false,wait:'Could not update this workflow.'},
  'sso-providers':{path:'/app/settings/sso',public:false,space:'team',wait:'SyntheticIdentityProvider'},
  'sso-providers-empty':{path:'/app/settings/sso',public:false,space:'team',wait:'No identity providers yet.'},
  'sso-provider-create':{path:'/app/settings/sso',public:false,space:'team',wait:'heading:Add OIDC provider'},
  'sso-provider-replace-secret':{path:'/app/settings/sso',public:false,space:'team',wait:'label:New client secret'},
  'sso-provider-retire':{path:'/app/settings/sso',public:false,space:'team',wait:'button:Retire provider'},
  'sso-domains':{path:'/app/settings/sso/domains',public:false,space:'team',wait:'label:Domain name'},
  'sso-domain-challenge':{path:'/app/settings/sso/domains',public:false,space:'team',wait:'button:Copy TXT value'},
  'sso-domain-retire':{path:'/app/settings/sso/domains',public:false,space:'team',wait:'button:Retire domain'},
  'sso-setup-loading':{path:'/app/settings/sso',public:false,space:'team',wait:'Loading SSO settings…'},
  'sso-setup-forbidden':{path:'/app/settings/sso',public:false,space:'team',wait:'SSO settings are unavailable in this team.'},
  'sso-setup-error':{path:'/app/settings/sso',public:false,space:'team',wait:'Could not load SSO settings.'},
  'sso-setup-conflict':{path:'/app/settings/sso',public:false,space:'team',wait:'button:Reload settings'},
  'sso-provider-enable':{path:'/app/settings/sso',public:false,space:'team',wait:'button:Enable provider'},
  'sso-enforcement-recovery-required':{path:'/app/settings/sso',public:false,space:'team',wait:'A current owner must accept recovery enrollment before you can require SSO.'},
  'sso-proof-mailbox':{path:'/app/settings/sso',public:false,space:'team',wait:'label:Email verification link'},
  'sso-proof-step-up':{path:'/app/settings/sso',public:false,space:'team',wait:'link:Open identity provider (opens in a new tab)'},
  'booking-form':{path:'/fixture-host/layout-audit',public:true,wait:'.details-step form input[type="email"]'},
  'booking-confirmation':{path:'/fixture-host/layout-audit',public:true,wait:'.confirmation .booking-details'},
  'booking-time-zone':{path:'/fixture-host/layout-audit',public:true,wait:'.tz-panel [role="listbox"]:visible'},
  'embedded-booking':{path:'/embed/fixture-host/layout-audit',public:true,wait:'.public-embedded .event-title'},
  'team-booking':{path:'/team/FixtureTeam/layout-audit',public:true,wait:'heading'},
  'oauth-consent':{path:'/oauth/consent',public:false,wait:'Synthetic audit connector'},
  'manage-reschedule':{path:'/booking',public:true,wait:'.reschedule-summary .event-title'},
  'event-type-editor-expanded':{path:'/app/event-types/synthetic-event',public:false,wait:'h1'},
  'team-bookings':{path:'/app/team/bookings',public:false,space:'team',wait:'.team-bookings-list'},
  'team-booking-detail':{path:'/app/bookings/synthetic-team-booking',public:false,space:'team',wait:'.team-booking-detail'},
}
for(const [id,state] of Object.entries(expected)) {
  assert.ok(auditPages.some(page=>page.id===id),'Missing coverage state: '+id)
  let path='',signedIn,query='',space
  const calls=[]
  const groups=[{open:false},{open:true},{open:false}]
  globalThis.document={querySelectorAll:()=>groups}
  const locator=(selector)=>({
    waitFor:async()=>calls.push(['wait',selector]),
    first:()=>locator(selector),
    locator:(child)=>locator(selector+' '+child),
    filter:({hasText}={})=>locator(hasText?selector+' '+hasText:selector),
    getByText:(text)=>locator(selector+' '+text),
    getByTestId:(id)=>locator(selector+' testid:'+id),
    getByRole:(role,options)=>locator(selector+' '+role+(options?.name ? ':'+options.name : '')),
    getByLabel:(label)=>locator(selector+' label:'+label),
    click:async()=>{if(['button.day-available','.slots button'].includes(selector))throw new Error('Synthetic clipped pointer target');calls.push(['click',selector]);if(selector.includes('Continue'))path='/oauth/consent';if(selector==='.team-bookings-list button')path='/app/bookings/synthetic-team-booking'},
    press:async(key)=>{calls.push(['press',selector,key]);if(path.startsWith('/oauth/')&&selector.includes('Continue'))path='/oauth/consent';if(selector==='.team-bookings-list button')path='/app/bookings/synthetic-team-booking'},
    fill:async()=>calls.push(['fill',selector]),
    selectOption:async(value)=>calls.push(['select',selector,value]),
  })
  const page={
    clock:{setFixedTime:async(date)=>calls.push(['clock',date.toISOString()])},
    addInitScript:async()=>{},goto:async(url)=>{path=new URL(url).pathname;query=new URL(url).search;calls.push(['goto',path])},
    route:async()=>{},unroute:async()=>{},waitForRequest:async()=>{},
    locator,getByRole:(role,options)=>locator(role+':'+(options?.name ?? '')),
    getByLabel:(label)=>locator('label:'+label),getByText:(text)=>locator(text),
    waitForFunction:async()=>{},evaluate:async(callback,value)=>{calls.push(['evaluate',callback.name]);if(callback.name==='expandEventSettings')callback();if(value?.path==='/route/continue')path=value.path},url:()=> 'http://127.0.0.1:42421'+path,
  }
  const app={url:'http://127.0.0.1:42421',parentUrl:'http://127.0.0.1:42422',auditPollState:async()=>({publicToken:'synthetic-public',voterToken:'synthetic-voter',optOutToken:'synthetic-opt-out'}),auditState:async()=>({organizationId:'synthetic-org',teamOrganizationId:'synthetic-team-org',eventTypeId:'synthetic-event',teamBookingId:'synthetic-team-booking',bookingPath:'/fixture-host/layout-audit',teamBookingPath:'/team/FixtureTeam/layout-audit'}),auditSignIn:async(value,locale,selectedSpace)=>{signedIn=value;space=selectedSpace},auditOAuthQuery:async()=>'?signed=fixture'}
  await assert.doesNotReject(()=>openAuditPage(page,app,id),'Could not prepare coverage state: '+id)
  assert.deepEqual(calls[0],['clock',data.AUDIT_NOW],'Audit browser clock must be fixed before navigation: '+id)
  assert.deepEqual(calls.at(-1),['evaluate','settleAuditLayout'],'Audit layout must settle after content verification: '+id)
  assert.equal(path,state.path,'Wrong coverage route: '+id)
  if(id==='event-type-editor-expanded')assert.ok(groups.every(group=>group.open),'Every event settings group must be expanded')
  if(id==='manage-reschedule')assert.ok(calls.some(call=>call[0]==='wait'&&call[1]==='.reschedule-summary'),'Missing current booking summary readiness')
  assert.equal(signedIn,!state.public,'Wrong authentication state: '+id)
  assert.equal(space,state.space,'Wrong organization space: '+id)
  assert.ok(calls.some(call=>call[0]==='wait'&&call[1].includes(state.wait)),'Missing content verification: '+id)
  if(id.startsWith('routing-manager-rules')||id.startsWith('routing-manager-publication'))
    assert.equal(new URLSearchParams(query).get('organizationId'),'synthetic-team-org','Editor must be pinned to the team space')
  if(state.preview) {
    assert.ok(calls.some(call=>call[0]==='press'&&call[1].includes('Run preview')&&call[2]==='Enter'),'Preview must submit answers with the keyboard')
    assert.ok(calls.some(call=>call[0]==='wait'&&call[1].includes('testid:routing-preview-'+state.preview)),'Missing preview state: '+id)
  }
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
  if(id==='team-booking-detail')
    assert.ok(calls.some(call=>call[0]==='press'&&call[1]==='.team-bookings-list button'&&call[2]==='Enter'),'Team booking detail must open with the keyboard')
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

  it('detects skipped expansion before the layout and axe audit', () => {
    const mutant = pagesSource.replace(
      "if (id === 'event-type-editor-expanded') await page.evaluate(expandEventSettings)",
      '',
    )
    expect(mutant).not.toBe(pagesSource)
    const result = run(mutant)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Every event settings group must be expanded')
  })

  for (const id of [
    'booking-form',
    'booking-confirmation',
    'booking-time-zone',
    'embedded-booking',
    'team-booking',
    'oauth-consent',
    'manage-reschedule',
    'team-bookings',
    'team-booking-detail',
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
      'await page.clock.setFixedTime(new Date(AUDIT_NOW))',
      '',
      'Audit browser clock must be fixed before navigation',
    ],
    [
      'await page.evaluate(settleAuditLayout)',
      '',
      'Audit layout must settle after content verification',
    ],
    [
      '.reschedule-summary .event-title',
      '.reschedule-header p',
      'Missing content verification: manage-reschedule',
    ],
    [
      "? '.reschedule-summary' : '.booking-details'",
      "? '.reschedule-header' : '.booking-details'",
      'Missing current booking summary readiness',
    ],
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
      "id === 'team-bookings' || id === 'team-booking-detail' ? 'team' : undefined",
      'undefined',
      'Wrong organization space: team-bookings',
    ],
    [
      "await page.locator('.team-bookings-list').getByRole('button').first().press('Enter')",
      "await page.locator('.team-bookings-list').getByRole('button').first().click()",
      'Team booking detail must open with the keyboard',
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
  const examples = keys.match(/<pre\b[^>]*>/g) ?? []
  expect(examples.length).toBeGreaterThanOrEqual(2)
  for (const example of examples) expect(example).toMatch(/\bdata-layout-scroll="horizontal"/)
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
