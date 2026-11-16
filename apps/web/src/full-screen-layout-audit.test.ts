import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusedMeasurement, measureLayout } from '../../../tools/e2e/layout.ts'

const viewport = { width: 320, height: 568 }
const created: HTMLElement[] = []
afterEach(() => {
  for (const element of created.splice(0)) element.remove()
})

function dimensions(element: HTMLElement, width: number, scrollWidth = width) {
  vi.spyOn(element, 'clientWidth', 'get').mockReturnValue(width)
  vi.spyOn(element, 'scrollWidth', 'get').mockReturnValue(scrollWidth)
}

function fixture() {
  vi.stubGlobal('innerWidth', viewport.width)
  vi.stubGlobal('innerHeight', viewport.height)
  const root = document.createElement('div')
  const outside = document.createElement('aside')
  root.innerHTML =
    '<header></header><main><div></div><section role="region" aria-label="Booking details"><button>Close details</button></section></main>'
  document.body.append(root, outside)
  created.push(root, outside)
  const region = root.querySelector('section') as HTMLElement
  const close = region.querySelector('button') as HTMLButtonElement
  const backgrounds = [
    root.querySelector('header'),
    root.querySelector('main > div'),
    outside,
  ] as HTMLElement[]
  for (const element of backgrounds) {
    element.inert = true
    element.setAttribute('aria-hidden', 'true')
  }
  region.style.position = 'fixed'
  region.style.overflowY = 'auto'
  let rect = new DOMRect(0, 0, viewport.width, viewport.height)
  vi.spyOn(region, 'getBoundingClientRect').mockImplementation(() => rect)
  vi.spyOn(close, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 16, 100, 40))
  dimensions(document.documentElement, viewport.width)
  dimensions(document.body, viewport.width)
  dimensions(region, viewport.width)
  dimensions(close, 100)
  close.focus()
  return {
    root,
    region,
    close,
    backgrounds,
    setRect(next: DOMRect) {
      rect = next
    },
    findings: () => measureLayout(viewport),
  }
}

function oversized() {
  return measureLayout(viewport).filter((finding) => finding.code === 'oversized-fixed')
}

describe('full-screen view layout measurement', () => {
  it('recognizes a named, scrollable, focused viewport view with an inaccessible background', () => {
    const view = fixture()
    expect(view.findings()).toEqual([])
    view.region.style.overflowY = 'scroll'
    expect(view.findings()).toEqual([])
    view.region.removeAttribute('aria-label')
    const heading = document.createElement('h1')
    heading.id = 'full-screen-view-heading'
    heading.textContent = 'Booking details'
    view.region.prepend(heading)
    view.region.setAttribute('aria-labelledby', heading.id)
    expect(view.findings()).toEqual([])
  })

  it.each([
    'role',
    'name',
    'empty name',
    'missing label reference',
    'scroll',
    'focus',
    'fixed',
    'hidden view',
  ])('does not exempt a view missing its %s prerequisite', (missing) => {
    const view = fixture()
    if (missing === 'role') view.region.setAttribute('role', 'complementary')
    if (missing === 'name') view.region.removeAttribute('aria-label')
    if (missing === 'empty name') view.region.setAttribute('aria-label', '  ')
    if (missing === 'missing label reference') {
      view.region.removeAttribute('aria-label')
      view.region.setAttribute('aria-labelledby', 'absent-heading')
    }
    if (missing === 'scroll') view.region.style.overflowY = 'hidden'
    if (missing === 'focus') view.close.blur()
    if (missing === 'fixed') view.region.style.position = 'sticky'
    if (missing === 'hidden view') view.region.setAttribute('aria-hidden', 'true')
    expect(oversized()).toEqual([
      expect.objectContaining({ actual: viewport.height, expected: viewport.height * 0.25 }),
    ])
  })

  it.each([
    ['left', -1, 0, 321, 568],
    ['top', 0, -1, 320, 569],
    ['right', 0, 0, 321, 568],
    ['bottom', 0, 0, 320, 569],
    ['short view', 0, 0, 320, 567],
  ] as const)('requires exact viewport bounds at %s', (_, x, y, width, height) => {
    const view = fixture()
    view.setRect(new DOMRect(x, y, width, height))
    expect(oversized()).toHaveLength(1)
  })

  it.each([0, 1, 2])(
    'requires inert AND aria-hidden on background sibling at level %i',
    (index) => {
      const view = fixture()
      const sibling = view.backgrounds[index] as HTMLElement
      sibling.inert = false
      expect(oversized()).toHaveLength(1)
      sibling.inert = true
      sibling.removeAttribute('aria-hidden')
      expect(oversized()).toHaveLength(1)
      sibling.setAttribute('aria-hidden', 'true')
      expect(oversized()).toEqual([])
    },
  )

  it('still reports an ordinary oversized fixed bar', () => {
    const view = fixture()
    view.setRect(new DOMRect(0, 0, viewport.width, 200))
    view.region.removeAttribute('role')
    expect(oversized()).toEqual([expect.objectContaining({ actual: 200, expected: 142 })])
  })

  it('still checks overflow, input fonts and target sizes inside an exempt view', () => {
    const view = fixture()
    const content = document.createElement('div')
    const input = document.createElement('input')
    const button = document.createElement('button')
    view.region.append(content, input, button)
    dimensions(content, 320, 640)
    vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 80, 320, 40))
    input.style.fontSize = '12px'
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, 140, 20, 20))
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(37, 140, 20, 20))
    const codes = view.findings().map((finding) => finding.code)
    expect(codes).not.toContain('oversized-fixed')
    expect(codes).toContain('element-overflow')
    expect(codes).toContain('small-input-font')
    expect(codes.filter((code) => code === 'small-target')).toHaveLength(2)
    dimensions(document.body, 320, 640)
    expect(view.findings().map((finding) => finding.code)).toContain('document-overflow')
  })

  it('still detects keyboard focus outside the viewport inside an exempt view', () => {
    const view = fixture()
    vi.spyOn(view.close, 'getClientRects').mockReturnValue([
      new DOMRect(0, 600, 100, 40),
    ] as unknown as DOMRectList)
    expect(oversized()).toEqual([])
    expect(focusedMeasurement().finding?.code).toBe('outside-viewport-focus')
  })
})
