import { describe, expect, it } from 'vitest'
import { assertCachedCalendarSync, type CachedCalendarSync } from './availability.ts'
import {
  evaluateGoogleWriteDestination,
  evaluateZoomConnection,
  type GoogleWriteDestinationFacts,
  type ZoomConnectionFacts,
} from './conferences.ts'
import { eligibleHostIds, hasValidHostShape } from './hosts.ts'

describe('shared cached host configuration facts', () => {
  it.each([
    ['individual', [], false],
    ['individual', ['a'], true],
    ['individual', ['a', 'b'], false],
    ['collective', ['a'], false],
    ['collective', ['a', 'b'], true],
    ['collective', Array.from({ length: 8 }, (_, i) => String(i)), true],
    ['collective', Array.from({ length: 9 }, (_, i) => String(i)), false],
    ['round_robin', [], false],
    ['round_robin', ['a'], true],
    ['round_robin', Array.from({ length: 8 }, (_, i) => String(i)), true],
    ['round_robin', Array.from({ length: 9 }, (_, i) => String(i)), false],
    ['collective', ['a', 'a'], false],
    ['unknown', ['a'], false],
  ] as const)('checks %s host shape %j', (mode, ids, valid) => {
    expect(hasValidHostShape(mode, ids)).toBe(valid)
  })

  it('filters only configured verified members of the exact current organization', () => {
    const users = [
      { id: 'b', emailVerified: true },
      { id: 'a', emailVerified: true },
      { id: 'unverified', emailVerified: false },
      { id: 'removed', emailVerified: true },
      { id: 'other-team', emailVerified: true },
      { id: 'not-configured', emailVerified: true },
    ]
    const members = [
      ...['a', 'b', 'unverified', 'deleted-user', 'not-configured'].map((userId) => ({
        userId,
        organizationId: 'team',
      })),
      { userId: 'other-team', organizationId: 'other' },
    ]
    expect(
      eligibleHostIds(
        'team',
        ['b', 'a', 'a', 'unverified', 'removed', 'other-team', 'deleted-user'],
        users,
        members,
      ),
    ).toEqual(['a', 'b'])
    expect(eligibleHostIds('team', [], users, members)).toEqual([])
    expect(
      eligibleHostIds(
        'team',
        Array.from({ length: 9 }, (_, i) => String(i)),
        users,
        members,
      ),
    ).toEqual([])
  })
})

describe('shared cached calendar synchronization guard', () => {
  const now = Temporal.Instant.from('2026-11-01T12:00Z')
  const snapshot = () => ({
    version: 2,
    timeZone: 'UTC',
    start: '2026-11-01T00:00Z',
    end: '2026-11-02T00:00Z',
  })
  const healthy = (): CachedCalendarSync => ({
    status: 'active',
    last_synced_at: new Date(now.epochMilliseconds),
    sync_state: snapshot(),
    sync_error: null,
    time_zone: 'UTC',
  })

  it('allows no selected conflict calendars and complete healthy cached metadata', () => {
    expect(() => assertCachedCalendarSync([], now)).not.toThrow()
    expect(() => assertCachedCalendarSync([healthy()], now)).not.toThrow()
  })

  it('checks exact requested coverage only when a window is supplied', () => {
    const calendar = healthy()
    expect(() =>
      assertCachedCalendarSync([calendar], now, {
        start: Temporal.Instant.from('2026-11-01T00:00Z'),
        end: Temporal.Instant.from('2026-11-02T00:00Z'),
      }),
    ).not.toThrow()
    for (const window of [
      { start: '2026-10-31T23:59Z', end: '2026-11-02T00:00Z' },
      { start: '2026-11-01T00:00Z', end: '2026-11-02T00:01Z' },
    ])
      expect(() =>
        assertCachedCalendarSync([calendar], now, {
          start: Temporal.Instant.from(window.start),
          end: Temporal.Instant.from(window.end),
        }),
      ).toThrowError(expect.objectContaining({ code: 'calendar_sync_unavailable' }))
  })

  it.each([
    ['inactive connection', { status: 'needs_reauth' }],
    ['known sync error', { sync_error: 'provider_unavailable' }],
    ['no successful snapshot', { last_synced_at: null }],
    ['stale success', { last_synced_at: new Date(now.epochMilliseconds - 600_001) }],
    ['future success', { last_synced_at: new Date(now.epochMilliseconds + 60_001) }],
    ['missing snapshot', { sync_state: null }],
    ['array snapshot', { sync_state: [] }],
    ['scalar snapshot', { sync_state: 'unknown' }],
    ['old snapshot', { sync_state: { ...snapshot(), version: 1 } }],
    ['changed zone', { time_zone: 'Europe/London' }],
    ['missing boundary', { sync_state: { version: 2, timeZone: 'UTC' } }],
    ['invalid boundary', { sync_state: { ...snapshot(), start: 'invalid' } }],
    ['reversed boundary', { sync_state: { ...snapshot(), start: '2026-11-03T00:00Z' } }],
    ['empty boundary', { sync_state: { ...snapshot(), start: '2026-11-02T00:00Z' } }],
  ] satisfies [string, Partial<CachedCalendarSync>][])(
    'rejects %s without a slot range',
    (_name, changed) => {
      expect(() => assertCachedCalendarSync([{ ...healthy(), ...changed }], now)).toThrowError(
        expect.objectContaining({ code: 'calendar_sync_unavailable' }),
      )
    },
  )

  it('preserves inclusive freshness and future-clock tolerance boundaries', () => {
    for (const offset of [-600_000, 60_000])
      expect(() =>
        assertCachedCalendarSync(
          [{ ...healthy(), last_synced_at: new Date(now.epochMilliseconds + offset) }],
          now,
        ),
      ).not.toThrow()
  })

  it('propagates unexpected fact access failures instead of treating them as availability', () => {
    const failure = new Error('unexpected cached read failure')
    const calendar = healthy()
    Object.defineProperty(calendar, 'sync_state', {
      get() {
        throw failure
      },
    })
    expect(() => assertCachedCalendarSync([calendar], now)).toThrow(failure)
  })
})

