// Migration 0082 replaces audit_events_actor_type_check and adds
// audit_scim_token_actor_credential. These checks pass on the migration as written and fail
// when either constraint is dropped (audit-scim-token-actor-coverage.test.ts) or when the
// upgrade loses an actor type (audit-scim-token-actor-migration.test.ts).
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'

const insert = (pool: pg.Pool, actorType: string, credentialType: string, credentialId?: string) =>
  pool.query(
    `INSERT INTO audit_events (actor_type, actor_id, credential_type, credential_id, action, target_type, target_id)
     VALUES ($1, $2, $3, $4, 'scim_user.created', 'scim_user', $5)`,
    [
      actorType,
      ['anonymous', 'external_api_key', 'external_oauth_client', 'external_user'].includes(
        actorType,
      )
        ? null
        : randomUUID(),
      credentialType,
      credentialId ?? null,
      randomUUID(),
    ],
  )

/** Throws when the journal accepts an unknown actor or a provisioning token with a credential. */
export async function assertScimTokenActorProtections(pool: pg.Pool): Promise<void> {
  // Every earlier actor type, and the provisioning token with credential none.
  for (const actor of [
    'user',
    'api_key',
    'oauth_client',
    'system',
    'anonymous',
    'external_api_key',
    'external_oauth_client',
    'external_user',
    'scim_token',
  ])
    await expect(insert(pool, actor, 'none'), actor).resolves.toMatchObject({ rowCount: 1 })
  for (const actor of ['robot', 'scim', 'SCIM_TOKEN', 'scim_token '])
    await expect(insert(pool, actor, 'none'), actor).rejects.toMatchObject({
      code: '23514',
      constraint: 'audit_events_actor_type_check',
    })
  // The token is the actor: it never carries a session, an API key or an OAuth grant.
  for (const [credential, id] of [
    ['session', randomUUID()],
    ['session', undefined],
    ['api_key', randomUUID()],
  ] as const)
    await expect(insert(pool, 'scim_token', credential, id), credential).rejects.toMatchObject({
      code: '23514',
      constraint: 'audit_scim_token_actor_credential',
    })
  // Other actors keep their credentials.
  await expect(insert(pool, 'user', 'session', randomUUID())).resolves.toMatchObject({
    rowCount: 1,
  })
}
