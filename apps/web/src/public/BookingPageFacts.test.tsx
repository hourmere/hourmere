import { screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { fakeApi, json, renderApp } from '../test/fake-api.tsx'
import { EVENT, slotsAnswer, TOKEN } from '../test/public-fixtures.ts'

vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => 'UTC',
  now: () => Date.parse('2026-11-01T04:30:00Z'),
}))

const pages = [
  { kind: 'personal', path: '/ada/intro', endpoint: '/api/v1/public/ada/intro', event: EVENT },
  {
    kind: 'team',
    path: '/team/crew/intro',
    endpoint: '/api/v1/public/teams/crew/intro',
    event: { ...EVENT, team: { name: 'Crew', slug: 'crew' } },
  },
  {
    kind: 'one-time',
    path: `/book/${TOKEN}`,
    endpoint: `/api/v1/book/${TOKEN}`,
    event: { eventType: EVENT },
  },
]

function expectDecorativeIcon(icon: Element | null | undefined) {
  expect(icon?.tagName).toBe('svg')
  expect(icon?.classList.contains('booking-fact-icon')).toBe(true)
  expect(icon?.getAttribute('aria-hidden')).toBe('true')
  expect(icon?.getAttribute('focusable')).toBe('false')
}

describe.each([
  {
    language: 'en',
    summary: 'About this event',
    facts: ['30 min', 'Phone call', "Host's time zone: Europe/Berlin"],
    picker: /^Time zone/,
  },
  {
    language: 'zh-CN',
    summary: '关于此活动',
    facts: ['30 分钟', '电话会议', '主持人的时区：Europe/Berlin'],
    picker: /^时区/,
  },
])('booking metadata in $language', ({ language, summary, facts, picker }) => {
  it.each(pages)('keeps the text and shows decorative icons on the $kind page', async (page) => {
    localStorage.setItem('hourmere-language', language)
    fakeApi({
      [`GET ${page.endpoint}`]: () => json(200, page.event),
      [`GET ${page.endpoint}/slots`]: slotsAnswer(['2026-11-02T14:00:00Z']),
    })
    renderApp(page.path)

    const info = await screen.findByRole('complementary', { name: summary })
    const rows = within(info).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual(facts)
    for (const row of rows) {
      expectDecorativeIcon(row.firstElementChild)
      expect(row.lastElementChild?.tagName).toBe('SPAN')
    }

    const toggle = screen.getByRole('button', { name: picker })
    expectDecorativeIcon(toggle.querySelector('.tz-caption')?.firstElementChild)
  })
})
