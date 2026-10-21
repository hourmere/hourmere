import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { EmbedLanguage } from '../i18n/runtime.tsx'
import { EventDescription } from './EventDescription.tsx'

/** jsdom applies no stylesheet: report the clamp the public CSS would compute. */
function clampAt(value: 'none' | '3') {
  const original = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = original(element, pseudo)
    return new Proxy(style, {
      get: (target, property) =>
        property === 'getPropertyValue'
          ? (name: string) =>
              name === '-webkit-line-clamp' ? value : target.getPropertyValue(name)
          : Reflect.get(target, property),
    })
  })
}

function overflowing() {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(180)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60)
}

const paragraphs = ['', 'First paragraph', '  \t', '', 'Second paragraph', 'Third line', '']

it('expands and collapses a measured long description with an accessible control', async () => {
  clampAt('3')
  overflowing()
  const user = userEvent.setup()
  render(<EventDescription>{'First line\nSecond line\nThird line\nFourth line'}</EventDescription>)
  const toggle = await screen.findByRole('button', { name: 'Show more' })
  const text = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
  expect(text?.textContent).toContain('Fourth line')
  expect(text?.classList.contains('event-description-collapsed')).toBe(true)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await user.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(text?.classList.contains('event-description-collapsed')).toBe(false)
  expect(screen.getByRole('button', { name: 'Show less' })).toBe(toggle)
  await user.click(toggle)
  expect(text?.classList.contains('event-description-collapsed')).toBe(true)
})

it.each(['\n', '\r\n', '\r'])(
  'collapses blank lines only while clamped, restoring them when expanded (%j)',
  async (newline) => {
    clampAt('3')
    overflowing()
    const user = userEvent.setup()
    const original = paragraphs.join(newline)
    render(<EventDescription>{original}</EventDescription>)
    const toggle = await screen.findByRole('button', { name: 'Show more' })
    const text = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(text?.textContent).toBe('First paragraph\nSecond paragraph\nThird line')
    await user.click(toggle)
    expect(text?.textContent).toBe(original)
    await user.click(toggle)
    expect(text?.textContent).toBe('First paragraph\nSecond paragraph\nThird line')
  },
)

it('keeps the blank lines where the page container no longer clamps descriptions', () => {
  clampAt('none')
  const original = paragraphs.join('\n')
  render(<EventDescription>{original}</EventDescription>)
  expect(screen.getByText(original, { normalizer: (value) => value }).textContent).toBe(original)
  expect(screen.queryByRole('button')).toBeNull()
})

it('omits disclosure controls for descriptions that fit', () => {
  render(<EventDescription>Short description.</EventDescription>)
  expect(screen.queryByRole('button')).toBeNull()
})

it('remeasures collapsed blank lines before showing an unnecessary disclosure', () => {
  clampAt('3')
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    const value = this.textContent ?? ''
    return value.includes('\n\n') ? 100 : 60
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60)
  // No observer callback or resize is needed: React's layout effect must measure the
  // collapsed text in its second commit, before the browser can paint a stale button.
  render(<EventDescription>{'Para one.\n\nPara two.\n\nPara three.'}</EventDescription>)
  expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
})

it('localizes description controls in Chinese', () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(180)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60)
  render(
    <EmbedLanguage language="zh-CN">
      <EventDescription>完整说明。</EventDescription>
    </EmbedLanguage>,
  )
  expect(screen.getByRole('button', { name: '展开' }).getAttribute('aria-expanded')).toBe('false')
})
