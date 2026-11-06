import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { fakeApi, PROFILE, profile, renderApp, signedIn } from '../test/fake-api.tsx'

it('follows the account notification language until a top-bar interface language is chosen', async () => {
  const user = userEvent.setup()
  fakeApi({ ...signedIn, ...profile({ ...PROFILE, locale: 'zh-CN' }) })
  renderApp('/app/settings')

  const notificationLanguage = await screen.findByRole<HTMLSelectElement>('combobox', {
    name: '通知语言',
  })
  expect(notificationLanguage.value).toBe('zh-CN')
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('设置')
  expect(localStorage.getItem('hourmere-language')).toBeNull()

  await user.selectOptions(screen.getByRole('combobox', { name: '界面语言' }), 'en')
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings')
  expect(
    screen.getByRole<HTMLSelectElement>('combobox', { name: 'Notification language' }).value,
  ).toBe('zh-CN')
  expect(localStorage.getItem('hourmere-language')).toBe('en')
})
