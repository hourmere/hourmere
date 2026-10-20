/// <reference lib="dom" />
// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { a11yFindings, axeTags } from '../tools/e2e/a11y.ts'
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
} from '../tools/e2e/reports.ts'

function sourceCopy<T>(file: string, exports: string, replacement?: [string, string]): T {
  let source = readFileSync(`tools/e2e/${file}.ts`, 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match its source').toBe(true)
    source = source.replace(replacement[0], replacement[1])
  }
  source = source.replace(/^import[\s\S]*? from ['"].+?['"]\n/gm, '')
  source = stripTypeScriptTypes(source).replace(/\bexport (?=(?:async )?function|const)/g, '')
  return new Function(`${source}; return {${exports}}`)() as T
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
  expect(measure()).toContainEqual({ code: 'document-overflow', actual: 340, expected: 320 })
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
const verifySticky = (measure = measureLayout) => {
  setup()
  const sticky = box('header', 0, 0, 320, 143)
  sticky.style.position = 'sticky'
  const fixed = box('aside', 0, 0, 30, 200)
  fixed.style.position = 'fixed'
  expect(measure().filter((finding) => finding.code === 'oversized-fixed')).toHaveLength(2)
  vi.stubGlobal('innerHeight', 1000)
  expect(
    measure({ width: 320, height: 256 }).filter((finding) => finding.code === 'oversized-fixed'),
  ).toHaveLength(2)
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
  button.focus()
  document.elementFromPoint = vi.fn(() => cover)
  expect(measure().finding?.code).toBe('obscured-focus')
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
  it('detects sticky and fixed elements over a quarter of the viewport', () => verifySticky())
  it('requires 16px mobile text controls', () => verifyFonts())
  it('approximates target spacing without flagging isolated small targets', () => verifyTargets())
  it('detects focused controls covered at their center', () => verifyFocus())
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
  { id: 'color-contrast', impact: 'serious', nodes: [{ html: 'private DOM' }, {}] },
  { id: 'button-name', impact: 'critical', nodes: [{}] },
  { id: 'region', impact: 'moderate', nodes: [{}] },
]
const verifyAxe = (scan = a11yFindings) => {
  expect(scan('booking', violations, [], '2026-10-20')).toEqual({
    findings: [
      { code: 'axe-serious', rule: 'color-contrast', count: 2 },
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
    ['sticky height', ['rect.height > height * 0.25', 'false'], verifySticky],
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
    for (const verify of [verifyDocument, verifyOverflow, verifySticky, verifyFonts, verifyTargets])
      verify(layout.measureLayout)
    verifyFocus(layout.focusedMeasurement)
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
      ['!hit || (hit !== active && !active.contains(hit))', 'false'],
    )
    expect(() => verifyFocus(copy.focusedMeasurement)).toThrow(
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
