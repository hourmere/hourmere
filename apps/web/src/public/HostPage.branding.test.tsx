import { brandPalette } from '@hourmere/core/brand-contrast'
import { screen, within } from '@testing-library/react'
import { beforeAll, expect, it } from 'vitest'
import { fakeApi, json, renderApp } from '../test/fake-api.tsx'
import { EVENT } from '../test/public-fixtures.ts'

beforeAll(async () => {
  await import('./HostPage.tsx')
})

it('shows each event’s owning brand and team name without removing personal or team links', async () => {
  const personal = { name: 'Ada', primaryColor: '#AABBCC', logoUrl: null, logoDataUrl: null }
  const team = {
    name: 'Consulting team',
    primaryColor: '#123456',
    logoDataUrl: null,
    logoUrl: `/api/v1/public/branding/00000000-0000-7000-8000-000000000001/logo/${'a'.repeat(64)}`,
  }
  fakeApi({
    'GET /api/v1/public/ada': () =>
      json(200, {
        handle: 'ada',
        host: EVENT.host,
        branding: personal,
        eventTypes: [
          { ...EVENT, slug: 'personal', title: 'Personal call', branding: personal },
          {
            ...EVENT,
            slug: 'team',
            title: 'Team call',
            branding: team,
            organizationName: team.name,
          },
          { ...EVENT, slug: 'default', title: 'Default call', organizationName: 'Unbranded team' },
        ],
      }),
  })
  renderApp('/ada')
  await screen.findByRole('heading', { name: 'Ada Lovelace' })
  const personalLink = screen.getByRole('link', { name: /Personal call/ })
  const teamLink = screen.getByRole('link', { name: /Team call/ })
  const defaultLink = screen.getByRole('link', { name: /Default call/ })
  expect(personalLink.getAttribute('href')).toBe('/ada/personal')
  expect(teamLink.getAttribute('href')).toBe('/ada/team')
  expect(defaultLink.getAttribute('href')).toBe('/ada/default')
  expect(within(teamLink).getByText('Consulting team')).toBeDefined()
  expect(within(teamLink).getByRole('img', { name: team.name }).getAttribute('src')).toBe(
    team.logoUrl,
  )
  for (const theme of ['light', 'dark'] as const) {
    expect(personalLink.style.getPropertyValue(`--event-brand-${theme}-link`)).toBe(
      brandPalette(personal.primaryColor)?.[theme].link,
    )
    expect(teamLink.style.getPropertyValue(`--event-brand-${theme}-link`)).toBe(
      brandPalette(team.primaryColor)?.[theme].link,
    )
    expect(defaultLink.style.getPropertyValue(`--event-brand-${theme}-link`)).toBe('')
  }
  expect(defaultLink.classList.contains('event-card-own-brand')).toBe(true)
  expect(within(defaultLink).queryByRole('img')).toBeNull()
})
