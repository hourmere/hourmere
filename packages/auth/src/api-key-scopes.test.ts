import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { ApiKeyScope } from './api-key-metadata.ts'
import {
  API_KEY_CLI_OPERATIONS,
  API_KEY_MCP_OPERATIONS,
  API_KEY_OPERATIONS,
  API_KEY_REST_OPERATIONS,
  apiKeyOperation,
} from './api-key-operations.ts'
import {
  ApiKeyScopeError,
  type ApiKeyScopePrincipal,
  apiKeyAllows,
  requireApiKeyOperation,
} from './api-key-scopes.ts'

// Permission expectations are the accepted contract, independent of the runtime classification.
const restContract = {
  other_read: [
    'GET /api/v1/analytics/bookings',
    'GET /api/v1/calendar-connections',
    'GET /api/v1/conference-connections',
    'GET /api/v1/event-type-hosts',
    'GET /api/v1/event-types/{id}/waitlist',
    'GET /api/v1/event-types/{id}/waitlist/entries',
    'GET /api/v1/event-types/{eventTypeId}/one-time-links',
    'GET /api/v1/event-types/{eventTypeId}/one-time-links/{id}',
    'GET /api/v1/schedules',
    'GET /api/v1/schedules/{id}',
    'GET /api/v1/schedules/{id}/overrides',
    'GET /api/v1/webhooks',
    'GET /api/v1/webhooks/{id}/deliveries',
  ],
  booking_read: [
    'GET /api/v1/book/{token}',
    'GET /api/v1/book/{token}/slots',
    'GET /api/v1/bookings',
    'GET /api/v1/bookings/{id}',
    'GET /api/v1/bookings/{id}/slots',
    'GET /api/v1/bookings/manage',
    'GET /api/v1/bookings/manage/slots',
    'GET /api/v1/event-types',
    'GET /api/v1/event-types/{id}',
    'GET /api/v1/me',
    'GET /api/v1/profile',
    'GET /api/v1/public/{handle}',
    'GET /api/v1/public/{handle}/{slug}',
    'GET /api/v1/public/{handle}/{slug}/slots',
    'GET /api/v1/public/teams/{handle}/{slug}',
    'GET /api/v1/public/teams/{handle}/{slug}/slots',
  ],
  booking_write: [
    'POST /api/v1/event-types/{eventTypeId}/one-time-links',
    'DELETE /api/v1/event-types/{eventTypeId}/one-time-links/{id}',
    'POST /api/v1/book/{token}/bookings',
    'POST /api/v1/bookings/{id}/calendar-copy/retry',
    'POST /api/v1/bookings/{id}/cancel',
    'POST /api/v1/bookings/{id}/conference/retry',
    'POST /api/v1/bookings/{id}/reschedule',
    'POST /api/v1/bookings/{id}/request-reschedule',
    'POST /api/v1/bookings/manage/cancel',
    'POST /api/v1/bookings/manage/reschedule',
    'POST /api/v1/public/{handle}/{slug}/bookings',
    'POST /api/v1/public/teams/{handle}/{slug}/bookings',
    'POST /api/v1/public/{handle}/{slug}/waitlist',
    'POST /api/v1/public/{handle}/{slug}/waitlist/resend',
    'POST /api/v1/public/teams/{handle}/{slug}/waitlist',
    'POST /api/v1/public/teams/{handle}/{slug}/waitlist/resend',
  ],
  session_only: [
    'GET /api/v1/bookings/{id}/organization',
    'DELETE /api/v1/calendar-connections/{id}',
    'POST /api/v1/calendar-connections/google/authorize',
    'POST /api/v1/calendar-connections/microsoft/authorize',
    'DELETE /api/v1/conference-connections/{id}',
    'POST /api/v1/conference-connections/{id}/authorize-meetings',
    'POST /api/v1/conference-connections/{id}/reconnect',
    'POST /api/v1/conference-connections/{id}/refresh',
    'POST /api/v1/conference-connections/zoom/authorize',
    'POST /api/v1/conference-connections/zoom/authorize-meetings',
    'GET /api/v1/instance/embed',
    'GET /api/v1/mcp-oauth/connections',
    'DELETE /api/v1/mcp-oauth/connections/{id}',
    'POST /api/v1/mcp-oauth/consent',
    'POST /api/v1/mcp-oauth/request',
    'POST /api/v1/mcp-oauth/select',
    'GET /api/v1/readiness/self',
    'GET /api/v1/team/bookings',
    'GET /api/v1/team/bookings/{id}',
    'POST /api/v1/team/bookings/{id}/cancel',
    'GET /api/v1/team/invitations',
    'GET /api/v1/team/invitations/{invitationId}',
    'POST /api/v1/team/invitations/{invitationId}/cancel',
    'GET /api/v1/team/member-removals/{operationId}',
    'GET /api/v1/team/members/{memberUserId}/departure-impact',
    'POST /api/v1/team/members/{memberUserId}/removal',
    'GET /api/v1/team/members/{memberUserId}/removal-handling',
    'POST /api/v1/teams/{teamId}/leave',
    'GET /api/v1/teams/{teamId}/member-readiness',
    'GET /api/v1/teams/{teamId}/readiness',
  ],
  other_write: [
    'POST /api/v1/calendar-connections/{id}/refresh',
    'PUT /api/v1/calendar-destination',
    'PATCH /api/v1/calendars/{id}',
    'POST /api/v1/calendars/{id}/sync',
    'POST /api/v1/event-types',
    'DELETE /api/v1/event-types/{id}',
    'PATCH /api/v1/event-types/{id}',
    'PUT /api/v1/event-types/{id}/notifications',
    'PUT /api/v1/event-types/{id}/waitlist',
    'DELETE /api/v1/event-types/{id}/waitlist/entries/{entryId}',
    'POST /api/v1/event-types/{id}/round-robin/activate',
    'PUT /api/v1/profile',
    'PATCH /api/v1/profile/name',
    'POST /api/v1/schedules',
    'DELETE /api/v1/schedules/{id}',
    'PATCH /api/v1/schedules/{id}',
    'PUT /api/v1/schedules/{id}/overrides/{date}',
    'DELETE /api/v1/schedules/{id}/overrides/{date}',
    'POST /api/v1/schedules/default',
    'POST /api/v1/webhooks',
    'DELETE /api/v1/webhooks/{id}',
    'PATCH /api/v1/webhooks/{id}',
    'POST /api/v1/webhooks/{id}/rotate-secret',
  ],
  public_metadata: ['GET /api/v1/instance', 'GET /api/v1/openapi.json'],
} as const

