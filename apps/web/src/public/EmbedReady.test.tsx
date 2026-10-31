import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appRoutes } from '../App.tsx'
import { fakeApi, json, later, renderApp } from '../test/fake-api.tsx'
import { EVENT, slotsAnswer } from '../test/public-fixtures.ts'

vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => 'America/New_York',
  preferredLocale: () => 'en-US',
  now: () => Date.parse('2026-11-01T04:30:00Z'),
}))

const QUERY = '?parentOrigin=https%3A%2F%2Fparent.example&embedId=abcdefghijklmnop1234'
const PERSONAL = '/embed/ada/intro'
const TEAM = '/embed/team/Alpha/intro'
const PERSONAL_API = '/api/v1/public/ada/intro'
const TEAM_API = '/api/v1/public/teams/Alpha/intro'

function parent(path: string) {
  const postMessage = vi.fn()
  window.history.replaceState(null, '', `${path}${QUERY}`)
  vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage } as unknown as Window)
  return postMessage
}

const ready = (postMessage: ReturnType<typeof vi.fn>) =>
  postMessage.mock.calls.filter(([data]) => data.type === 'hourmere:ready')

function expectReady(postMessage: ReturnType<typeof vi.fn>, allowEmbedParent: boolean) {
  const messages = ready(postMessage)
  expect(messages.length).toBeGreaterThan(0)
  for (const message of messages)
    expect(message).toEqual([
      { type: 'hourmere:ready', id: 'abcdefghijklmnop1234', allowEmbedParent },
      'https://parent.example',
    ])
}

beforeEach(() => window.history.replaceState(null, '', '/'))

describe('readiness for every embedded route outcome', () => {
  it('enumerates both dedicated embed routes from the actual router', () => {
    expect(
      appRoutes.filter(({ path }) => path?.startsWith('/embed/')).map(({ path }) => path),
    ).toEqual(['/embed/team/:teamSlug/:slug', '/embed/:handle/:slug'])
  })

  // The team route shares BookingPage for individual, collective and round-robin events.
  it.each([
    [PERSONAL, PERSONAL_API, undefined, false],
    [PERSONAL, PERSONAL_API, undefined, true],
    [TEAM, TEAM_API, 'individual', false],
    [TEAM, TEAM_API, 'individual', true],
    [TEAM, TEAM_API, 'collective', false],
    [TEAM, TEAM_API, 'collective', true],
    [TEAM, TEAM_API, 'round_robin', false],
    [TEAM, TEAM_API, 'round_robin', true],
  ] as const)(
    'waits for saved settings at %s (%s, %s), then announces opt-in %s',
    async (path, endpoint, schedulingType, allowEmbedParentRedirect) => {
      const postMessage = parent(path)
      const pending = later()
      const api = fakeApi({
        [`GET ${endpoint}`]: () => pending.response,
        [`GET ${endpoint}/slots`]: slotsAnswer([]),
      })
      renderApp(`${path}${QUERY}`)
      await waitFor(() => expect(api.to(`GET ${endpoint}`)).toHaveLength(1))
      expect(screen.getByText('Loading…')).toBeDefined()
      expect(ready(postMessage)).toEqual([])
      await pending.answer(
        json(200, {
          ...EVENT,
          ...(schedulingType
            ? { handle: 'Alpha', team: { name: 'Alpha Team', slug: 'Alpha' }, schedulingType }
            : {}),
          allowEmbedParentRedirect,
        }),
      )
      await screen.findByRole('heading', { name: 'Intro call' })
      await waitFor(() => expectReady(postMessage, allowEmbedParentRedirect))
    },
  )

  it.each([
    [PERSONAL, PERSONAL_API, 404, 'event_type_not_found'],
    [TEAM, TEAM_API, 404, 'event_type_not_found'],
    [PERSONAL, PERSONAL_API, 503, 'internal_error'],
    [TEAM, TEAM_API, 503, 'internal_error'],
  ] as const)(
    'announces restrictive readiness for unavailable %s (%s, %s, %s)',
    async (path, endpoint, status, error) => {
      const postMessage = parent(path)
      fakeApi({ [`GET ${endpoint}`]: () => json(status, { error }) })
      renderApp(`${path}${QUERY}`)
      if (status === 404)
        await screen.findByRole('heading', { name: 'This booking page doesn’t exist' })
      else await screen.findByRole('button', { name: 'Try again' })
      await waitFor(() => expectReady(postMessage, false))
    },
  )

  it.each(['/embed/ada/invalid!', '/embed/team/Alpha/invalid!'])(
    'announces restrictive readiness for the non-booking page at %s',
    async (path) => {
      const postMessage = parent(path)
      const api = fakeApi({})
      renderApp(`${path}${QUERY}`)
      await screen.findByRole('heading', { name: 'This booking page doesn’t exist' })
      await waitFor(() => expectReady(postMessage, false))
      expect(api.calls.filter(({ path }) => path.startsWith('/api/v1/public/'))).toEqual([])
    },
  )

  it('announces restrictive readiness for an unmatched embed address', async () => {
    const path = '/embed/ada/intro/extra'
    const postMessage = parent(path)
    fakeApi({})
    renderApp(`${path}${QUERY}`)
    await screen.findByRole('heading', { name: 'Page not found' })
    await waitFor(() => expectReady(postMessage, false))
  })

  it.each(['/ada/invalid!', '/unknown/address/extra'])(
    'keeps ordinary not-found pages silent at %s',
    async (path) => {
      const postMessage = parent(path)
      fakeApi({})
      renderApp(`${path}${QUERY}`)
      await screen.findByRole('heading')
      expect(ready(postMessage)).toEqual([])
    },
  )
})
