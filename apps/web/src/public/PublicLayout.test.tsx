import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import styles from '../styles.css?raw'
import { fakeApi, renderApp } from '../test/fake-api.tsx'
import { EVENT, eventRoutes } from '../test/public-fixtures.ts'
import publicStyles from './public.css?raw'

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