const allowedClasses: Record<ApiKeyScope, readonly string[]> = {
  full: [
    'booking_read',
    'booking_write',
    'other_read',
    'other_write',
    'session_only',
    'public_metadata',
  ],
  read: ['booking_read', 'other_read', 'public_metadata'],
  bookings: ['booking_read', 'booking_write', 'public_metadata'],
}

type Allows = typeof apiKeyAllows

function sourceCopyPolicy(
  replacement?: readonly [string, string],
  operation = apiKeyOperation,
): Allows {
  let source = readFileSync(new URL('./api-key-scopes.ts', import.meta.url), 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'source-copy mutation anchor').toBe(true)
    source = source.replace(replacement[0], replacement[1])
  }
  source = source.replace(/^import .*?from '[^']+'\n/gm, '')
  source = stripTypeScriptTypes(source).replace(/\bexport /g, '')
  return new Function('apiKeyOperation', `${source}; return apiKeyAllows`)(operation) as Allows
}

function sourceCopyRegistry(replacement?: readonly [string, string]): typeof apiKeyOperation {
  let source = readFileSync(new URL('./api-key-operations.ts', import.meta.url), 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'source-copy mutation anchor').toBe(true)
    source = source.replace(replacement[0], replacement[1])
  }
  source = source.replace(/^import .*?from '[^']+'\n/gm, '')
  source = stripTypeScriptTypes(source).replace(/\bexport /g, '')
  return new Function(`${source}; return apiKeyOperation`)() as typeof apiKeyOperation
}

