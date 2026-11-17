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
// output includes only static selector tokens, never text, URLs or accessible names.
export function measureLayout(viewport?: { width: number; height: number }): AuditFinding[] {
  const findings: AuditFinding[] = []
  const elements = [...document.querySelectorAll('*')]
  // Mobile engines can expand innerWidth/innerHeight to fit overflowing content.
  // Keep checks tied to the requested CSS viewport even in that case.
  const width = viewport?.width ?? window.innerWidth
  const height = viewport?.height ?? window.innerHeight
  const mobileViewport = width <= 480 || (width <= 960 && height <= 430)
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element)
    return (
      rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    )
  }
  const target = (element: Element) => {
    const tag = element.tagName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 21)
    const tokens = [...element.classList]
      .filter(
        (token) =>
          /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(token) && !/(?:token|secret|canary)/i.test(token),
      )
      .slice(0, 8)
    const testId = element.getAttribute('data-testid') ?? ''
    return {
      tag,
      index: elements.indexOf(element),
      selector: `${tag}${tokens.map((token) => `.${token}`).join('')}${/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(testId) && !/(?:token|secret|canary)/i.test(testId) ? `[data-testid="${testId}"]` : ''}`,
    }
  }
  const visuallyHidden = (element: Element) => {
    const style = getComputedStyle(element)
    return (
      element.clientWidth <= 1 ||
      [...element.classList].some((token) =>
        /^(?:(?:.*[-_])?(?:visually-hidden|sr-only|screen-reader-only|screen-reader-text))(?:[-_].*)?$/.test(
          token,
        ),
      ) ||
      /^(?:rect\(0(?:px)?[, ]+0(?:px)?[, ]+0(?:px)?[, ]+0(?:px)?\)|rect\(0px, 0px, 0px, 0px\))$/.test(
        style.clip,
      ) ||
      /^inset\(\s*(?:50|100)%/.test(style.clipPath)
    )
  }
  const documentWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
  if (documentWidth > document.documentElement.clientWidth + 1)
    findings.push({
      code: 'document-overflow',
      element: target(document.documentElement),
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
  const overflowing: Element[] = []
  for (const element of elements) {
    if (!visible(element)) continue
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element)
    const intendedScroll =
      ['horizontal', 'both'].includes(element.getAttribute('data-layout-scroll') ?? '') &&
      ['auto', 'scroll'].includes(style.overflowX)
    const truncatedText =
      style.textOverflow === 'ellipsis' &&
      ['hidden', 'clip'].includes(style.overflowX || style.overflow)
    if (
      element !== document.body &&
      element !== document.documentElement &&
      element.scrollWidth > element.clientWidth + 1 &&
      !intendedScroll &&
      !visuallyHidden(element) &&
      !truncatedText &&
      !element.matches('input,select,textarea')
    )
      overflowing.push(element)
    const fullWidthBar =
      rect.left <= 1 &&
      rect.right >= width - 1 &&
      ((rect.top <= 1 && rect.bottom > 0) || (rect.bottom >= height - 1 && rect.top < height))
    const oversizedSticky = style.position === 'sticky' && rect.height > height
    if (
      oversizedSticky ||
      (['sticky', 'fixed'].includes(style.position) && fullWidthBar && rect.height > height * 0.25)
    )
      findings.push({
        code: 'oversized-fixed',
        element: target(element),
        actual: rect.height,
        expected: oversizedSticky ? height : height * 0.25,
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
  // The deepest overflowing box explains its ancestors' propagated scrollWidth.
  for (const element of overflowing) {
    if (overflowing.some((other) => other !== element && element.contains(other))) continue
    findings.push({
      code: 'element-overflow',
      element: target(element),
      actual: element.scrollWidth,
      expected: element.clientWidth,
    })
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
  const rects = [...active.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0)
  const visibleRects = rects.filter(
    (rect) =>
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight,
  )
  const outside = visibleRects.length === 0
  // Wrapped inline links can have several disjoint rects. Any exposed sample in
  // any visible rect makes the focus visible; a bounding-box center can hit a gap.
  const obscured =
    visibleRects.length > 0 &&
    visibleRects.every((rect) => {
      const left = Math.max(0, rect.left),
        right = Math.min(window.innerWidth, rect.right)
      const top = Math.max(0, rect.top),
        bottom = Math.min(window.innerHeight, rect.bottom)
      return [0.2, 0.5, 0.8].every((x) =>
        [0.2, 0.5, 0.8].every((y) => {
          const hit = document.elementFromPoint(left + (right - left) * x, top + (bottom - top) * y)
          return hit !== null && hit !== active && !active.contains(hit)
        }),
      )
    })
  const tag = active.tagName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 21)
  const tokens = [...active.classList]
    .filter(
      (token) =>
        /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(token) && !/(?:token|secret|canary)/i.test(token),
    )
    .slice(0, 8)
  const testId = active.getAttribute('data-testid') ?? ''
  return {
    index,
    ...(outside || obscured
      ? {
          finding: {
            code: outside ? ('outside-viewport-focus' as const) : ('obscured-focus' as const),
            element: {
              tag,
              index,
              selector: `${tag}${tokens.map((token) => `.${token}`).join('')}${/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(testId) && !/(?:token|secret|canary)/i.test(testId) ? `[data-testid="${testId}"]` : ''}`,
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
