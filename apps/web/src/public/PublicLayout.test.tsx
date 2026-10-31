/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { interfaceLanguages, localeRegistry, registeredLocales } from '@hourmere/core/language'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EmbedLanguage, InterfaceScope, LanguageSwitcher } from '../i18n/runtime.tsx'
import { resetLanguagePreference } from '../i18n/store.ts'
import styles from '../styles.css?raw'
import { fakeApi, renderApp } from '../test/fake-api.tsx'
import { EVENT, eventRoutes } from '../test/public-fixtures.ts'
import { selectPublicLanguage } from '../test/public-language.ts'
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

  it('creates and reuses the grapheme segmenter only when initials need it', async () => {
    const segmenter = vi.spyOn(Intl, 'Segmenter')
    vi.resetModules()
    const { hostInitials: initials } = await import('./PublicLayout.tsx')
    expect(segmenter).not.toHaveBeenCalled()
    expect(initials('')).toBe('?')
    expect(segmenter).not.toHaveBeenCalled()
    expect(initials('e\u0301lodie 👩🏽‍💻')).toBe('E\u0301👩🏽‍💻')
    expect(segmenter).toHaveBeenCalledExactlyOnceWith(undefined, { granularity: 'grapheme' })
    expect(initials('Ada Lovelace')).toBe('AL')
    expect(segmenter).toHaveBeenCalledTimes(1)
  })

  it('loads and renders public content with code-point initials without Intl.Segmenter', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined })
    vi.resetModules()
    try {
      const imported = import('./PublicLayout.tsx')
      await expect(imported).resolves.toHaveProperty('PublicLayout')
      const { hostInitials: initials, HostAvatar: Avatar, PublicLayout: Layout } = await imported
      expect(() => initials('Ada Lovelace')).not.toThrow()
      expect(initials('Ada Lovelace')).toBe('AL')
      expect(initials('e\u0301lodie dubois')).toBe('ED')
      expect(initials('👩🏽‍💻 Rivera')).toBe('👩R')
      expect(initials('王 小明')).toBe('王小')
      expect(initials(' \t\n ')).toBe('?')
      fakeApi({})
      render(
        <Layout>
          <h1>Booking content</h1>
          <Avatar name="👩🏽‍💻 Rivera" />
        </Layout>,
      )
      const main = screen.getByRole('main')
      expect(main.contains(screen.getByRole('heading', { name: 'Booking content' }))).toBe(true)
      expect(main.querySelector('.host-avatar')?.textContent).toBe('👩R')
      expect(screen.getByRole('link', { name: 'Powered by Hourmere' })).toBeDefined()
    } finally {
      if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor)
    }
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
    const language = screen.getByRole('button', { name: 'Language: English' })
    const frame = header.parentElement as HTMLElement
    const main = screen.getByRole('main')
    expect(header.contains(language)).toBe(true)
    expect(header.nextElementSibling).toBe(main)
    expect(getComputedStyle(frame).gridTemplateRows).toBe('auto 1fr auto')
    expect(getComputedStyle(header).width).toBe('100%')
    expect(getComputedStyle(header).justifyContent).toBe('flex-end')
    await selectPublicLanguage(user, 'zh-CN')
    expect(screen.getByRole('button', { name: '语言：简体中文' }).closest('header')).toBe(header)
    expect(screen.getByRole('heading', { name: '选择时间' })).toBeDefined()
  } finally {
    sheet.remove()
  }
})

