import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'
import { chooseLanguage } from './i18n/store.ts'
import { fakeApi, PROFILE, profile, signedIn } from './test/fake-api.tsx'

const { pageBehavior } = vi.hoisted(() => ({ pageBehavior: { interactive: false } }))
vi.mock('./pages/event-types/EventTypes.tsx', () => ({
  EventTypesPage: () => {
    throw new Error('Broken account page')
  },
}))
vi.mock('./public/BookingPage.tsx', async () => {
  const { useState } = await import('react')
  const { LanguageSwitcher } = await import('./i18n/runtime.tsx')
  return {
    BookingPage: () => {
      const [failed, setFailed] = useState(false)
      if (!pageBehavior.interactive || failed) throw new Error('Broken embedded page')
      return (
        <>
          <LanguageSwitcher />
          <button type="button" onClick={() => setFailed(true)}>
            Break page
          </button>
        </>
      )
    },
    TeamBookingPage: () => {
      throw new Error('Broken team page')
    },
  }
})

beforeEach(() => {
  pageBehavior.interactive = false
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US'])
})
afterEach(() => window.history.replaceState(null, '', '/'))

function open(path: string) {
  window.history.replaceState(null, '', path)
  render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
    { onCaughtError: vi.fn() },
  )
}

describe('route error recovery language scopes', () => {
  it('keeps an account-default Chinese fallback on an English browser', async () => {
    fakeApi({ ...signedIn, ...profile({ ...PROFILE, locale: 'zh-CN' }) })
    open('/app/event-types')
    expect(await screen.findByRole('heading', { name: '出错了' })).toBeDefined()
    expect(screen.getByRole('button', { name: '重新加载' })).toBeDefined()
    expect(localStorage.getItem('hourmere-language')).toBeNull()
  })

  it('honors explicit English before an account-default Chinese fallback', async () => {
    chooseLanguage('en')
    fakeApi({ ...signedIn, ...profile({ ...PROFILE, locale: 'zh-CN' }) })
    open('/app/event-types')
    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined()
  })

  it.each(['/embed/ada/meeting', '/embed/team/alpha/meeting'])(
    'keeps the Chinese embed query language when %s fails to render',
    async (path) => {
      fakeApi({})
      open(`${path}?language=zh-CN`)
      expect(await screen.findByRole('heading', { name: '出错了' })).toBeDefined()
      expect(screen.getByRole('button', { name: '重新加载' })).toBeDefined()
      expect(localStorage.getItem('hourmere-language')).toBeNull()
    },
  )

  it('preserves a loaded embed’s switched language when rendering later fails', async () => {
    pageBehavior.interactive = true
    const user = userEvent.setup()
    fakeApi({})
    open('/embed/ada/meeting?language=zh-CN')
    await user.selectOptions(await screen.findByRole('combobox', { name: '界面语言' }), 'en')
    await user.click(screen.getByRole('button', { name: 'Break page' }))
    expect(await screen.findByRole('heading', { name: 'Something went wrong' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined()
  })
})