function sourceCopyRequirement(
  replacement?: readonly [string, string],
): typeof requireApiKeyOperation {
  let source = readFileSync(new URL('./api-key-scopes.ts', import.meta.url), 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'source-copy mutation anchor').toBe(true)
    source = source.replace(replacement[0], replacement[1])
  }
  source = source.replace(/^import .*?from '[^']+'\n/gm, '')
  source = stripTypeScriptTypes(source).replace(/\bexport /g, '')
  return new Function('apiKeyOperation', `${source}; return requireApiKeyOperation`)(
    apiKeyOperation,
  ) as typeof requireApiKeyOperation
}

function verifyRequiredScope(requireOperation: typeof requireApiKeyOperation) {
  expect(() =>
    requireOperation({ kind: 'api_key', apiKeyScope: 'read' }, 'mcp:create_booking'),
  ).toThrow('This API key does not allow this operation.')
}

function verifyFrozenScopes(operation: typeof apiKeyOperation) {
  const row = operation('GET /api/v1/schedules')
  if (!row) throw new Error('Missing scope fixture')
  expect(() => (row.allowedScopes as string[]).push('bookings')).toThrow(TypeError)
}

function verifyUnknownDenied(allows: Allows) {
  for (const apiKeyScope of ['read', 'bookings'] as const) {
    for (const id of [
      'GET /api/v1/future',
      'POST /api/v1/future',
      'mcp:future',
      'mcp:create_booking:future',
      'cli:future',
      'GET /api/v1/schedules/actual-id',
    ]) {
      expect(allows({ kind: 'api_key', apiKeyScope }, id), `${apiKeyScope} ${id}`).toBe(false)
    }
  }
}

function verifyMinimalBookingReads(allows: Allows) {
  const principal = { kind: 'api_key', apiKeyScope: 'bookings' } as const
  for (const id of restContract.other_read) expect(allows(principal, id), id).toBe(false)
  for (const tool of [
    'list_schedules',
    'get_schedule',
    'list_calendar_connections',
    'list_conference_connections',
  ]) {
    expect(allows(principal, `mcp:${tool}`), tool).toBe(false)
  }
}

function verifyOneTimeWrites(allows: Allows) {
  for (const id of ['POST /api/v1/book/{token}/bookings', 'mcp:create_booking:oneTimeLink']) {
    expect(allows({ kind: 'api_key', apiKeyScope: 'read' }, id)).toBe(false)
    for (const apiKeyScope of ['full', 'bookings'] as const) {
      expect(allows({ kind: 'api_key', apiKeyScope }, id)).toBe(true)
    }
  }
}

function verifyOneTimeManagementScopes(operation: typeof apiKeyOperation) {
  for (const id of [
    'POST /api/v1/event-types/{eventTypeId}/one-time-links',
    'DELETE /api/v1/event-types/{eventTypeId}/one-time-links/{id}',
    'mcp:create_one_time_link',
    'mcp:revoke_one_time_link',
    'cli:one-time-links create',
    'cli:one-time-links revoke',
  ]) {
    expect(operation(id), id).toMatchObject({
      operationClass: 'booking_write',
      allowedScopes: ['full', 'bookings'],
    })
  }
  for (const id of [
    'GET /api/v1/event-types/{eventTypeId}/one-time-links',
    'GET /api/v1/event-types/{eventTypeId}/one-time-links/{id}',
    'mcp:list_one_time_links',
    'cli:one-time-links list',
  ]) {
    expect(operation(id), id).toMatchObject({
      operationClass: 'other_read',
      allowedScopes: ['full', 'read'],
    })
  }
}

