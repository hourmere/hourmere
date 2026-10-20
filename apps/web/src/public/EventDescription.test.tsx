import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { EmbedLanguage } from '../i18n/runtime.tsx'
import { EventDescription } from './EventDescription.tsx'

it('expands and collapses a measured long description with an accessible control', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(180)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60)
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
  'collapses blank lines so the clamp never ends on an empty line (%j)',
  async (newline) => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(180)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60)
    const user = userEvent.setup()
    render(
      <EventDescription>
        {['', 'First paragraph', '  \t', '', 'Second paragraph', 'Third line', ''].join(newline)}
      </EventDescription>,
    )
    const toggle = await screen.findByRole('button', { name: 'Show more' })
    const text = document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    expect(text?.textContent).toBe('First paragraph\nSecond paragraph\nThird line')
    await user.click(toggle)
    expect(text?.textContent).toBe('First paragraph\nSecond paragraph\nThird line')
  },
)

it('omits disclosure controls for descriptions that fit', () => {
  render(<EventDescription>Short description.</EventDescription>)
  expect(screen.queryByRole('button')).toBeNull()
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
