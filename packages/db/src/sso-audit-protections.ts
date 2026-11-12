// Migration 0085 replaces audit_events_details_check with the SSO branches. These checks pass on
// the migration as written and fail when the constraint is dropped (sso-audit-coverage.test.ts)
// or when an upgrade loses a branch (sso-audit-migration.test.ts). The lists here are written by
// hand, not read from sso-audit.ts, so a mistake in the application catalogue cannot hide a
// weaker database check; sso-audit-binding.test.ts compares the two.
import { randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import { assertAuditEventListProtections } from './audit-event-details-protections.ts'

/** A lowercase UUIDv7, the shape of the provider and attempt IDs that `uuidv7()` generates. */
export function ssoAuditTestId(): string {
  const time = Date.now().toString(16).padStart(12, '0')
  const random = randomBytes(10).toString('hex')
  const variant = '89ab'[Number.parseInt(random[3] ?? '0', 16) & 3]
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`
}

/** Values that must never reach the journal, one per kind the design names. */
export const ssoSensitiveValues = {
  secret: 'hm_client_secret_9f8e7d6c5b4a3928170615243342516071829304',
  token:
    'eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0xIn0.eyJzdWIiOiIyNDQ4MjkzNyIsImF1ZCI6ImNsaWVudCJ9.c2lnbmF0dXJl',
  assertion:
    '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1"><saml:Subject/></saml:Assertion>',
  encodedAssertion: 'PHNhbWw6QXNzZXJ0aW9uIElEPSJfYTEiPjwvc2FtbDpBc3NlcnRpb24+',
  // OIDC subjects are often random GUIDs (Entra object IDs, Keycloak user IDs), or opaque text.
  subjectGuid: '5f0c7a7e-2b4d-4f6a-9c1e-8d3b2a1f0e9d',
  subjectText: 'auth0|65a1b2c3d4e5f6a7b8c9d0e1',
  // A mailbox proof capability (32 random bytes, base64url) and the address it proves.
  mailboxCapability: 'Xq3t9VbN2kLm8RwPz5YcA7dHf4JgE6sU1oTiKyQnMvB',
  mailbox: 'member@example.com',
} as const

const insert = (pool: pg.Pool, action: string, details: unknown) =>
  pool.query(
    `INSERT INTO audit_events (actor_type, actor_id, credential_type, action, target_type, target_id, details)
     VALUES ('system', 'coverage', 'none', $1, 'coverage', $2, $3::jsonb)`,
    [action, randomUUID(), JSON.stringify(details)],
  )
const refused = { code: '23514', constraint: 'audit_events_details_check' }

const change = [
  'sso_provider.created',
  'sso_provider.updated',
  'sso_provider.enabled',
  'sso_provider.disabled',
  'sso_provider.deleted',
  'sso_provider.secret_rotated',
  'sso_provider.certificate_rotated',
  'sso_maintenance.key_rotated',
]
const providerEvent = [
  'sso_link.linked',
  'sso_link.unlinked',
  'sso_link.conflicted',
  'sso_authentication.succeeded',
  'sso_authentication.replay_rejected',
  'sso_jit.admitted',
  'sso_delegation.bound',
  'sso_delegation.revoked',
  'sso_proof.revoked',
]
const refusal = ['sso_authentication.failed', 'sso_jit.refused']
const policy = [
  'sso_enforcement.enabled',
  'sso_enforcement.disabled',
  'sso_enforcement.updated',
  'sso_maintenance.enforcement_disabled',
]
const empty = [
  'sso_domain.challenged',
  'sso_domain.verified',
  'sso_domain.expired',
  'sso_domain.released',
  'sso_maintenance.domain_retired',
  'sso_recovery.nominated',
  'sso_recovery.enrolled',
  'sso_member.suspended',
  'sso_member.reinstated',
  'sso_member.scim_suspended',
  'sso_member.scim_reinstated',
]

/** Throws when an SSO action's details accept anything beyond its allow-list. */
export async function assertSsoAuditDetailProtections(pool: pg.Pool): Promise<void> {
  // Every earlier branch still holds: 0080's suite, which runs 0078's first.
  await assertAuditEventListProtections(pool)
  const providerId = ssoAuditTestId()
  const correlationId = ssoAuditTestId()
  const base = (action: string): Record<string, unknown> => {
    if (change.includes(action)) return { method: 'oidc', providerId, revision: 1 }
    if (action === 'sso_provider.tested')
      return { method: 'saml', providerId, revision: 2, outcome: 'passed' }
    if (action === 'sso_domain.renewed') return { outcome: 'unknown' }
    if (providerEvent.includes(action)) return { method: 'saml', providerId }
    if (refusal.includes(action)) return { method: 'oidc', providerId, reason: 'unclassified' }
    if (policy.includes(action)) return { revision: 7 }
    return {}
  }
  const accepted: [string, unknown][] = [
    ...[...change, ...providerEvent, ...refusal, ...policy, ...empty].map(
      (action) => [action, base(action)] as [string, unknown],
    ),
    ['sso_provider.tested', base('sso_provider.tested')],
    ['sso_domain.renewed', base('sso_domain.renewed')],
    ['sso_recovery.used', {}],
    ...change.map(
      (action) =>
        [action, { method: 'saml', providerId, revision: 2_147_483_647 }] as [string, unknown],
    ),
    [
      'sso_provider.tested',
      {
        method: 'oidc',
        providerId,
        revision: 1,
        outcome: 'failed',
        reason: 'signature_invalid',
        correlationId,
      },
    ],
    ['sso_domain.renewed', { outcome: 'passed' }],
    ['sso_domain.renewed', { outcome: 'failed' }],
    ...providerEvent.map(
      (action) =>
        [action, { method: 'oidc', providerId, revision: 3, correlationId }] as [string, unknown],
    ),
    ...refusal.map(
      (action) =>
        [
          action,
          { method: 'saml', providerId, reason: 'jit_disabled', revision: 4, correlationId },
        ] as [string, unknown],
    ),
    ...[
      'attempt_invalid',
      'attempt_expired',
      'browser_mismatch',
      'provider_error',
      'provider_unreachable',
      'token_exchange_failed',
      'response_malformed',
      'signature_invalid',
      'algorithm_refused',
      'issuer_mismatch',
      'audience_mismatch',
      'destination_mismatch',
      'nonce_mismatch',
      'timing_invalid',
      'subject_invalid',
      'authentication_stale',
      'configuration_changed',
      'provider_disabled',
      'domain_unverified',
      'mailbox_unproven',
      'jit_disabled',
      'unclassified',
    ].map(
      (reason) =>
        ['sso_authentication.failed', { method: 'oidc', providerId, reason }] as [string, unknown],
    ),
    ['sso_recovery.used', { correlationId }],
  ]
  for (const [action, details] of accepted)
    await expect(
      insert(pool, action, details),
      `${action} ${JSON.stringify(details)}`,
    ).resolves.toMatchObject({ rowCount: 1 })

  const s = ssoSensitiveValues
  const allowed = (action: string): string[] => {
    if (change.includes(action)) return ['method', 'providerId', 'revision']
    if (action === 'sso_provider.tested')
      return ['method', 'providerId', 'revision', 'outcome', 'reason', 'correlationId']
    if (action === 'sso_domain.renewed') return ['outcome']
    if (providerEvent.includes(action)) return ['method', 'providerId', 'revision', 'correlationId']
    if (refusal.includes(action))
      return ['method', 'providerId', 'revision', 'reason', 'correlationId']
    if (policy.includes(action)) return ['revision']
    if (action === 'sso_recovery.used') return ['correlationId']
    return []
  }
  const keyed = [
    ...change,
    'sso_provider.tested',
    'sso_domain.renewed',
    ...providerEvent,
    ...refusal,
    ...policy,
    'sso_recovery.used',
  ]
  const rejected: [string, unknown][] = []
  // Extra keys fail for every SSO action: one per sensitive kind, free text, and each SSO key
  // (with a valid value) on an action that does not take it.
  for (const action of [...keyed, ...empty])
    for (const [key, value] of [
      ['email', s.mailbox],
      ['clientSecret', s.secret],
      ['idToken', s.token],
      ['assertion', s.assertion],
      ['subject', s.subjectText],
      ['mailboxToken', s.mailboxCapability],
      ['detail', 'free text'],
      ['method', 'oidc'],
      ['providerId', providerId],
      ['revision', 1],
      ['outcome', 'passed'],
      ['reason', 'unclassified'],
      ['correlationId', correlationId],
    ] as const)
      if (!allowed(action).includes(key)) rejected.push([action, { ...base(action), [key]: value }])
  // Every required key is required.
  for (const action of keyed)
    for (const key of Object.keys(base(action))) {
      const { [key]: _, ...rest } = base(action)
      rejected.push([action, rest])
    }
  // Unsafe values in each key.
  const badMethods = ['OIDC', 'ldap', '', 1, null, ['oidc'], s.token]
  const badIds = [
    s.subjectGuid,
    randomUUID(),
    providerId.toUpperCase(),
    `${providerId}\n`,
    ` ${providerId}`,
    s.subjectText,
    s.token,
    s.mailboxCapability,
    s.mailbox,
    '',
    null,
    1,
    [providerId],
  ]
  const badRevisions = [0, -1, 1.5, '1', 2_147_483_648, 1e12, null, true, [1], s.secret]
  const badReasons = [
    s.token,
    s.encodedAssertion,
    s.assertion,
    s.secret,
    s.mailboxCapability,
    s.subjectText,
    'Signature_Invalid',
    'signature_invalid ',
    'signature_invalid\n',
    'invalid_grant: the code was already redeemed',
    '',
    null,
    ['unclassified'],
    1,
  ]
  const badOutcomes = ['ok', 'PASSED', 'unknown', s.token, null, true]
  for (const action of [...change, 'sso_provider.tested', ...providerEvent, ...refusal]) {
    for (const method of badMethods) rejected.push([action, { ...base(action), method }])
    for (const id of badIds) rejected.push([action, { ...base(action), providerId: id }])
  }
  for (const action of [...change, 'sso_provider.tested', ...providerEvent, ...refusal, ...policy])
    for (const revision of badRevisions) rejected.push([action, { ...base(action), revision }])
  for (const action of ['sso_provider.tested', ...refusal])
    for (const reason of badReasons) rejected.push([action, { ...base(action), reason }])
  for (const outcome of badOutcomes)
    rejected.push(['sso_provider.tested', { ...base('sso_provider.tested'), outcome }])
  for (const outcome of badOutcomes.filter((value) => value !== 'unknown'))
    rejected.push(['sso_domain.renewed', { outcome }])
  for (const action of ['sso_provider.tested', ...providerEvent, ...refusal, 'sso_recovery.used'])
    for (const id of badIds) rejected.push([action, { ...base(action), correlationId: id }])
  // Not an object.
  for (const action of ['sso_provider.created', 'sso_domain.verified'])
    for (const details of [[], 'oidc', null]) rejected.push([action, details])
  for (const [action, details] of rejected)
    await expect(
      insert(pool, action, details),
      `${action} ${JSON.stringify(details)}`,
    ).rejects.toMatchObject(refused)
}