function verifyEventTypeConfigurationScopes(operation: typeof apiKeyOperation) {
  for (const tool of ['create_event_type', 'update_event_type']) {
    expect(operation(`mcp:${tool}`)).toMatchObject({
      operationClass: 'other_write',
      allowedScopes: ['full'],
    })
  }
  for (const command of ['create-event', 'update-event']) {
    expect(operation(`cli:${command}`)).toMatchObject({
      operationClass: 'other_write',
      allowedScopes: ['full'],
    })
  }
}

function verifyNotificationWrites(allows: Allows) {
  for (const id of [
    'PUT /api/v1/event-types/{id}/notifications',
    'mcp:set_event_type_notifications',
    'cli:set-event-notifications',
  ]) {
    for (const apiKeyScope of ['full', 'read', 'bookings'] as const)
      expect(allows({ kind: 'api_key', apiKeyScope }, id), `${apiKeyScope} ${id}`).toBe(
        apiKeyScope === 'full',
      )
  }
}

function verifyWaitlistScopes(operation: typeof apiKeyOperation) {
  for (const id of [
    'GET /api/v1/event-types/{id}/waitlist',
    'GET /api/v1/event-types/{id}/waitlist/entries',
    'mcp:get_event_type_waitlist',
    'mcp:list_waitlist_entries',
    'cli:event-waitlist',
    'cli:waitlist-entries',
  ])
    expect(operation(id)?.allowedScopes).toEqual(['full', 'read'])
  for (const id of [
    'PUT /api/v1/event-types/{id}/waitlist',
    'DELETE /api/v1/event-types/{id}/waitlist/entries/{entryId}',
    'mcp:set_event_type_waitlist',
    'mcp:remove_waitlist_entry',
    'cli:set-event-waitlist',
    'cli:remove-waitlist-entry',
  ])
    expect(operation(id)?.allowedScopes).toEqual(['full'])
  for (const name of ['join_waitlist', 'resend_waitlist_verification'])
    for (const mode of ['', ':personal', ':team'])
      expect(operation(`mcp:${name}${mode}`)?.allowedScopes).toEqual(['full', 'bookings'])
  for (const name of ['join-waitlist', 'resend-waitlist-verification'])
    expect(operation(`cli:${name}`)?.allowedScopes).toEqual(['full', 'bookings'])
}

