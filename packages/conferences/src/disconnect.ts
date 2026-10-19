import type { Db } from '@hourmere/db'

/** The caller holds owner and connection locks; no provider request is needed. */
export async function clearConferenceConnection(
  db: Db,
  ownerId: string,
  connectionId: string,
  eraseIdentity = false,
) {
  await db
    .updateTable('conference_connections')
    .set({
      credentials: null,
      operation_id: null,
      scopes: [],
      status: 'disconnected',
      last_error: null,
      ...(eraseIdentity ? { external_user_id: null, account_email: null, display_name: null } : {}),
    })
    .where('id', '=', connectionId)
    .where('user_id', '=', ownerId)
    .execute()
  // An unbound attempt may be authorizing the removed identity. Retire all of this
  // owner's attempts, exactly as local disconnect does, without touching other owners.
  await db.deleteFrom('conference_oauth_states').where('user_id', '=', ownerId).execute()
}
