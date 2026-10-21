/// <reference lib="dom" />
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import AxeBuilder from '@axe-core/playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { a11yFindings, assertAxeCanary, axeTags, scanA11y } from '../tools/e2e/a11y.ts'
import {
  focusedMeasurement,
  layoutViewports,
  measureKeyboard,
  measureLayout,
  resetKeyboardNavigation,
} from '../tools/e2e/layout.ts'
import {
  type AuditReport,
  assertAuditFindings,
  auditIsBlocking,
  auditSummary,
  safeAuditReport,
  summarizeAuditReports,
  summarizeFindingTypes,
} from '../tools/e2e/reports.ts'

function sourceCopy<T>(file: string, exports: string, replacement?: [string, string]): T {
  let source = readFileSync(`tools/e2e/${file}.ts`, 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match its source').toBe(true)
    source = source.replace(replacement[0], replacement[1])
  }
  source = source.replace(/^import[\s\S]*? from ['"].+?['"]\n/gm, '')
  source = stripTypeScriptTypes(source).replace(/\bexport (?=(?:async )?function|const)/g, '')
  return new Function('AxeBuilder', `${source}; return {${exports}}`)(AxeBuilder) as T
}

function rectangle(
  element: HTMLElement,
  x = 0,
  y = 0,
  width = 100,
  height = 40,
  scrollWidth = width,
) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    scrollWidth: { configurable: true, value: scrollWidth },
  })
  element.getBoundingClientRect = () => ({
    x,
    y,
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
    width,
    height,
    toJSON: () => ({}),
  })
  element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList
  return element
}
function box(tag = 'div', x = 0, y = 0, width = 100, height = 40, scrollWidth = width) {
  const element = rectangle(document.createElement(tag), x, y, width, height, scrollWidth)
  document.body.append(element)
  return element
}
function setup() {
  document.body.replaceChildren()
  rectangle(document.documentElement, 0, 0, 320, 568)
  rectangle(document.body, 0, 0, 320, 568)
  vi.stubGlobal('innerWidth', 320)
  vi.stubGlobal('innerHeight', 568)
}
afterEach(() => {
  document.body.replaceChildren()
  document.body.removeAttribute('tabindex')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const report = (): AuditReport => ({
  version: 1,
  kind: 'layout',
  page: 'booking',
  theme: 'dark',
  locale: 'zh-CN',
  viewport: { width: 320, height: 568 },
  findings: [{ code: 'document-overflow', actual: 400, expected: 320 }],
})

const verifyDocument = (measure = measureLayout) => {
  setup()
  rectangle(document.body, 0, 0, 320, 568, 340)
  expect(measure()).toContainEqual(
    expect.objectContaining({ code: 'document-overflow', actual: 340, expected: 320 }),
  )
}
const verifyOverflow = (measure = measureLayout) => {
  setup()
  const allowed = box('div', 0, 0, 100, 40, 200)
  allowed.setAttribute('data-layout-scroll', 'horizontal')
  allowed.style.overflowX = 'auto'
  const clipped = box('div', 0, 50, 100, 40, 200)
  clipped.style.overflowX = 'hidden'
  clipped.setAttribute('data-layout-scroll', 'horizontal')
  const findings = measure().filter((finding) => finding.code === 'element-overflow')
  expect(findings).toHaveLength(1)
  expect(findings[0]?.element?.index).toBe([...document.querySelectorAll('*')].indexOf(clipped))
}
const verifyOverflowNoise = (measure = measureLayout) => {
  setup()
  box('div', 0, 0, 1, 1, 200)
  box('div', 0, 10, 100, 40, 200).className = 'visually-hidden'
  box('div', 0, 20, 100, 40, 200).className = 'sr-only'
  box('div', 0, 30, 100, 40, 200).className = 'screen-reader-text'
  box('div', 0, 40, 100, 40, 200).style.clip = 'rect(0px, 0px, 0px, 0px)'
  box('div', 0, 50, 100, 40, 200).style.clipPath = 'inset(50%)'
  const truncated = box('div', 0, 60, 100, 40, 200)
  truncated.style.textOverflow = 'ellipsis'
  truncated.style.overflowX = 'hidden'
  for (const tag of ['input', 'textarea', 'select']) box(tag, 0, 70, 100, 40, 200)
  const root = box('div', 0, 80, 100, 40, 200)
  expect(
    measure()
      .filter((finding) => finding.code === 'element-overflow')
      .map((finding) => finding.element?.index),
  ).toEqual([[...document.querySelectorAll('*')].indexOf(root)])
}
const verifyOverflowRoot = (measure = measureLayout) => {
  setup()
  const ancestor = box('section', 0, 0, 100, 40, 250)
  const middle = box('div', 0, 0, 100, 40, 250)
  const root = box('p', 0, 0, 100, 40, 250)
  ancestor.append(middle)
  middle.append(root)
  expect(
    measure()
      .filter((finding) => finding.code === 'element-overflow')
      .map((finding) => finding.element?.tag),
  ).toEqual(['p'])
}
const verifySticky = (measure = measureLayout) => {
  setup()
  box('header', 0, 0, 320, 143).style.position = 'sticky'
  box('footer', 0, 425, 320, 143).style.position = 'fixed'
  box('aside', 0, 0, 30, 200).style.position = 'fixed'
  box('aside', 0, 0, 30, 600).style.position = 'sticky'
  box('header', 0, 800, 320, 150).style.position = 'sticky'
  box('header', 0, -800, 320, 150).style.position = 'fixed'
  box('header', 0, 0, 320, 142).style.position = 'sticky'
  expect(
    measure()
      .filter((finding) => finding.code === 'oversized-fixed')
      .map((finding) => finding.expected),
  ).toEqual([142, 142, 568])
  vi.stubGlobal('innerHeight', 1000)
  expect(
    measure({ width: 320, height: 256 }).filter((finding) => finding.code === 'oversized-fixed'),
  ).toHaveLength(3)
}
const verifySelectors = (measure = measureLayout) => {
  setup()
  const element = box('div', 0, 0, 100, 40, 200)
  element.className =
    'layout-root private@example.invalid https://private.invalid PRIVATE_TOKEN_VALUE'
  element.dataset.testid = 'layout-subject'
  element.textContent = 'PRIVATE_TOKEN_VALUE private@example.invalid https://private.invalid'
  expect(measure().find((finding) => finding.code === 'element-overflow')?.element?.selector).toBe(
    'div.layout-root[data-testid="layout-subject"]',
  )
}
const verifyFonts = (measure = measureLayout) => {
  setup()
  box('input').style.fontSize = '15px'
  box('select').style.fontSize = '15.99px'
  box('textarea').style.fontSize = '16px'
  expect(measure().filter((finding) => finding.code === 'small-input-font')).toHaveLength(2)
  vi.stubGlobal('innerWidth', 844)
  vi.stubGlobal('innerHeight', 390)
  expect(measure().filter((finding) => finding.code === 'small-input-font')).toHaveLength(2)
  vi.stubGlobal('innerWidth', 1024)
  vi.stubGlobal('innerHeight', 768)
  expect(measure().filter((finding) => finding.code === 'small-input-font')).toHaveLength(0)
  expect(
    measure({ width: 320, height: 256 }).filter((finding) => finding.code === 'small-input-font'),
  ).toHaveLength(2)
}
const verifyTargets = (measure = measureLayout) => {
  setup()
  box('button', 0, 0, 12, 12)
  box('button', 24, 0, 12, 12)
  box('button', 200, 0, 24, 24)
  expect(measure().filter((finding) => finding.code === 'small-target')).toHaveLength(0)
  box('button', 10, 0, 12, 12)
  expect(measure().filter((finding) => finding.code === 'small-target')).toHaveLength(3)
}
const verifyFocus = (measure = focusedMeasurement) => {
  setup()
  const button = box('button', 0, 0, 24, 24),
    cover = box()
  button.className = 'focus-subject'
  button.dataset.testid = 'focus-control'
  button.focus()
  document.elementFromPoint = vi.fn(() => cover)
  expect(measure().finding?.code).toBe('obscured-focus')
  expect(measure().finding?.element?.selector).toBe(
    'button.focus-subject[data-testid="focus-control"]',
  )
  document.elementFromPoint = vi.fn(() => button)
  expect(measure().finding).toBeUndefined()
  document.elementFromPoint = vi.fn(() => null)
  expect(measure().finding).toBeUndefined()
}
const verifyFocusRects = (measure = focusedMeasurement) => {
  setup()
  const link = box('a', 0, 0, 60, 60),
    cover = box()
  link.tabIndex = 0
  link.focus()
  const first = rectangle(document.createElement('span'), 0, 0, 60, 20).getBoundingClientRect()
  const second = rectangle(document.createElement('span'), 0, 40, 60, 20).getBoundingClientRect()
  link.getClientRects = () => [first, second] as unknown as DOMRectList
  document.elementFromPoint = vi.fn((_x, y) => (y >= 40 ? link : cover))
  expect(measure().finding).toBeUndefined()
  document.elementFromPoint = vi.fn((x, y) => (x < 20 && y < 10 ? link : cover))
  expect(measure().finding).toBeUndefined()
  document.elementFromPoint = vi.fn(() => cover)
  expect(measure().finding?.code).toBe('obscured-focus')
}
const verifyFocusOutside = (measure = focusedMeasurement) => {
  setup()
  const button = box('button', 400, 0, 24, 24)
  button.focus()
  document.elementFromPoint = vi.fn(() => null)
  expect(measure().finding?.code).toBe('outside-viewport-focus')
  expect(document.elementFromPoint).not.toHaveBeenCalled()
  rectangle(button, 310, 0, 24, 24)
  document.elementFromPoint = vi.fn(() => button)
  expect(measure().finding).toBeUndefined()
}
const verifyKeyboardReset = (reset = resetKeyboardNavigation) => {
  for (const previous of [null, '0', '-1']) {
    setup()
    if (previous === null) document.body.removeAttribute('tabindex')
    else document.body.setAttribute('tabindex', previous)
    box('button')
    const heading = box('h1')
    heading.setAttribute('tabindex', '-1')
    heading.focus()
    expect(document.activeElement).toBe(heading)
    const scroll = vi.fn()
    vi.stubGlobal('scrollTo', scroll)
    reset()
    expect(document.activeElement).toBe(document.body)
    expect(document.body.getAttribute('tabindex')).toBe(previous)
    expect(scroll).toHaveBeenCalledWith(0, 0)
  }
}

describe('responsive measurements', () => {
  it('uses every requested CSS viewport including short landscape and large screens', () => {
    expect(layoutViewports.map(({ width, height }) => `${width}x${height}`)).toEqual([
      '320x568',
      '320x256',
      '360x800',
      '390x844',
      '414x896',
      '844x390',
      '768x1024',
      '820x1180',
      '1024x768',
      '1180x820',
      '1280x720',
      '1366x768',
      '1536x864',
      '1920x1080',
      '2560x1440',
      '3840x2160',
    ])
  })
  it('detects document overflow', () => verifyDocument())
  it('exempts only explicitly intended containers that actually scroll', () => verifyOverflow())
  it('ignores hidden text, truncation and native form-control scroll', () => verifyOverflowNoise())
  it('reports only the innermost overflowing element', () => verifyOverflowRoot())
  it('flags tall viewport-edge bars and over-viewport sticky columns', () => verifySticky())
  it('includes static selector hints without private DOM values', () => verifySelectors())
  it('requires 16px mobile text controls', () => verifyFonts())
  it('approximates target spacing without flagging isolated small targets', () => verifyTargets())
  it('detects focused controls covered by another element', () => verifyFocus())
  it('considers every client rect and sample before reporting obscured focus', () =>
    verifyFocusRects())
  it('separates focused controls outside the viewport from obscured focus', () =>
    verifyFocusOutside())
  it('resets an auto-focused middle heading to the document start and restores body tabindex', () =>
    verifyKeyboardReset())
  it('tabs natively until the focus cycle completes and collects obscured focus', async () => {
    const positions = [
      { index: 4, finding: { code: 'obscured-focus' } },
      { index: 5 },
      { index: 4 },
    ]
    const page = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementation(async () => positions.shift()),
      keyboard: { press: vi.fn() },
    }
    expect(await measureKeyboard(page as never)).toEqual([{ code: 'obscured-focus' }])
    expect(page.keyboard.press).toHaveBeenCalledTimes(3)
    expect(page.evaluate).toHaveBeenNthCalledWith(1, resetKeyboardNavigation)
  })
  it('finishes pages with no keyboard targets without 1000 repeated tabs', async () => {
    const page = {
      evaluate: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue({ index: -1 }),
      keyboard: { press: vi.fn() },
    }
    expect(await measureKeyboard(page as never)).toEqual([])
    expect(page.keyboard.press).toHaveBeenCalledTimes(2)
  })
})

const exemption = {
  page: 'booking',
  rule: 'color-contrast',
  expires: '2026-10-20',
  reason: 'Owner review',
  issue: '#219',
}
const violations = [
  { id: 'color-contrast', impact: 'serious', nodes: [{}, {}] },
  { id: 'button-name', impact: 'critical', nodes: [{}] },
  { id: 'region', impact: 'moderate', nodes: [{}] },
]
const verifyAxe = (scan = a11yFindings) => {
  expect(scan('booking', violations, [], '2026-10-20')).toEqual({
    findings: [
      { code: 'axe-serious', rule: 'color-contrast', count: 1 },
      { code: 'axe-serious', rule: 'color-contrast', count: 1 },
      { code: 'axe-critical', rule: 'button-name', count: 1 },
    ],
    exempted: 0,
  })
}
const verifyExpiry = (scan = a11yFindings) => {
  const result = scan('booking', violations, [exemption], '2026-10-21')
  expect(result.findings.map((finding) => finding.code)).toContain('expired-exemption')
  expect(result.exempted).toBe(0)
}
const verifyAxeScan = async (scan = scanA11y) => {
  setup()
  const button = box('button')
  button.className = 'audit-button private@example.invalid PRIVATE_TOKEN_VALUE'
  button.dataset.testid = 'audit-control'
  const analyze = vi.spyOn(AxeBuilder.prototype, 'analyze').mockResolvedValue({
    violations: [
      {
        id: 'button-name',
        impact: 'critical',
        nodes: [{ target: ['button.audit-button'], html: 'PRIVATE_TOKEN_VALUE' }],
      },
    ],
    passes: [{}, {}],
    incomplete: [{ id: 'color-contrast' }],
  } as never)
  const page = {
    evaluate: async (callback: (targets: unknown) => unknown, targets: unknown) =>
      callback(targets),
  }
  const result = await scan(page as never)
  expect(analyze).toHaveBeenCalledTimes(1)
  expect(result.passes).toBe(2)
  expect(result.incomplete).toBe(1)
  expect(result.incompleteRules).toEqual(['color-contrast'])
  expect(a11yFindings('booking', result.violations, []).findings).toEqual([
    {
      code: 'axe-critical',
      rule: 'button-name',
      count: 1,
      element: {
        tag: 'button',
        index: [...document.querySelectorAll('*')].indexOf(button),
        selector: 'button.audit-button[data-testid="audit-control"]',
      },
    },
  ])
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TOKEN_VALUE|private@example|html|target/)
  analyze.mockRestore()
}
const verifyCanary = (assert = assertAxeCanary) => {
  expect(() =>
    assert({
      findings: [
        { code: 'axe-critical', rule: 'button-name' },
        { code: 'axe-critical', rule: 'image-alt' },
      ],
      exempted: 0,
    }),
  ).not.toThrow()
  for (const rule of ['button-name', 'image-alt'])
    expect(() => assert({ findings: [{ code: 'axe-critical', rule }], exempted: 0 })).toThrow(
      'both known violations',
    )
  expect(() => assert({ findings: [], exempted: 0 })).toThrow('both known violations')
}
const verifyFindingSummary = (summarize = summarizeFindingTypes) => {
  const summary = summarize([report()])
  expect(summary.find((finding) => finding.code === 'document-overflow')?.count).toBe(1)
  expect(summary.find((finding) => finding.code === 'small-target')).toEqual({
    code: 'small-target',
    count: 0,
    issues: ['UI-38'],
  })
  expect(summary).toHaveLength(13)
}
const verifySafeSelectors = (safe = safeAuditReport) => {
  const input = report()
  input.axe = { passes: 2, incomplete: 1 }
  input.findings = [
    {
      code: 'element-overflow',
      element: { tag: 'div', index: 4, selector: 'div.layout-panel[data-testid="layout"]' },
    },
  ]
  expect(safe(input).findings[0]?.element?.selector).toBe('div.layout-panel[data-testid="layout"]')
  expect(safe(input).axe).toEqual({ passes: 2, incomplete: 1 })
  for (const selector of [
    'div.private@example.invalid',
    'div[data-testid="https://private.invalid"]',
    'div.PRIVATE_TOKEN_VALUE',
    'span.layout-panel',
    'div[data-testid="PRIVATE_TOKEN_VALUE"]',
  ]) {
    if (input.findings[0]?.element) input.findings[0].element.selector = selector
    expect(safe(input).findings[0]?.element?.selector).toBeUndefined()
  }
}
const verifyIncompleteRules = (safe = safeAuditReport) => {
  const input = report()
  input.axe = {
    passes: 2,
    incomplete: 2,
    incompleteRules: [
      'label',
      'color-contrast',
      'color-contrast',
      '#token=REPORT_PRIVACY_CANARY_NONSECRET',
      'private@example.invalid',
      '<button>',
      7 as unknown as string,
    ],
  }
  expect(safe(input).axe).toEqual({
    passes: 2,
    incomplete: 2,
    incompleteRules: ['color-contrast', 'label'],
  })
}
const verifyIncompleteSummary = (summarize = auditSummary) => {
  const summary = summarize([
    {
      ...report(),
      kind: 'a11y',
      findings: [],
      axe: { passes: 2, incomplete: 1, incompleteRules: ['label'] },
    },
    {
      ...report(),
      kind: 'a11y',
      findings: [],
      axe: { passes: 3, incomplete: 2, incompleteRules: ['color-contrast', 'label'] },
    },
  ])
  expect(summary).toContain('passes 5, incomplete 3')
  expect(summary).toContain('Axe incomplete rules / Axe 待人工确认规则：color-contrast, label')
}
const verifyA11yReportPipeline = async (replacement?: [string, string]) => {
  let source = readFileSync('tools/e2e/specs/a11y.spec.ts', 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match its source').toBe(true)
    source = source.replace(replacement[0], replacement[1])
  }
  source = stripTypeScriptTypes(
    source
      .replace(/^import[\s\S]*? from ['"].+?['"]\n/gm, '')
      .replaceAll('import.meta.url', "'file:///tmp/a11y.spec.ts'"),
  )
  const scans: ((fixtures: unknown) => Promise<void>)[] = []
  const test = Object.assign(
    (_name: string, callback: (fixtures: unknown) => Promise<void>) => scans.push(callback),
    {
      describe: (_name: string, callback: () => void) => callback(),
      use: () => {},
      setTimeout: () => {},
    },
  )
  const reports: AuditReport[] = []
  new Function(
    'test, auditPages, auditLocales, readFile, openAuditPage, scanA11y, a11yFindings, writeAuditReport, assertAuditFindings',
    source,
  )(
    test,
    [{ id: 'booking' }],
    () => ['en-US'],
    async () => '[]',
    async () => {},
    async () => ({ violations: [], passes: 2, incomplete: 1, incompleteRules: ['color-contrast'] }),
    a11yFindings,
    async (report: AuditReport) => reports.push(safeAuditReport(report)),
    assertAuditFindings,
  )
  await scans[0]?.({
    page: { viewportSize: () => ({ width: 320, height: 568 }), emulateMedia: async () => {} },
    app: {},
  })
  expect(reports).toHaveLength(1)
  expect(reports[0]?.axe).toEqual({
    passes: 2,
    incomplete: 1,
    incompleteRules: ['color-contrast'],
  })
}
const verifyPrivacy = (safe = safeAuditReport) => {
  const unsafe = report() as AuditReport & { html: string }
  unsafe.html = 'REPORT_PRIVACY_CANARY_NONSECRET'
  Object.assign(unsafe.findings[0] ?? {}, {
    html: unsafe.html,
    target: `#token=${unsafe.html}`,
    email: 'private@example.invalid',
    stack: unsafe.html,
  })
  expect(JSON.stringify(safe(unsafe))).not.toContain(unsafe.html)
  expect(JSON.stringify(safe(unsafe))).not.toContain('private@example.invalid')
  expect(safe(unsafe).findings[0]?.actual).toBe(400)
}
const verifyBlocking = (assert = assertAuditFindings) => {
  expect(() => assert([report()], false)).not.toThrow()
  expect(() => assert([report()], true)).toThrow(/1 findings across 1 pages/)
}

describe('accessibility findings and private report output', () => {
  it('requires both known axe canary violations', () => verifyCanary())
  it('summarizes every finding type including zeros and known issues', () => verifyFindingSummary())
  it('records axe passes/incomplete and static selectors from the actual scan result', async () =>
    verifyAxeScan())
  it('allowlists static selector grammar and pass/incomplete metrics', () => verifySafeSelectors())
  it('allowlists and deduplicates static incomplete rule ids', () => verifyIncompleteRules())
  it('summarizes incomplete rule ids and counts without creating findings', () =>
    verifyIncompleteSummary())
  it('passes incomplete rule ids from the product scan into sanitized reports', async () =>
    verifyA11yReportPipeline())
  it('includes WCAG 2.0, 2.1 and 2.2 AA tags and reports only serious/critical node counts', () => {
    expect(axeTags).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    verifyAxe()
  })
  it('expires exemptions, validates real calendar dates and requires a review issue', () => {
    verifyExpiry()
    for (const invalid of [
      undefined,
      [{}],
      [{ ...exemption, expires: '2026-02-30' }],
      [{ ...exemption, issue: '' }],
    ])
      expect(
        a11yFindings('booking', violations, invalid).findings.map((finding) => finding.code),
      ).toContain('invalid-exemption')
  })
  it('applies an unexpired exemption only to its exact page and rule', () => {
    expect(a11yFindings('booking', violations, [exemption], '2026-10-20')).toEqual({
      findings: [{ code: 'axe-critical', rule: 'button-name', count: 1 }],
      exempted: 2,
    })
    expect(a11yFindings('settings', violations, [exemption], '2026-10-20').exempted).toBe(0)
  })
  it('rebuilds JSON without DOM, URLs, emails, stack traces or arbitrary fields', () =>
    verifyPrivacy())
  it('rejects private values in report metadata rather than serializing them', () => {
    expect(() => safeAuditReport({ ...report(), page: 'booking#token=CANARY' })).toThrow(
      'Invalid UI audit report metadata',
    )
    const bad = report()
    Object.assign(bad.findings[0] ?? {}, {
      actual: Infinity,
      rule: '#token=CANARY',
      element: { tag: 'a[private]', index: 0 },
    })
    expect(safeAuditReport(bad).findings).toEqual([{ code: 'document-overflow', expected: 320 }])
  })
  it('never fails findings in report-only mode and supports an explicit blocking switch', () => {
    verifyBlocking()
    expect(auditIsBlocking({})).toBe(false)
    expect(auditIsBlocking({ HOURMERE_UI_BLOCKING: 'true' })).toBe(false)
    expect(auditIsBlocking({ HOURMERE_UI_BLOCKING: '1' })).toBe(true)
  })
  it('summarizes overflow and axe node counts per page including scan errors', () => {
    const axe = {
      ...report(),
      kind: 'a11y' as const,
      findings: [
        { code: 'axe-serious' as const, count: 3 },
        { code: 'scan-error' as const, phase: 'axe' as const },
      ],
    }
    expect(summarizeAuditReports([report(), axe])).toEqual([
      { page: 'booking', scans: 2, overflow: 1, axe: 3, other: 1, scanErrors: 1 },
    ])
    expect(auditSummary([report(), axe])).toContain('| booking | 2 | 1 | 3 | 1 | 1 |')
    const types = summarizeFindingTypes([report(), axe])
    expect(types.find((type) => type.code === 'axe-serious')?.count).toBe(3)
    expect(types.find((type) => type.code === 'small-input-font')).toMatchObject({
      count: 0,
      issues: ['B6'],
    })
    expect(types).toHaveLength(13)
    expect(auditSummary([{ ...axe, axe: { passes: 3, incomplete: 1 } }])).toContain(
      'passes 3, incomplete 1',
    )
  })
})

describe('source-copy mutation controls', () => {
  const layoutMutations: [string, [string, string], (measure: typeof measureLayout) => void][] = [
    [
      'document overflow',
      ['documentWidth > document.documentElement.clientWidth + 1', 'false'],
      verifyDocument,
    ],
    [
      'element overflow',
      ['element.scrollWidth > element.clientWidth + 1', 'false'],
      verifyOverflow,
    ],
    ['scroll allowlist', ["['auto', 'scroll'].includes(style.overflowX)", 'true'], verifyOverflow],
    ['sticky bar height', ['rect.height > height * 0.25', 'false'], verifySticky],
    [
      'sticky columns taller than viewport',
      ["style.position === 'sticky' && rect.height > height", 'false'],
      verifySticky,
    ],
    ['side-column exclusion', ['&& fullWidthBar &&', '&& true &&'], verifySticky],
    ['offscreen bottom bars', ['&& rect.top < height', ''], verifySticky],
    ['offscreen top bars', ['&& rect.bottom > 0', ''], verifySticky],
    ['hidden tiny elements', ['element.clientWidth <= 1', 'false'], verifyOverflowNoise],
    [
      'hidden class patterns',
      ['[...element.classList].some((token)', '[].some((token)'],
      verifyOverflowNoise,
    ],
    ['hidden legacy clipping', ['style.clip,', '"none",'], verifyOverflowNoise],
    ['hidden clip-path', ['.test(style.clipPath)', '.test("none")'], verifyOverflowNoise],
    ['ellipsis truncation', ['!truncatedText', 'true'], verifyOverflowNoise],
    [
      'control internal scrolling',
      ["!element.matches('input,select,textarea')", 'true'],
      verifyOverflowNoise,
    ],
    [
      'innermost root cause',
      ['overflowing.some((other) => other !== element && element.contains(other))', 'false'],
      verifyOverflowRoot,
    ],
    [
      'static selector tokens',
      ['const tokens = [...element.classList]', 'const tokens = []'],
      verifySelectors,
    ],
    [
      'private token class exclusion',
      ['&& !/(?:token|secret|canary)/i.test(token)', ''],
      verifySelectors,
    ],
    ['mobile font size', ['if (fontSize < 16)', 'if (false)'], verifyFonts],
    ['landscape mobile font size', ['width <= 960 && height <= 430', 'false'], verifyFonts],
    ['target spacing', ['if (!spaced)', 'if (false)'], verifyTargets],
    [
      'requested mobile width',
      ['viewport?.width ?? window.innerWidth', 'window.innerWidth'],
      verifyFonts,
    ],
    [
      'requested short height',
      ['viewport?.height ?? window.innerHeight', 'window.innerHeight'],
      verifySticky,
    ],
  ]
  it.each(layoutMutations)(
    'detects removal of %s protection with real behavior assertions',
    (_name, replacement, verify) => {
      const copy = sourceCopy<{ measureLayout: typeof measureLayout }>(
        'layout',
        'measureLayout',
        replacement,
      )
      expect(() => verify(copy.measureLayout)).toThrow(
        expect.objectContaining({ name: 'AssertionError' }),
      )
    },
  )
  it('verifies unmutated source copies pass the same behavior assertions', () => {
    const layout = sourceCopy<{
      measureLayout: typeof measureLayout
      focusedMeasurement: typeof focusedMeasurement
      resetKeyboardNavigation: typeof resetKeyboardNavigation
    }>('layout', 'measureLayout, focusedMeasurement, resetKeyboardNavigation')
    for (const verify of [
      verifyDocument,
      verifyOverflow,
      verifySticky,
      verifyFonts,
      verifyTargets,
      verifyOverflowNoise,
      verifyOverflowRoot,
      verifySelectors,
    ])
      verify(layout.measureLayout)
    verifyFocus(layout.focusedMeasurement)
    verifyFocusRects(layout.focusedMeasurement)
    verifyFocusOutside(layout.focusedMeasurement)
    verifyKeyboardReset(layout.resetKeyboardNavigation)
    const axe = sourceCopy<{ a11yFindings: typeof a11yFindings }>('a11y', 'a11yFindings')
    verifyAxe(axe.a11yFindings)
    verifyExpiry(axe.a11yFindings)
    const reports = sourceCopy<{
      safeAuditReport: typeof safeAuditReport
      assertAuditFindings: typeof assertAuditFindings
    }>('reports', 'safeAuditReport, assertAuditFindings')
    verifyPrivacy(reports.safeAuditReport)
    verifyBlocking(reports.assertAuditFindings)
  })
  it('detects loss of nested finding privacy allowlisting', () => {
    const copy = sourceCopy<{ safeAuditReport: typeof safeAuditReport }>(
      'reports',
      'safeAuditReport',
      [
        "{ code: codes.has(finding.code) ? finding.code : 'scan-error' }",
        "{ ...finding, code: codes.has(finding.code) ? finding.code : 'scan-error' }",
      ],
    )
    expect(() => verifyPrivacy(copy.safeAuditReport)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects failure to reset the native sequential navigation start', () => {
    const copy = sourceCopy<{ resetKeyboardNavigation: typeof resetKeyboardNavigation }>(
      'layout',
      'resetKeyboardNavigation',
      ['body.focus({ preventScroll: true })', 'body.blur()'],
    )
    expect(() => verifyKeyboardReset(copy.resetKeyboardNavigation)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects removal of focus visibility protection', () => {
    const copy = sourceCopy<{ focusedMeasurement: typeof focusedMeasurement }>(
      'layout',
      'focusedMeasurement',
      ['...(outside || obscured', '...(false'],
    )
    expect(() => verifyFocus(copy.focusedMeasurement)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it.each([
    [
      'multiple client rects',
      ['[...active.getClientRects()]', '[active.getBoundingClientRect()]'],
      verifyFocusRects,
    ],
    [
      'every rect covered',
      ['visibleRects.every((rect)', 'visibleRects.some((rect)'],
      verifyFocusRects,
    ],
    ['every sample covered', ['[0.2, 0.5, 0.8].every((x)', '[0.5].every((x)'], verifyFocusRects],
    [
      'outside viewport distinction',
      ["('outside-viewport-focus' as const)", "('obscured-focus' as const)"],
      verifyFocusOutside,
    ],
  ] as const)('detects removal of %s', (_name, replacement, verify) => {
    const copy = sourceCopy<{ focusedMeasurement: typeof focusedMeasurement }>(
      'layout',
      'focusedMeasurement',
      [...replacement],
    )
    expect(() => verify(copy.focusedMeasurement)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it.each([
    ['passes count', ['passes: result.passes.length', 'passes: 0']],
    ['incomplete count', ['incomplete: result.incomplete.length', 'incomplete: 0']],
    [
      'incomplete rule ids',
      ['incompleteRules: result.incomplete.map((rule) => rule.id)', 'incompleteRules: []'],
    ],
    ['axe selector hints', ['const tokens = [...element.classList]', 'const tokens = []']],
  ] as const)('detects removal of %s from the scan pipeline', async (_name, replacement) => {
    const copy = sourceCopy<{ scanA11y: typeof scanA11y }>('a11y', 'scanA11y', [...replacement])
    await expect(verifyAxeScan(copy.scanA11y)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('verifies the unmutated scan pipeline source copy', async () => {
    const copy = sourceCopy<{ scanA11y: typeof scanA11y }>('a11y', 'scanA11y')
    await verifyAxeScan(copy.scanA11y)
  })
  it('detects removal of selector privacy filtering', () => {
    const copy = sourceCopy<{ safeAuditReport: typeof safeAuditReport }>(
      'reports',
      'safeAuditReport',
      ['!/(?:token|secret|canary)/i.test(selector)', 'true'],
    )
    expect(() => verifySafeSelectors(copy.safeAuditReport)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects removal of incomplete rule id privacy filtering', () => {
    const copy = sourceCopy<{ safeAuditReport: typeof safeAuditReport }>(
      'reports',
      'safeAuditReport',
      ["typeof rule === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(rule)", 'true'],
    )
    expect(() => verifyIncompleteRules(copy.safeAuditReport)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects removal of incomplete rule ids from the summary', () => {
    const copy = sourceCopy<{ auditSummary: typeof auditSummary }>('reports', 'auditSummary', [
      '...(safe.axe?.incompleteRules ?? [])',
      '...[]',
    ])
    expect(() => verifyIncompleteSummary(copy.auditSummary)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('verifies the unmutated incomplete report source copy', () => {
    const copy = sourceCopy<{
      safeAuditReport: typeof safeAuditReport
      auditSummary: typeof auditSummary
    }>('reports', 'safeAuditReport, auditSummary')
    verifyIncompleteRules(copy.safeAuditReport)
    verifyIncompleteSummary(copy.auditSummary)
  })
  it('detects loss of incomplete rule ids between the scan and report', async () => {
    await expect(
      verifyA11yReportPipeline(['incompleteRules: result.incompleteRules', 'incompleteRules: []']),
    ).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it.each([
    ['button canary', ["!rules.has('button-name')", 'false']],
    ['image canary', ["!rules.has('image-alt')", 'false']],
  ] as const)('detects removal of %s assertions', (_name, replacement) => {
    const copy = sourceCopy<{ assertAxeCanary: typeof assertAxeCanary }>(
      'a11y',
      'assertAxeCanary',
      [...replacement],
    )
    expect(() => verifyCanary(copy.assertAxeCanary)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects loss of per-type summary counts', () => {
    const copy = sourceCopy<{ summarizeFindingTypes: typeof summarizeFindingTypes }>(
      'reports',
      'summarizeFindingTypes',
      ['(counts.get(finding.code) ?? 0) + (finding.count ?? 1)', '0'],
    )
    expect(() => verifyFindingSummary(copy.summarizeFindingTypes)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects loss of serious axe findings', () => {
    const copy = sourceCopy<{ a11yFindings: typeof a11yFindings }>('a11y', 'a11yFindings', [
      "violation.impact !== 'serious' && violation.impact !== 'critical'",
      "violation.impact !== 'critical'",
    ])
    expect(() => verifyAxe(copy.a11yFindings)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects removal of exemption expiry', () => {
    const copy = sourceCopy<{ a11yFindings: typeof a11yFindings }>('a11y', 'a11yFindings', [
      'exemption.expires < today',
      'false',
    ])
    expect(() => verifyExpiry(copy.a11yFindings)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects removal of report field allowlisting using a non-secret canary', () => {
    const copy = sourceCopy<{ safeAuditReport: typeof safeAuditReport }>(
      'reports',
      'safeAuditReport',
      ['version: 1,\n    kind: report.kind', '...report,\n    version: 1,\n    kind: report.kind'],
    )
    expect(() => verifyPrivacy(copy.safeAuditReport)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it('detects loss of the future blocking switch', () => {
    const copy = sourceCopy<{ assertAuditFindings: typeof assertAuditFindings }>(
      'reports',
      'assertAuditFindings',
      ['if (blocking && count)', 'if (false)'],
    )
    expect(() => verifyBlocking(copy.assertAuditFindings)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
})