describe('shared API-key scope policy', () => {
  for (const [operationClass, operations] of Object.entries(restContract)) {
    describe(operationClass, () => {
      it.each(operations)('%s follows the full/read/bookings contract', (id) => {
        expect(apiKeyOperation(id)?.operationClass).toBe(operationClass)
        for (const apiKeyScope of ['full', 'read', 'bookings'] as const) {
          expect(apiKeyAllows({ kind: 'api_key', apiKeyScope }, id), `${apiKeyScope} ${id}`).toBe(
            allowedClasses[apiKeyScope].includes(operationClass),
          )
        }
      })
    })
  }

  it('has exactly the classified REST routes and no duplicate operation IDs', () => {
    expect(API_KEY_REST_OPERATIONS.map((operation) => operation.id).sort()).toEqual(
      Object.values(restContract).flat().sort(),
    )
    expect(new Set(API_KEY_OPERATIONS.map((operation) => operation.id)).size).toBe(
      API_KEY_OPERATIONS.length,
    )
  })

  it('preserves the exact MCP discovery sets and CLI inheritance', () => {
    const expected = {
      full: [
        'whoami',
        'find_available_slots',
        'create_booking',
        'reschedule_booking',
        'request_reschedule',
        'cancel_booking',
        'list_bookings',
        'retry_conference',
        'retry_calendar_copy',
        'get_profile',
        'list_event_types',
        'get_event_type',
        'set_event_type_notifications',
        'list_schedules',
        'get_schedule',
        'create_event_type',
        'update_event_type',
        'create_one_time_link',
        'list_one_time_links',
        'revoke_one_time_link',
        'list_calendar_connections',
        'list_conference_connections',
        'get_event_type_waitlist',
        'set_event_type_waitlist',
        'list_waitlist_entries',
        'remove_waitlist_entry',
        'join_waitlist',
        'resend_waitlist_verification',
      ],
      read: [
        'whoami',
        'find_available_slots',
        'list_bookings',
        'get_profile',
        'list_event_types',
        'get_event_type',
        'list_schedules',
        'get_schedule',
        'list_one_time_links',
        'list_calendar_connections',
        'list_conference_connections',
        'get_event_type_waitlist',
        'list_waitlist_entries',
      ],
      bookings: [
        'create_one_time_link',
        'revoke_one_time_link',
        'whoami',
        'find_available_slots',
        'create_booking',
        'reschedule_booking',
        'request_reschedule',
        'cancel_booking',
        'list_bookings',
        'retry_conference',
        'retry_calendar_copy',
        'get_profile',
        'list_event_types',
        'get_event_type',
        'join_waitlist',
        'resend_waitlist_verification',
      ],
    }
    for (const apiKeyScope of ['full', 'read', 'bookings'] as const) {
      const principal = { kind: 'api_key', apiKeyScope } as const
      expect(
        API_KEY_MCP_OPERATIONS.filter(
          (operation) => operation.mode === undefined && apiKeyAllows(principal, operation.id),
        )
          .map((operation) => operation.tool)
          .sort(),
      ).toEqual(expected[apiKeyScope].sort())
      for (const operation of API_KEY_CLI_OPERATIONS) {
        expect(apiKeyAllows(principal, operation.id)).toBe(
          expected[apiKeyScope].includes(operation.tool),
        )
      }
    }
  })

  it('allows one-time consumption only as a booking write', () => verifyOneTimeWrites(apiKeyAllows))

  it('requires booking write access for one-time link writes and read for history', () =>
    verifyOneTimeManagementScopes(apiKeyOperation))

  it('denies unknown operations and never matches actual paths or HTTP/MCP hints', () =>
    verifyUnknownDenied(apiKeyAllows))
  it('excludes raw configuration and integration metadata from bookings', () =>
    verifyMinimalBookingReads(apiKeyAllows))
  it('allows only full keys to configure notifications across REST, MCP and CLI', () =>
    verifyNotificationWrites(apiKeyAllows))

  it('classifies event type writes as full-only account configuration', () =>
    verifyEventTypeConfigurationScopes(apiKeyOperation))

  it('separates manager waitlist reads and writes from invitee admission', () =>
    verifyWaitlistScopes(apiKeyOperation))

  it('lets full and non-key principals retain their native authorization for unknown operations', () => {
    const principals: ApiKeyScopePrincipal[] = [
      { kind: 'api_key', apiKeyScope: 'full' },
      { kind: 'session' },
      { kind: 'oauth' },
    ]
    for (const principal of principals) expect(apiKeyAllows(principal, 'unknown')).toBe(true)
  })

  it('returns an opaque uniform insufficient_scope error', () => {
    for (const id of [
      'POST /api/v1/event-types',
      'POST /api/v1/public/{handle}/{slug}/bookings',
      'mcp:create_booking',
      'unknown',
    ]) {
      expect(() => requireApiKeyOperation({ kind: 'api_key', apiKeyScope: 'read' }, id)).toThrow(
        ApiKeyScopeError,
      )
      try {
        requireApiKeyOperation({ kind: 'api_key', apiKeyScope: 'read' }, id)
      } catch (error) {
        expect(error).toMatchObject({
          name: 'ApiKeyScopeError',
          status: 403,
          error: 'insufficient_scope',
          message: 'This API key does not allow this operation.',
        })
      }
    }
  })

  it('freezes every policy row and its nested authorization data', () => {
    expect(Object.isFrozen(API_KEY_OPERATIONS)).toBe(true)
    for (const operation of API_KEY_OPERATIONS) {
      expect(Object.isFrozen(operation)).toBe(true)
      expect(Object.isFrozen(operation.allowedScopes)).toBe(true)
      if ('rest' in operation) expect(Object.isFrozen(operation.rest)).toBe(true)
    }
  })
})

