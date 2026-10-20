import type { Page } from '@playwright/test'
import type { AuditFinding } from './reports.ts'

export const layoutViewports = [
  { width: 320, height: 568 },
  { width: 320, height: 256 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
  { width: 1024, height: 768 },
  { width: 1180, height: 820 },
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
] as const

// This function is self-contained so Playwright can run it in the page. Its
// output intentionally excludes every DOM string except native element tags.
export function measureLayout(): AuditFinding[] {
  const findings: AuditFinding[] = []
  const elements = [...document.querySelectorAll('*')]
  const mobileViewport =
    window.innerWidth <= 480 || (window.innerWidth <= 960 && window.innerHeight <= 430)
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element)
    return (
      rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    )
  }
  const target = (element: Element) => ({
    tag: element.tagName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 21),
    index: elements.indexOf(element),
  })
  const documentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  if (documentWidth > document.documentElement.clientWidth + 1)
    findings.push({
      code: 'document-overflow',
      actual: documentWidth,
      expected: document.documentElement.clientWidth,
    })
  const interactive = elements.filter(
    (element) =>
      element.matches(
        'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[tabindex]:not([tabindex="-1"])',
      ) &&
      !element.matches(':disabled,[aria-disabled="true"]') &&
      visible(element),
  )
  for (const element of elements) {
    if (!visible(element)) continue
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element)
    const intendedScroll =
      ['horizontal', 'both'].includes(element.getAttribute('data-layout-scroll') ?? '') &&
      ['auto', 'scroll'].includes(style.overflowX)
    if (
      element !== document.body &&
      element !== document.documentElement &&
      element.scrollWidth > element.clientWidth + 1 &&
      !intendedScroll
    )
      findings.push({
        code: 'element-overflow',
        element: target(element),
        actual: element.scrollWidth,
        expected: element.clientWidth,
      })
    if (['sticky', 'fixed'].includes(style.position) && rect.height > window.innerHeight * 0.25)
      findings.push({
        code: 'oversized-fixed',
        element: target(element),
        actual: rect.height,
        expected: window.innerHeight * 0.25,
      })
    if (
      mobileViewport &&
      element.matches(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="button"]):not([type="submit"]):not([type="reset"]),select,textarea',
      )
    ) {
      const fontSize = Number.parseFloat(style.fontSize)
      if (fontSize < 16)
        findings.push({
          code: 'small-input-font',
          element: target(element),
          actual: fontSize,
          expected: 16,
        })
    }
  }
  for (const element of interactive) {
    const rect = element.getBoundingClientRect()
    if (rect.width >= 24 && rect.height >= 24) continue
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    // Approximate WCAG 2.5.8 spacing: a 24px circle around an undersized
    // target must not intersect a neighbour or another undersized target's circle.
    const spaced = interactive.every((other) => {
      if (other === element || element.contains(other) || other.contains(element)) return true
      const box = other.getBoundingClientRect()
      if (box.width < 24 || box.height < 24)
        return (
          Math.hypot(
            center.x - (box.left + box.width / 2),
            center.y - (box.top + box.height / 2),
          ) >= 24
        )
      const x = Math.max(box.left, Math.min(center.x, box.right)),
        y = Math.max(box.top, Math.min(center.y, box.bottom))
      return Math.hypot(center.x - x, center.y - y) >= 12
    })
    if (!spaced)
      findings.push({
        code: 'small-target',
        element: target(element),
        actual: Math.min(rect.width, rect.height),
        expected: 24,
      })
  }
  return findings
}

export function focusedMeasurement(): { index: number; finding?: AuditFinding } {
  const active = document.activeElement
  if (!active || active === document.body || active === document.documentElement)
    return { index: -1 }
  const index = [...document.querySelectorAll('*')].indexOf(active)
  const rect = active.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return {
    index,
    ...(!hit || (hit !== active && !active.contains(hit))
      ? {
          finding: {
            code: 'obscured-focus' as const,
            element: {
              tag: active.tagName
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '')
                .slice(0, 21),
              index,
            },
          },
        }
      : {}),
  }
}

export function resetKeyboardNavigation() {
  const body = document.body,
    previousTabIndex = body.getAttribute('tabindex')
  body.setAttribute('tabindex', '-1')
  try {
    // Blurring alone preserves the native sequential navigation start point.
    // Focus the body's start so auto-focused middle headings cannot skip links.
    body.focus({ preventScroll: true })
  } finally {
    if (previousTabIndex === null) body.removeAttribute('tabindex')
    else body.setAttribute('tabindex', previousTabIndex)
  }
  window.scrollTo(0, 0)
}

export async function measureKeyboard(page: Page): Promise<AuditFinding[]> {
  await page.evaluate(resetKeyboardNavigation)
  const findings: AuditFinding[] = [],
    visited = new Set<number>()
  let unfocused = 0
  // Cover native Tab navigation, including roving tabindex widgets. Stop at a
  // completed cycle rather than serializing focus names or private href values.
  for (let step = 0; step < 1000; step++) {
    await page.keyboard.press('Tab')
    const focus = await page.evaluate(focusedMeasurement)
    if (focus.index === -1) {
      if (visited.size || ++unfocused >= 2) return findings
      continue
    }
    unfocused = 0
    if (visited.has(focus.index)) return findings
    visited.add(focus.index)
    if (focus.finding) findings.push(focus.finding)
  }
  findings.push({ code: 'keyboard-limit', actual: 1000, phase: 'keyboard' })
  return findings
}