describe('compact public language menu', () => {
  function showPicker() {
    fakeApi({})
    return render(
      <PublicLayout>
        <button type="button">Continue booking</button>
      </PublicLayout>,
    )
  }

  it('names the current language and marks it visibly and for assistive technology', async () => {
    const user = userEvent.setup()
    showPicker()
    const trigger = screen.getByRole('button', { name: 'Language: English' })
    expect(trigger.textContent).toContain('English')
    expect(trigger.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Interface language')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: 'Language: English' })
    expect(trigger.getAttribute('aria-controls')).toBe(menu.id)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const options = within(menu).getAllByRole('menuitemradio')
    expect(options).toHaveLength(interfaceLanguages('public').length)
    for (const { code, nativeName } of registeredLocales) {
      if (!interfaceLanguages('public').includes(code)) continue
      const option = within(menu).getByRole('menuitemradio', { name: nativeName })
      expect(option.getAttribute('lang')).toBe(code)
      expect(option.getAttribute('aria-checked')).toBe(code === 'en' ? 'true' : 'false')
    }
    const current = within(menu).getByRole('menuitemradio', { checked: true })
    expect(current.textContent).toContain('English')
    expect(current.querySelector('[aria-hidden="true"]')?.textContent).toContain('✓')
    expect(document.activeElement).toBe(current)
  })

  it.each(['{Enter}', ' '])(
    'opens with %j and Escape restores focus to the trigger',
    async (key) => {
      const user = userEvent.setup()
      showPicker()
      const trigger = screen.getByRole('button', { name: 'Language: English' })
      trigger.focus()
      await user.keyboard(key)
      expect(screen.getByRole('menu')).toBeDefined()
      expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { checked: true }))
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('menu')).toBeNull()
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(document.activeElement).toBe(trigger)
    },
  )

  it('closes the menu when Shift+Tab leaves the first option for the trigger', async () => {
    const user = userEvent.setup()
    showPicker()
    const trigger = screen.getByRole('button', { name: 'Language: English' })
    trigger.focus()
    await user.keyboard('{Enter}')
    await user.keyboard('{Home}')
    expect(document.activeElement).toBe(screen.getAllByRole('menuitemradio')[0])
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it.each(['{ArrowDown}', '{ArrowUp}'])(
    'opens on the current language with %s and navigates all options with wrapping',
    async (key) => {
      const user = userEvent.setup()
      localStorage.setItem('hourmere-language', 'zh-CN')
      showPicker()
      screen.getByRole('button', { name: '语言：简体中文' }).focus()
      await user.keyboard(key)
      expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: '简体中文' }))
      const options = screen.getAllByRole('menuitemradio')
      await user.keyboard('{End}')
      expect(document.activeElement).toBe(options.at(-1))
      await user.keyboard('{ArrowDown}')
      expect(document.activeElement).toBe(options[0])
      await user.keyboard('{ArrowUp}')
      expect(document.activeElement).toBe(options.at(-1))
      await user.keyboard('{Home}')
      expect(document.activeElement).toBe(options[0])
      await user.keyboard('{ArrowDown}')
      expect(document.activeElement).toBe(options[1])
    },
  )

  it('selects a language by keyboard, closes and returns focus to the translated trigger', async () => {
    const user = userEvent.setup()
    showPicker()
    screen.getByRole('button', { name: 'Language: English' }).focus()
    await user.keyboard('{Enter}{ArrowDown}{Enter}')
    expect(screen.queryByRole('menu')).toBeNull()
    const trigger = screen.getByRole('button', { name: '语言：简体中文' })
    expect(document.activeElement).toBe(trigger)
    expect(trigger.textContent).toContain('简体中文')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.documentElement.dir).toBe('ltr')
  })

  it.each(interfaceLanguages('public'))(
    'selects and persists every shipped public language (%s)',
    async (code) => {
      const user = userEvent.setup()
      const first = showPicker()
      await selectPublicLanguage(user, code)
      expect(screen.queryByRole('menu')).toBeNull()
      const trigger = within(screen.getByRole('banner')).getByRole('button')
      expect(trigger.textContent).toContain(localeRegistry[code].nativeName)
      expect(document.activeElement).toBe(trigger)
      expect(localStorage.getItem('hourmere-language')).toBe(code)
      expect(document.cookie.split('; ').includes(`hourmere-language=${code}`)).toBe(true)
      expect(document.documentElement.lang).toBe(code)
      first.unmount()
      resetLanguagePreference()
      showPicker()
      const restored = within(screen.getByRole('banner')).getByRole('button')
      expect(restored.textContent).toContain(localeRegistry[code].nativeName)
      await user.click(restored)
      expect(
        screen.getByRole('menuitemradio', { name: localeRegistry[code].nativeName, checked: true }),
      ).toBeDefined()
    },
  )

  it('lets Tab leave the menu and closes without stealing focus', async () => {
    const user = userEvent.setup()
    showPicker()
    await user.click(screen.getByRole('button', { name: 'Language: English' }))
    for (let count = 0; count < interfaceLanguages('public').length; count++) {
      if (!screen.queryByRole('menu')) break
      await user.tab()
    }
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Continue booking' }))
  })

  it('closes when the trigger is tapped again or a touch starts outside', async () => {
    const user = userEvent.setup()
    showPicker()
    const trigger = screen.getByRole('button', { name: 'Language: English' })
    await user.pointer([{ keys: '[TouchA]', target: trigger }])
    expect(screen.getByRole('menu')).toBeDefined()
    await user.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
    await user.click(trigger)
    // A touch on non-focusable content must dismiss even without a focusin event.
    fireEvent.pointerDown(screen.getByRole('main'), { pointerType: 'touch' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('retains the existing admin select and its permanent label', async () => {
    const user = userEvent.setup()
    render(
      <InterfaceScope surface="admin">
        <LanguageSwitcher compact />
      </InterfaceScope>,
    )
    const select = screen.getByRole('combobox', { name: 'Interface language' })
    expect(screen.getByText('Interface language')).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['English', '简体中文'])
    await user.selectOptions(select, 'zh-CN')
    expect(screen.getByRole('combobox', { name: '界面语言' })).toBe(select)
  })
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
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.queryByRole('menu')).toBeNull()
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
