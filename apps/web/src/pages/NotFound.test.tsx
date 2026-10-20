import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { fakeApi, renderApp } from '../test/fake-api.tsx'

describe('the public not-found page', () => {
  it('groups its logo and only language picker in a card header', async () => {
    const api = fakeApi({})
    renderApp('/not/a/page')
    await screen.findByRole('heading', { name: 'Page not found' })
    const picker = screen.getByRole('combobox', { name: 'Interface language' })
    const header = picker.closest('header')
    expect(header?.classList.contains('card-header')).toBe(true)
    expect(header?.querySelector('.logo')?.textContent).toBe('Hourmere')
    expect(header?.parentElement?.classList.contains('card')).toBe(true)
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Go to Hourmere' }).getAttribute('href')).toBe('/app')
    await userEvent.selectOptions(picker, 'zh-CN')
    expect(screen.getByRole('heading', { name: '找不到页面' })).toBeDefined()
    expect(screen.getByRole('combobox', { name: '界面语言' })).toBe(picker)
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(api.to('GET /api/v1/me')).toHaveLength(0)
  })
})
