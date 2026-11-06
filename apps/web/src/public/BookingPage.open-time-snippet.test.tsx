import { execFileSync } from 'node:child_process'
import { screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeApi, json, renderApp } from '../test/fake-api.tsx'
import { EVENT } from '../test/public-fixtures.ts'

vi.mock('./env.ts', async (original) => ({
  ...(await original<typeof import('./env.ts')>()),
  detectTimeZone: () => 'UTC',
  preferredLocale: () => 'en-US',
  now: () => Date.parse('2030-03-01T00:00:00Z'),
}))

const bootstrap = process.env.DATABASE_URL

describe.skipIf(!bootstrap)('generated open-time snippet direct links', () => {
  let fixture: {
    suggested: { start: string; end: string; url: string }
    available: { start: string; end: string }[]
    mutatedUrl: string
  }
  beforeAll(() => {
    fixture = JSON.parse(
      execFileSync(process.execPath, ['scripts/open-time-snippet-web-fixture.ts'], {
        encoding: 'utf8',
        timeout: 30_000,
      }),
    )
  })
  async function verifyTakenLink(mutate = false) {
    const { suggested, available, mutatedUrl } = fixture
    expect(available.some((slot) => slot.start === suggested.start)).toBe(false)
    const url = new URL(mutate ? mutatedUrl : suggested.url)
    const api = fakeApi({
      'GET /api/v1/public/ada/intro': () =>
        json(200, { ...EVENT, host: { ...EVENT.host, timeZone: 'UTC' } }),
      'GET /api/v1/public/ada/intro/slots': async ({ path }) => {
        const query = new URL(path, 'https://example.test').searchParams
        const data = available.filter(
          (slot) =>
            Date.parse(slot.start) >= Date.parse(query.get('start') ?? '') &&
            Date.parse(slot.end) <= Date.parse(query.get('end') ?? ''),
        )
        return json(200, { data })
      },
    })
    const view = renderApp(url.pathname + url.search)
    try {
      await waitFor(() =>
        expect(
          screen.queryByText('That time is no longer available. Please pick another one.'),
        ).not.toBeNull(),
      )
      await screen.findByRole('heading', { name: 'Pick a time' })
      expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
      expect(await screen.findByRole('button', { name: '9:30 AM' })).toBeDefined()
      expect(api.calls.every((call) => call.method === 'GET')).toBe(true)
      expect(
        api.calls.some((call) => {
          const query = new URL(call.path, 'https://example.test').searchParams
          return (
            Date.parse(query.get('start') ?? '') === Date.parse(suggested.start) &&
            Date.parse(query.get('end') ?? '') === Date.parse(suggested.end)
          )
        }),
      ).toBe(true)
    } finally {
      view.unmount()
    }
  }
  it('opens a service-generated link after its slot is taken and offers another real time', () =>
    verifyTakenLink())
  it('kills a source-copy formatter that omits the direct-link start', async () => {
    await expect(verifyTakenLink(true)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
