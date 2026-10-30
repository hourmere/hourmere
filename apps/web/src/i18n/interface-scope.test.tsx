import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { fakeApi, PROFILE, profile, renderApp, signedIn } from '../test/fake-api.tsx'
import { AccountLanguage, InterfaceScope, LanguageSwitcher, useI18n } from './runtime.tsx'
import { chooseLanguage } from './store.ts'

function Notice() {
  const { locale, formatLocale, t, setLanguage } = useI18n()
  return (
    <>
      <LanguageSwitcher />
      <output data-testid="locale">{locale}</output>
      <output data-testid="format">{formatLocale}</output>
      <p>{t('Your details')}</p>
      <button type="button" onClick={() => setLanguage('de')}>
        request public language
      </button>
    </>
  )
}

describe('interface catalogue scope', () => {
  it.each(['explicit', 'browser', 'account'] as const)(
    'falls back within the admin scope for a public-only %s preference',
    async (source) => {
      if (source === 'explicit') chooseLanguage('de')
      if (source === 'browser') vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-CH'])
      render(
        <InterfaceScope surface="admin">
          <AccountLanguage locale={source === 'account' ? 'de-AT' : undefined}>
            <Notice />
          </AccountLanguage>
        </InterfaceScope>,
      )
      expect(screen.getByTestId('locale').textContent).toBe('en')
      expect(screen.getByText('Your details')).toBeDefined()
      expect(
        [...screen.getByLabelText<HTMLSelectElement>('Interface language').options].map(
          ({ value }) => value,
        ),
      ).toEqual(['en', 'zh-CN'])
      await userEvent.click(screen.getByRole('button', { name: 'request public language' }))
      expect(screen.getByTestId('locale').textContent).toBe('en')
      if (source === 'explicit') expect(localStorage.getItem('hourmere-language')).toBe('de')
      else expect(localStorage.getItem('hourmere-language')).toBeNull()
    },
  )

  it('uses the next supported browser language within the admin scope', () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-CH', 'zh-CN'])
    render(
      <InterfaceScope surface="admin">
        <Notice />
      </InterfaceScope>,
    )
    expect(screen.getByTestId('locale').textContent).toBe('zh-CN')
    expect(screen.getByText('你的信息')).toBeDefined()
  })

  it.each(['/app/settings', '/APP/settings', '/%61pp/settings'])(
    'retains a public preference while navigating the real admin scope at %s',
    async (path) => {
      chooseLanguage('de')
      fakeApi({ ...signedIn, ...profile({ ...PROFILE, locale: 'de-AT' }) })
      renderApp(path)
      await screen.findByRole('heading', { name: 'Settings' })
      await waitFor(() =>
        expect(document.querySelector<HTMLSelectElement>('.language-picker select')?.value).toBe(
          'en',
        ),
      )
      expect(
        [...screen.getByLabelText<HTMLSelectElement>('Interface language').options].map(
          ({ value }) => value,
        ),
      ).toEqual(['en', 'zh-CN'])
      const notificationLanguage =
        await screen.findByLabelText<HTMLSelectElement>('Notification language')
      expect([...notificationLanguage.options].map(({ value }) => value)).toContain('de')
      expect(localStorage.getItem('hourmere-language')).toBe('de')
    },
  )

  it('keeps German in the public scope with German formatting and per-key English fallback', () => {
    chooseLanguage('de')
    render(<Notice />)
    expect(screen.getByTestId('locale').textContent).toBe('de')
    expect(screen.getByTestId('format').textContent).toBe('de-DE')
    expect(screen.getByText('Ihre Angaben')).toBeDefined()
  })
})