describe('shared cached automatic conference eligibility', () => {
  const destination = (): GoogleWriteDestinationFacts => ({
    destination: 'calendar',
    calendar_id: 'calendar',
    connection_id: 'connection',
    provider: 'google',
    status: 'active',
    access_role: 'owner',
    supports_google_meet: true,
    scopes: [
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ],
  })
  const zoom = (): ZoomConnectionFacts => ({
    id: 'zoom-connection',
    user_id: 'host',
    provider: 'zoom',
    external_user_id: 'zoom-host',
    mode: 'meetings',
    status: 'active',
    scopes: [
      'user:read:user',
      'meeting:write:meeting',
      'meeting:read:meeting',
      'meeting:update:meeting',
      'meeting:delete:meeting',
    ],
  })

  it('shares Google Meet eligibility with ordinary writeback and preserves optional capability', () => {
    expect(evaluateGoogleWriteDestination(destination(), true)).toEqual({
      eligible: true,
      calendar_id: 'calendar',
      connection_id: 'connection',
    })
    expect(
      evaluateGoogleWriteDestination({ ...destination(), supports_google_meet: false }),
    ).toMatchObject({ eligible: true })
    expect(evaluateGoogleWriteDestination(undefined, true)).toEqual({
      eligible: false,
      reason: 'not_configured',
    })
  })

  it.each([
    [{ destination: null }, 'not_configured'],
    [{ calendar_id: null }, 'calendar_unavailable'],
    [{ connection_id: null }, 'calendar_unavailable'],
    [{ provider: 'microsoft' }, 'unsupported_provider'],
    [{ status: 'needs_reauth' }, 'needs_reauth'],
    [{ access_role: 'writer' }, 'permissions_missing'],
    [{ scopes: null }, 'permissions_missing'],
    [{ scopes: ['https://www.googleapis.com/auth/calendar.events.owned'] }, 'permissions_missing'],
    [{ supports_google_meet: false }, 'meet_unsupported'],
  ] satisfies [Partial<GoogleWriteDestinationFacts>, string][])(
    'rejects unavailable explicit Meet destination %j',
    (changed, reason) => {
      expect(evaluateGoogleWriteDestination({ ...destination(), ...changed }, true)).toEqual({
        eligible: false,
        reason,
      })
    },
  )

  it('checks pinned Zoom ownership and supports refreshing only when explicitly allowed', () => {
    expect(evaluateZoomConnection('host', 'zoom-connection', zoom())).toEqual({
      eligible: true,
      zoom_connection_id: 'zoom-connection',
      zoom_user_id: 'zoom-host',
    })
    expect(
      evaluateZoomConnection('host', 'zoom-connection', { ...zoom(), status: 'refreshing' }, true),
    ).toMatchObject({ eligible: true })
    expect(evaluateZoomConnection('host', null, zoom())).toEqual({ eligible: false })
    expect(evaluateZoomConnection('host', 'zoom-connection', undefined)).toEqual({
      eligible: false,
    })
  })

  it.each([
    { id: 'another-connection' },
    { user_id: 'another-user' },
    { user_id: null },
    { provider: 'another-provider' },
    { status: 'refreshing' },
    { status: 'needs_reauth' },
    { mode: 'identity' },
    { external_user_id: null },
    { scopes: [] },
    { scopes: zoom().scopes.toReversed() },
    { scopes: [...zoom().scopes, 'unexpected:scope'] },
  ])('rejects unavailable Zoom facts %j', (changed) => {
    expect(evaluateZoomConnection('host', 'zoom-connection', { ...zoom(), ...changed })).toEqual({
      eligible: false,
    })
  })
})