describe('scope policy source-copy mutation checks', () => {
  it.each([
    [
      "mcp('get_event_type_waitlist', 'other_read'",
      "mcp('get_event_type_waitlist', 'booking_read'",
    ],

    [
      "rest('GET', '/api/v1/event-types/{id}/waitlist/entries', 'other_read'",
      "rest('GET', '/api/v1/event-types/{id}/waitlist/entries', 'booking_read'",
    ],
    [
      "rest('PUT', '/api/v1/event-types/{id}/waitlist', 'other_write'",
      "rest('PUT', '/api/v1/event-types/{id}/waitlist', 'booking_write'",
    ],
    [
      "rest('DELETE', '/api/v1/event-types/{id}/waitlist/entries/{entryId}', 'other_write'",
      "rest('DELETE', '/api/v1/event-types/{id}/waitlist/entries/{entryId}', 'booking_write'",
    ],
    ["mcp('list_waitlist_entries', 'other_read'", "mcp('list_waitlist_entries', 'booking_read'"],
    [
      "mcp('set_event_type_waitlist', 'other_write'",
      "mcp('set_event_type_waitlist', 'booking_write'",
    ],
    ["mcp('remove_waitlist_entry', 'other_write'", "mcp('remove_waitlist_entry', 'booking_write'"],
    ["mcp(tool, 'booking_write', [personal, team])", "mcp(tool, 'booking_read', [personal, team])"],
    [
      "cli('waitlist-entries', 'list_waitlist_entries')",
      "cli('waitlist-entries', 'list_bookings')",
    ],
  ] as const)('kills broadened waitlist scope policy: %s', (before, after) => {
    verifyWaitlistScopes(sourceCopyRegistry())
    expect(() => verifyWaitlistScopes(sourceCopyRegistry([before, after]))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it.each([
    [
      "rest('POST', '/api/v1/event-types/{eventTypeId}/one-time-links', 'booking_write'",
      "rest('POST', '/api/v1/event-types/{eventTypeId}/one-time-links', 'booking_read'",
    ],
    [
      "rest('DELETE', '/api/v1/event-types/{eventTypeId}/one-time-links/{id}', 'booking_write'",
      "rest('DELETE', '/api/v1/event-types/{eventTypeId}/one-time-links/{id}', 'booking_read'",
    ],
    [
      "rest('GET', '/api/v1/event-types/{eventTypeId}/one-time-links', 'other_read'",
      "rest('GET', '/api/v1/event-types/{eventTypeId}/one-time-links', 'booking_read'",
    ],
    [
      "rest('GET', '/api/v1/event-types/{eventTypeId}/one-time-links/{id}', 'other_read'",
      "rest('GET', '/api/v1/event-types/{eventTypeId}/one-time-links/{id}', 'booking_read'",
    ],
    ["mcp('create_one_time_link', 'booking_write'", "mcp('create_one_time_link', 'booking_read'"],
    ["mcp('revoke_one_time_link', 'booking_write'", "mcp('revoke_one_time_link', 'booking_read'"],
    ["mcp('list_one_time_links', 'other_read'", "mcp('list_one_time_links', 'booking_read'"],
    [
      "cli('one-time-links create', 'create_one_time_link')",
      "cli('one-time-links create', 'create_event_type')",
    ],
    [
      "cli('one-time-links revoke', 'revoke_one_time_link')",
      "cli('one-time-links revoke', 'update_event_type')",
    ],
    [
      "cli('one-time-links list', 'list_one_time_links')",
      "cli('one-time-links list', 'list_bookings')",
    ],
  ] as const)('kills broadened one-time management scopes: %s', (before, after) => {
    verifyOneTimeManagementScopes(sourceCopyRegistry())
    expect(() => verifyOneTimeManagementScopes(sourceCopyRegistry([before, after]))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it.each([
    [
      "rest('POST', '/api/v1/book/{token}/bookings', 'booking_write', 'optional_key')",
      "rest('POST', '/api/v1/book/{token}/bookings', 'booking_read', 'optional_key')",
    ],
    [
      "mcp('create_booking', 'booking_write', ['POST /api/v1/book/{token}/bookings'], 'oneTimeLink')",
      "mcp('create_booking', 'booking_read', ['POST /api/v1/book/{token}/bookings'], 'oneTimeLink')",
    ],
  ] as const)('kills broadened one-time consumption: %s', (before, after) => {
    verifyOneTimeWrites(sourceCopyPolicy(undefined, sourceCopyRegistry()))
    const mutant = sourceCopyPolicy(undefined, sourceCopyRegistry([before, after]))
    expect(() => verifyOneTimeWrites(mutant)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
  })
  it.each(['create_event_type', 'update_event_type'])(
    'kills classifying %s as a booking action',
    (tool) => {
      verifyEventTypeConfigurationScopes(sourceCopyRegistry())
      expect(() =>
        verifyEventTypeConfigurationScopes(
          sourceCopyRegistry([`mcp('${tool}', 'other_write'`, `mcp('${tool}', 'booking_write'`]),
        ),
      ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    },
  )
  it('verifies the unmodified source copies', () => {
    verifyUnknownDenied(sourceCopyPolicy(undefined, sourceCopyRegistry()))
    verifyMinimalBookingReads(sourceCopyPolicy(undefined, sourceCopyRegistry()))
    verifyRequiredScope(sourceCopyRequirement())
    verifyFrozenScopes(sourceCopyRegistry())
    verifyNotificationWrites(sourceCopyPolicy(undefined, sourceCopyRegistry()))
  })
  it('kills removing the common throwing scope assertion', () => {
    const mutant = sourceCopyRequirement([
      'if (!apiKeyAllows(principal, operationId))',
      'if (false)',
    ])
    expect(() => verifyRequiredScope(mutant)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyRequiredScope(sourceCopyRequirement())
  })
  it('kills allowing mutation of the registry scope arrays', () => {
    const mutant = sourceCopyRegistry([
      "other_read: Object.freeze(['full', 'read'] as const)",
      "other_read: ['full', 'read'] as const",
    ])
    expect(() => verifyFrozenScopes(mutant)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyFrozenScopes(sourceCopyRegistry())
  })
  it('kills default-allow for an unclassified operation with a real denial assertion', () => {
    const mutant = sourceCopyPolicy(['?? false', '?? true'])
    expect(() => verifyUnknownDenied(mutant)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyUnknownDenied(sourceCopyPolicy())
  })
  it.each([
    [
      "rest('GET', '/api/v1/schedules', 'other_read', 'key')",
      "rest('GET', '/api/v1/schedules', 'booking_read', 'key')",
    ],
    [
      "mcp('list_calendar_connections', 'other_read'",
      "mcp('list_calendar_connections', 'booking_read'",
    ],
  ] as const)('kills broadened bookings reads: %s', (before, after) => {
    const mutant = sourceCopyPolicy(undefined, sourceCopyRegistry([before, after]))
    expect(() => verifyMinimalBookingReads(mutant)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyMinimalBookingReads(sourceCopyPolicy(undefined, sourceCopyRegistry()))
  })
  it.each([
    [
      "rest('PUT', '/api/v1/event-types/{id}/notifications', 'other_write', 'key')",
      "rest('PUT', '/api/v1/event-types/{id}/notifications', 'booking_write', 'key')",
    ],
    [
      "mcp('set_event_type_notifications', 'other_write'",
      "mcp('set_event_type_notifications', 'booking_write'",
    ],
    [
      "cli('set-event-notifications', 'set_event_type_notifications')",
      "cli('set-event-notifications', 'create_booking')",
    ],
  ] as const)('kills broadened notification writes: %s', (before, after) => {
    const mutant = sourceCopyPolicy(undefined, sourceCopyRegistry([before, after]))
    expect(() => verifyNotificationWrites(mutant)).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verifyNotificationWrites(sourceCopyPolicy(undefined, sourceCopyRegistry()))
  })
})
