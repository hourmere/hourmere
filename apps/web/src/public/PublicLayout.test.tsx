/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { EmbedLanguage } from '../i18n/runtime.tsx'
import styles from '../styles.css?raw'
import { fakeApi, renderApp } from '../test/fake-api.tsx'
import { EVENT, eventRoutes } from '../test/public-fixtures.ts'
import { EmbeddedContext } from './embed-context.ts'
import { HostAvatar, hostInitials, PublicLayout } from './PublicLayout.tsx'
import publicStyles from './public.css?raw'

const embedStyles = readFileSync('apps/web/src/public/embed.css', 'utf8')

describe('host avatars', () => {
  it.each([
    ['Ada Lovelace', 'AL'],
    ['  ada\taugusta  lovelace  ', 'AL'],
    ['Prince', 'P'],
    ['王小明', '王'],
    ['王 小明', '王小'],
    ['Ада Лавлейс', 'АЛ'],
    ['e\u0301lodie dubois', 'E\u0301D'],
    ['👩🏽‍💻 Rivera', '👩🏽‍💻R'],
    ['', '?'],
    [' \t\n ', '?'],
  ])('uses complete display-name graphemes for %j', (name, initials) => {
    expect(hostInitials(name)).toBe(initials)
    const { container } = render(<HostAvatar name={name} />)
    const avatar = container.querySelector('.host-avatar')
    expect(avatar?.textContent).toBe(initials)
    expect(avatar?.getAttribute('aria-hidden')).toBe('true')
    expect(avatar?.querySelector('img')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('uses an existing same-origin image without duplicating the visible host name', () => {
    const { container } = render(<HostAvatar name="Ada Lovelace" image="/avatars/ada.png" />)
    const avatar = container.querySelector('.host-avatar')
    const image = avatar?.querySelector('img')
    expect(image?.getAttribute('src')).toBe('/avatars/ada.png')
    expect(image?.getAttribute('alt')).toBe('')
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(avatar?.getAttribute('aria-hidden')).toBe('true')
    expect(avatar?.textContent).toBe('')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('falls back to initials after an image fails and retries a changed image', () => {
    const { container, rerender } = render(
      <HostAvatar name="Ada Lovelace" image="/avatars/ada.png" />,
    )
    const image = container.querySelector('.host-avatar img')
    expect(image).not.toBeNull()
    fireEvent.error(image as HTMLImageElement)
    expect(container.querySelector('.host-avatar img')).toBeNull()
    expect(container.querySelector('.host-avatar')?.textContent).toBe('AL')
    rerender(<HostAvatar name="Ada Lovelace" image="/avatars/ada-new.png" />)
    expect(container.querySelector('.host-avatar img')?.getAttribute('src')).toBe(
      '/avatars/ada-new.png',
    )
  })

  it.each([
    'https://www.gravatar.com/avatar/private-email-hash',
    '//avatars.example.invalid/ada.png',
    'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
    'javascript:alert(1)',
  ])('keeps unsafe or third-party image sources out of the DOM (%s)', (image) => {
    const { container } = render(<HostAvatar name="Ada Lovelace" image={image} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.host-avatar')?.textContent).toBe('AL')
    expect(container.innerHTML.includes(image)).toBe(false)
  })
})

it('keeps the language control in a compact header above the booking content', async () => {
  const user = userEvent.setup()
  fakeApi(eventRoutes(EVENT, ['2026-11-02T14:00:00Z']))
  const sheet = document.createElement('style')
  sheet.textContent = styles + publicStyles.replace(/^@import[^;]+;/m, '')
  document.head.append(sheet)
  try {
    renderApp('/ada/intro')
    await screen.findByRole('heading', { name: 'Intro call' })
    const header = screen.getByRole('banner')
    const language = screen.getByRole('combobox', { name: 'Interface language' })
    const frame = header.parentElement as HTMLElement
    const main = screen.getByRole('main')
    expect(header.contains(language)).toBe(true)
    expect(header.nextElementSibling).toBe(main)
    expect(getComputedStyle(frame).gridTemplateRows).toBe('auto 1fr auto')
    expect(getComputedStyle(header).width).toBe('100%')
    expect(getComputedStyle(header).justifyContent).toBe('flex-end')
    await user.selectOptions(language, 'zh-CN')
    expect(screen.getByRole('combobox', { name: '界面语言' }).closest('header')).toBe(header)
    expect(screen.getByRole('heading', { name: '选择时间' })).toBeDefined()
  } finally {
    sheet.remove()
  }
})

it.each(['en', 'zh-CN'] as const)(
  'omits the embedded language picker while retaining %s document language and branding',
  async (language) => {
    fakeApi({})
    const originalLanguage = document.documentElement.lang
    document.documentElement.lang = language === 'en' ? 'zh-CN' : 'en'
    try {
      render(
        <EmbeddedContext value={true}>
          <EmbedLanguage language={language}>
            <PublicLayout>
              <p>Booking content</p>
            </PublicLayout>
          </EmbedLanguage>
        </EmbeddedContext>,
      )
      const main = screen.getByRole('main')
      const footer = screen.getByRole('contentinfo')
      expect(screen.queryByRole('banner')).toBeNull()
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(main.parentElement?.classList.contains('public-embedded')).toBe(true)
      expect(main.nextElementSibling).toBe(footer)
      expect(document.documentElement.lang).toBe(language)
      const attribution = screen.getByRole('link', {
        name: language === 'en' ? 'Powered by Hourmere' : '由 Hourmere 提供支持',
      })
      expect(attribution.closest('footer')).toBe(footer)
      expect(attribution.getAttribute('href')).toBe('https://hourmere.com')
    } finally {
      document.documentElement.lang = originalLanguage
    }
  },
)

it('removes only embedded outer card chrome and page gutters', () => {
  const sheet = document.createElement('style')
  sheet.textContent = styles + publicStyles.replace(/^@import[^;]+;/m, '')
  document.head.append(sheet)
  const fixture = document.createElement('div')
  fixture.innerHTML = `
    <div class="public public-embedded">
      <main class="public-main">
        <div class="booking-layout"><div class="public-card card">Inner form panel</div></div>
        <div class="public-card card">Confirmation or error</div>
      </main>
    </div>
    <div class="public"><main class="public-main"><div class="booking-layout">Standalone</div></main></div>
  `
  document.body.append(fixture)
  try {
    const frame = fixture.querySelector('.public-embedded') as HTMLElement
    const main = frame.querySelector('.public-main') as HTMLElement
    const preserved = [
      main.querySelector('.booking-layout .card'),
      fixture.querySelector('.public:not(.public-embedded) .booking-layout'),
    ] as HTMLElement[]
    const before = preserved.map((card) => {
      const computed = getComputedStyle(card)
      return [computed.backgroundColor, computed.borderTopWidth, computed.boxShadow]
    })
    sheet.textContent += embedStyles
    expect(getComputedStyle(frame).gridTemplateRows).toBe('1fr auto')
    expect(getComputedStyle(main).padding).toBe('0px')
    const cards = main.querySelectorAll(':scope > .booking-layout, :scope > .public-card')
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      const computed = getComputedStyle(card)
      expect(computed.backgroundColor).toBe('rgba(0, 0, 0, 0)')
      expect(computed.borderTopWidth).toBe('0px')
      expect(computed.borderRadius).toBe('0px')
      expect(computed.boxShadow).toBe('none')
    }
    expect(
      preserved.map((card) => {
        const computed = getComputedStyle(card)
        return [computed.backgroundColor, computed.borderTopWidth, computed.boxShadow]
      }),
    ).toEqual(before)
    const scopedRules = Array.from(sheet.sheet?.cssRules ?? []).filter(
      (rule): rule is CSSStyleRule =>
        'selectorText' in rule && String(rule.selectorText).includes('public-embedded'),
    )
    for (const card of preserved) {
      expect(scopedRules.some((rule) => card.matches(rule.selectorText))).toBe(false)
    }
    // The override stays with the embed entry point, away from ordinary public pages.
    expect(readFileSync('apps/web/src/public/Embed.tsx', 'utf8')).toContain("import './embed.css'")
  } finally {
    fixture.remove()
    sheet.remove()
  }
})
