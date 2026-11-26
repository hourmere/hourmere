import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'

type Row = Record<string, string | readonly string[] | number | boolean | null>

function insert(pool: pg.Pool, table: string, row: Row) {
  const columns = Object.keys(row)
  return pool.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  )
}

async function rejectNulls(pool: pg.Pool, table: string, row: Row, columns: string[]) {
  for (const column of columns) {
    await expect(
      insert(pool, table, { ...row, [column]: null }),
      `${table}.${column}`,
    ).rejects.toMatchObject({ code: '23502', column })
  }
}

async function seedMember(
  pool: pg.Pool,
  organization_id: string,
  role: string,
  user = randomUUID(),
) {
  await expect(
    pool.query(
      `INSERT INTO auth.user (id, name, email, "emailVerified")
       VALUES ($1, 'Storage fixture', $1::uuid || '@example.test', true) ON CONFLICT (id) DO NOTHING`,
      [user],
    ),
  ).resolves.toBeDefined()
  const member_id = randomUUID()
  await expect(
    pool.query(
      `INSERT INTO auth.member (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, $4, now())`,
      [member_id, organization_id, user, role],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  return { organization_id, member_id, user_id: user }
}

async function assertPolicyStorage(pool: pg.Pool, teamId: string, anotherTeamId: string) {
  const teams = 'team_custom_role_policies'
  const master = 'custom_role_master_policy'
  await expect(pool.query(`INSERT INTO ${master} DEFAULT VALUES`)).rejects.toMatchObject({
    code: '23505',
    constraint: 'custom_role_master_policy_pkey',
  })
  await expect(insert(pool, master, { singleton: false })).rejects.toMatchObject({
    code: '23514',
    constraint: 'custom_role_master_singleton',
  })
  await expect(insert(pool, teams, { organization_id: randomUUID() })).rejects.toMatchObject({
    code: '23503',
    constraint: 'team_custom_role_policies_organization_id_fkey',
  })
  await expect(insert(pool, teams, { organization_id: teamId })).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(insert(pool, teams, { organization_id: teamId })).rejects.toMatchObject({
    code: '23505',
    constraint: 'team_custom_role_policies_pkey',
  })
  for (const [table, epochConstraint] of [
    [master, 'custom_role_master_epoch'],
    [teams, 'team_custom_role_policy_epoch'],
  ] as const) {
    await expect(pool.query(`SELECT enabled, policy_epoch FROM ${table}`)).resolves.toMatchObject({
      rows: [{ enabled: false, policy_epoch: 0 }],
    })
    await expect(pool.query(`UPDATE ${table} SET enabled = true`), table).rejects.toMatchObject({
      code: '23514',
      constraint: 'custom_role_policy_epoch_transition',
    })
    await expect(
      pool.query(`UPDATE ${table} SET enabled = true, policy_epoch = 1`),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(pool.query(`UPDATE ${table} SET enabled = false`)).rejects.toMatchObject({
      code: '23514',
      constraint: 'custom_role_policy_epoch_transition',
    })
    await expect(
      pool.query(`UPDATE ${table} SET enabled = false, policy_epoch = 2`),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(pool.query(`UPDATE ${table} SET policy_epoch = 1`)).rejects.toMatchObject({
      code: '23514',
      constraint: 'custom_role_policy_epoch_transition',
    })
    await expect(
      pool.query(`UPDATE ${table} SET enabled = NULL, policy_epoch = 3`),
    ).rejects.toMatchObject({ code: '23502', column: 'enabled' })
    await expect(pool.query(`UPDATE ${table} SET policy_epoch = NULL`)).rejects.toMatchObject({
      code: '23502',
      column: 'policy_epoch',
    })
    await expect(pool.query(`SELECT enabled, policy_epoch FROM ${table}`)).resolves.toMatchObject({
      rows: [{ enabled: false, policy_epoch: 2 }],
    })

    const id: Row = table === master ? { singleton: true } : { organization_id: anotherTeamId }
    await expect(pool.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
      code: '23514',
      constraint: 'custom_role_policy_epoch_transition',
    })
    await expect(insert(pool, table, { ...id, policy_epoch: -1 })).rejects.toMatchObject({
      code: '23514',
      constraint: epochConstraint,
    })
  }
}

type Member = Awaited<ReturnType<typeof seedMember>>

async function assertMemberStorage(pool: pg.Pool, member: Member, foreignMember: Member) {
  const table = 'team_member_authorizations'
  for (const [fields, constraint] of [
    [{ organization_id: foreignMember.organization_id }, 'team_member_authorization_membership'],
    [{ user_id: randomUUID() }, 'team_member_authorization_membership'],
    [{ generation: 0 }, 'team_member_authorization_generation'],
    [{ fixed_policy_version: 2 }, 'team_member_authorization_fixed_policy'],
    [
      { legacy_role_tokens: ['member', 'owner'], fixed_role: 'owner' },
      'team_member_authorization_fixed_role',
    ],
    [
      { legacy_role_tokens: ['owner'], fixed_role: 'admin' },
      'team_member_authorization_fixed_role',
    ],
  ] as const) {
    await expect(insert(pool, table, { ...member, ...fields })).rejects.toMatchObject({
      code: constraint === 'team_member_authorization_membership' ? '23503' : '23514',
      constraint,
    })
  }
  await rejectNulls(pool, table, member, [
    'organization_id',
    'user_id',
    'generation',
    'fixed_policy_version',
  ])
  await expect(insert(pool, table, member)).resolves.toMatchObject({ rowCount: 1 })
  await expect(insert(pool, table, member)).rejects.toMatchObject({ code: '23505' })
  await expect(
    pool.query(`SELECT generation, fixed_policy_version FROM ${table} WHERE member_id = $1`, [
      member.member_id,
    ]),
  ).resolves.toMatchObject({
    rows: [{ generation: 1, fixed_policy_version: 1 }],
  })
  await expect(
    pool.query(`UPDATE ${table} SET generation = 2 WHERE member_id = $1`, [member.member_id]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(`UPDATE ${table} SET generation = 1 WHERE member_id = $1`, [member.member_id]),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'team_member_authorization_generation_transition',
  })
  await expect(
    pool.query(`DELETE FROM ${table} WHERE member_id = $1`, [member.member_id]),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'team_member_authorization_generation_transition',
  })
}

async function seedRole(pool: pg.Pool, organization_id: string) {
  const id = randomUUID()
  const client = await pool.connect()
  try {
    await expect(client.query('BEGIN')).resolves.toBeDefined()
    await expect(
      client.query(
        'INSERT INTO custom_roles (organization_id, id, active_revision) VALUES ($1, $2, 1)',
        [organization_id, id],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(
      client.query(
        `INSERT INTO custom_role_revisions (organization_id, role_id, revision, name, permission_ids)
       VALUES ($1, $2, 1, 'Scheduling support', ARRAY['event_types.create'])`,
        [organization_id, id],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(client.query('COMMIT')).resolves.toBeDefined()
  } finally {
    // A dropped-object failure can leave this transaction open.
    client.release(true)
  }
  return id
}

async function assertRevisionStorage(
  pool: pg.Pool,
  teamId: string,
  foreignTeamId: string,
  roleId: string,
) {
  await expect(
    insert(pool, 'custom_roles', { organization_id: randomUUID(), active_revision: 1 }),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'custom_roles_organization_id_fkey',
  })
  await expect(
    insert(pool, 'custom_roles', { organization_id: teamId, active_revision: 1 }),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'custom_role_active_revision',
  })
  await expect(
    insert(pool, 'custom_roles', {
      organization_id: foreignTeamId,
      id: roleId,
      active_revision: 1,
    }),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'custom_roles_pkey',
  })
  await rejectNulls(pool, 'custom_roles', { organization_id: teamId, active_revision: 1 }, [
    'organization_id',
    'active_revision',
  ])

  const table = 'custom_role_revisions'
  const revision = {
    organization_id: teamId,
    role_id: roleId,
    revision: 2,
    name: 'Coordinator',
    permission_ids: ['analytics.read'],
  }
  await rejectNulls(pool, table, revision, [
    'organization_id',
    'name',
    'permission_ids',
    'catalogue_version',
  ])
  await expect(insert(pool, table, revision)).resolves.toMatchObject({ rowCount: 1 })
  await expect(insert(pool, table, revision)).rejects.toMatchObject({ code: '23505' })
  for (const [fields, code, constraint] of [
    [{ organization_id: foreignTeamId }, '23503', 'custom_role_revision_role'],
    [{ revision: 0 }, '23514', 'custom_role_revision_number'],
    [{ revision: 3, name: '   ' }, '23514', 'custom_role_revision_name'],
    [{ revision: 3, name: 'a'.repeat(101) }, '23514', 'custom_role_revision_name'],
    [{ revision: 3, catalogue_version: 2 }, '23514', 'custom_role_revision_permissions'],
    [
      { revision: 3, permission_ids: ['event_types.*'] },
      '23514',
      'custom_role_revision_permissions',
    ],
    [
      { revision: 3, permission_ids: ['event_types.future'] },
      '23514',
      'custom_role_revision_permissions',
    ],
    [
      { revision: 3, permission_ids: ['members.assign_role'] },
      '23514',
      'custom_role_revision_permissions',
    ],
    [
      { revision: 3, permission_ids: ['analytics.read', 'analytics.read'] },
      '23514',
      'custom_role_revision_permissions',
    ],
  ] as const) {
    await expect(insert(pool, table, { ...revision, ...fields })).rejects.toMatchObject({
      code,
      constraint,
    })
  }
  for (const ids of [
    "ARRAY['analytics.read', NULL]",
    "ARRAY[['analytics.read'], ['team_bookings.read']]",
    "'[0:0]={analytics.read}'::text[]",
  ]) {
    await expect(
      pool.query(
        `INSERT INTO custom_role_revisions (organization_id, role_id, revision, name, permission_ids)
       VALUES ($1, $2, 3, 'Explicit grants', ${ids})`,
        [teamId, roleId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'custom_role_revision_permissions' })
  }
  await expect(
    insert(pool, table, { ...revision, revision: 3, permission_ids: [] }),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    insert(pool, table, { ...revision, revision: 4, permission_ids: ['team_bookings.read'] }),
  ).resolves.toMatchObject({ rowCount: 1 })

  await expect(
    pool.query(`UPDATE ${table} SET name = 'Changed' WHERE role_id = $1 AND revision = 2`, [
      roleId,
    ]),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'custom_role_revision_immutable',
  })
  await expect(
    pool.query(`DELETE FROM ${table} WHERE role_id = $1 AND revision = 2`, [roleId]),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'custom_role_revision_immutable',
  })
}

async function assertAssignments(
  pool: pg.Pool,
  member: Member,
  owner: Member,
  roleId: string,
  otherRoleId: string,
  foreignRoleId: string,
) {
  const table = 'custom_role_assignments'
  const assignment = { ...member, role_id: roleId, assigned_by_user_id: owner.user_id }
  await rejectNulls(pool, table, assignment, ['user_id', 'role_id', 'assigned_by_user_id'])
  for (const [fields, code, constraint] of [
    [{ assigned_by_user_id: member.user_id }, '23514', 'custom_role_assignment_other_user'],
    [{ member_id: randomUUID() }, '23503', 'custom_role_assignment_member'],
    [{ role_id: foreignRoleId }, '23503', 'custom_role_assignment_role'],
    [
      { user_id: owner.user_id, member_id: owner.member_id, assigned_by_user_id: member.user_id },
      '23514',
      'custom_role_assignment_base_member',
    ],
  ] as const) {
    await expect(insert(pool, table, { ...assignment, ...fields })).rejects.toMatchObject({
      code,
      constraint,
    })
  }
  const getGeneration = () =>
    pool.query('SELECT generation FROM team_member_authorizations WHERE member_id = $1', [
      member.member_id,
    ])
  const publish = (revision: number) =>
    pool.query('UPDATE custom_roles SET active_revision = $2 WHERE id = $1', [roleId, revision])
  await expect(insert(pool, table, assignment)).resolves.toMatchObject({ rowCount: 1 })
  await expect(getGeneration()).resolves.toMatchObject({ rows: [{ generation: 3 }] })
  await expect(insert(pool, table, { ...assignment, role_id: otherRoleId })).rejects.toMatchObject({
    code: '23505',
    constraint: 'custom_role_assignments_pkey',
  })
  await expect(
    pool.query(`UPDATE ${table} SET user_id = $2 WHERE member_id = $1`, [
      member.member_id,
      randomUUID(),
    ]),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'custom_role_assignment_incarnation',
  })
  await expect(
    pool.query('UPDATE custom_roles SET archived_at = now() WHERE id = $1', [roleId]),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'custom_role_archive_in_use',
  })
  await expect(publish(99)).rejects.toMatchObject({
    code: '23503',
    constraint: 'custom_role_active_revision',
  })
  await expect(getGeneration()).resolves.toMatchObject({ rows: [{ generation: 3 }] })
  await expect(publish(2)).resolves.toMatchObject({ rowCount: 1 })
  await expect(getGeneration()).resolves.toMatchObject({ rows: [{ generation: 4 }] })
  await expect(publish(1)).rejects.toMatchObject({
    code: '23514',
    constraint: 'custom_role_revision_transition',
  })
  await expect(
    pool.query(`UPDATE ${table} SET role_id = role_id WHERE member_id = $1`, [member.member_id]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(getGeneration()).resolves.toMatchObject({ rows: [{ generation: 4 }] })
  await expect(
    pool.query(`UPDATE ${table} SET role_id = $2 WHERE member_id = $1`, [
      member.member_id,
      otherRoleId,
    ]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(getGeneration()).resolves.toMatchObject({ rows: [{ generation: 5 }] })
  await expect(
    pool.query(`DELETE FROM ${table} WHERE member_id = $1`, [member.member_id]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(getGeneration()).resolves.toMatchObject({ rows: [{ generation: 6 }] })
  await expect(
    pool.query('UPDATE custom_roles SET archived_at = now() WHERE id = $1', [roleId]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(insert(pool, table, assignment)).rejects.toMatchObject({
    code: '23514',
    constraint: 'custom_role_assignment_active_role',
  })
  await expect(
    pool.query('DELETE FROM custom_roles WHERE id = $1', [roleId]),
  ).rejects.toMatchObject({ code: '23514', constraint: 'custom_role_revision_transition' })
}

async function seedSession(pool: pg.Pool, userId: string) {
  const id = randomUUID()
  await expect(
    pool.query(
      `INSERT INTO auth.session (id, "userId", token, "expiresAt", "updatedAt")
     VALUES ($1, $2, 'synthetic-session-' || $1::uuid, now() + interval '1 day', now())`,
      [id, userId],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  return id
}

async function assertCredentialStorage(
  pool: pg.Pool,
  member: Member,
  owner: Member,
  foreignMember: Member,
) {
  const sessionId = await seedSession(pool, member.user_id)
  const otherSessionId = await seedSession(pool, member.user_id)
  const ownerSessionId = await seedSession(pool, owner.user_id)
  const apiKeyId = randomUUID()
  const oauthGrantId = randomUUID()
  await expect(
    pool.query(
      `INSERT INTO auth.apikey (id, "configId", "referenceId", key, metadata, "createdAt", "updatedAt")
     VALUES ($1, 'default', $2, 'synthetic-digest-' || $1::uuid,
             jsonb_build_object('scope', 'full', 'organizationId', $3::uuid)::text, now(), now())`,
      [apiKeyId, member.user_id, member.organization_id],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(
      `INSERT INTO mcp_oauth_grants (id, user_id, organization_id, client_id)
     VALUES ($1, $2, $3, 'storage-test-client')`,
      [oauthGrantId, member.user_id, member.organization_id],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })

  const table = 'team_credential_authorizations'
  const ceiling = {
    ...member,
    policy_epoch: 0,
    master_epoch: 0,
    member_generation: 6,
    permission_ids: ['analytics.read', 'event_types.read'],
  }
  const session = { ...ceiling, session_id: sessionId }
  const recordId = randomUUID()
  const key = { ...ceiling, api_key_id: apiKeyId }
  const grant = { ...ceiling, oauth_grant_id: oauthGrantId }
  await rejectNulls(pool, table, session, [
    'organization_id',
    'member_id',
    'user_id',
    'policy_epoch',
    'master_epoch',
    'member_generation',
    'credential_generation',
    'catalogue_version',
    'permission_ids',
  ])
  for (const [row, code, constraint] of [
    [ceiling, '23514', 'team_credential_authorization_kind'],
    [{ ...session, api_key_id: apiKeyId }, '23514', 'team_credential_authorization_kind'],
    [
      { ...session, session_id: randomUUID() },
      '23503',
      'team_credential_authorizations_session_id_fkey',
    ],
    [
      { ...key, api_key_id: randomUUID() },
      '23503',
      'team_credential_authorizations_api_key_id_fkey',
    ],
    [
      { ...grant, oauth_grant_id: randomUUID() },
      '23503',
      'team_credential_authorizations_oauth_grant_id_fkey',
    ],
    [{ ...session, member_id: randomUUID() }, '23503', 'team_credential_authorization_member'],
    [{ ...session, policy_epoch: -1 }, '23514', 'team_credential_authorization_versions'],
    [{ ...session, master_epoch: -1 }, '23514', 'team_credential_authorization_versions'],
    [{ ...session, member_generation: 0 }, '23514', 'team_credential_authorization_versions'],
    [{ ...session, credential_generation: 0 }, '23514', 'team_credential_authorization_versions'],
    [{ ...session, catalogue_version: 2 }, '23514', 'team_credential_authorization_permissions'],
    [
      { ...session, permission_ids: ['event_types.*'] },
      '23514',
      'team_credential_authorization_permissions',
    ],
    [{ ...session, session_id: ownerSessionId }, '23514', 'team_credential_authorization_owner'],
    [{ ...key, ...owner }, '23514', 'team_credential_authorization_owner'],
    [{ ...key, ...foreignMember }, '23514', 'team_credential_authorization_owner'],
    [{ ...grant, ...owner }, '23514', 'team_credential_authorization_owner'],
    [{ ...grant, ...foreignMember }, '23514', 'team_credential_authorization_owner'],
  ] satisfies [Row, string, string][]) {
    await expect(insert(pool, table, row)).rejects.toMatchObject({ code, constraint })
  }
  await expect(insert(pool, table, { ...session, id: recordId })).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    insert(pool, table, { ...session, session_id: otherSessionId, id: recordId }),
  ).rejects.toMatchObject({
    code: '23505',
    constraint: 'team_credential_authorizations_pkey',
  })
  await expect(insert(pool, table, { ...session, ...foreignMember })).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(insert(pool, table, session)).rejects.toMatchObject({
    code: '23505',
    constraint: 'team_credential_authorizations_organization_id_session_id_key',
  })
  await expect(insert(pool, table, key)).resolves.toMatchObject({ rowCount: 1 })
  await expect(insert(pool, table, key)).rejects.toMatchObject({
    code: '23505',
    constraint: 'team_credential_authorizations_api_key_id_key',
  })
  await expect(insert(pool, table, grant)).resolves.toMatchObject({ rowCount: 1 })
  await expect(insert(pool, table, grant)).rejects.toMatchObject({
    code: '23505',
    constraint: 'team_credential_authorizations_oauth_grant_id_key',
  })
  await expect(
    pool.query(
      `SELECT member_generation, credential_generation, catalogue_version, permission_ids FROM ${table} WHERE id = $1`,
      [recordId],
    ),
  ).resolves.toMatchObject({
    rows: [
      {
        member_generation: 6,
        credential_generation: 1,
        catalogue_version: 1,
        permission_ids: ceiling.permission_ids,
      },
    ],
  })
  await expect(
    pool.query(`UPDATE ${table} SET permission_ids = ARRAY['members.assign_role'] WHERE id = $1`, [
      recordId,
    ]),
  ).rejects.toMatchObject({
    code: '23514',
    constraint: 'team_credential_authorization_immutable',
  })
  for (const [column, id] of [
    ['api_key_id', apiKeyId],
    ['oauth_grant_id', oauthGrantId],
  ] as const) {
    await expect(
      pool.query(`DELETE FROM ${table} WHERE ${column} = $1`, [id]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'team_credential_authorization_immutable',
    })
  }
  await expect(pool.query(`DELETE FROM ${table} WHERE id = $1`, [recordId])).resolves.toMatchObject(
    {
      rowCount: 1,
    },
  )
  await expect(
    insert(pool, table, { ...session, credential_generation: 2 }),
  ).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    pool.query('DELETE FROM auth.session WHERE id = $1', [sessionId]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(`SELECT FROM ${table} WHERE session_id = $1`, [sessionId]),
  ).resolves.toMatchObject({ rowCount: 0 })
}

async function assertMembershipIncarnationCleanup(
  pool: pg.Pool,
  member: Member,
  owner: Member,
  roleId: string,
) {
  const assignment = { ...member, role_id: roleId, assigned_by_user_id: owner.user_id }
  await expect(insert(pool, 'custom_role_assignments', assignment)).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    pool.query('DELETE FROM auth.member WHERE id = $1', [member.member_id]),
  ).resolves.toMatchObject({
    rowCount: 1,
  })
  for (const table of [
    'team_member_authorizations',
    'custom_role_assignments',
    'team_credential_authorizations',
  ]) {
    await expect(
      pool.query(`SELECT FROM ${table} WHERE member_id = $1`, [member.member_id]),
    ).resolves.toMatchObject({
      rowCount: 0,
    })
  }

  const rejoined = await seedMember(pool, member.organization_id, 'member', member.user_id)
  expect(rejoined.member_id).not.toBe(member.member_id)
  await expect(insert(pool, 'team_member_authorizations', rejoined)).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    pool.query('SELECT generation FROM team_member_authorizations WHERE member_id = $1', [
      rejoined.member_id,
    ]),
  ).resolves.toMatchObject({
    rows: [{ generation: 1 }],
  })
  await expect(
    pool.query('SELECT FROM custom_role_assignments WHERE member_id = $1', [rejoined.member_id]),
  ).resolves.toMatchObject({
    rowCount: 0,
  })
}

async function assertScimProtocolStorage(pool: pg.Pool, teamId: string) {
  const table = 'scim_token_protocol_versions'
  const token = { token_id: randomUUID() }
  await expect(
    pool.query(
      `INSERT INTO scim_provisioning_tokens (id, organization_id, name, token_hash)
     VALUES ($1, $2, 'Protocol fixture', repeat('a', 43))`,
      [token.token_id, teamId],
    ),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(insert(pool, table, { token_id: randomUUID() })).rejects.toMatchObject({
    code: '23503',
    constraint: 'scim_token_protocol_versions_token_id_fkey',
  })
  await rejectNulls(pool, table, token, ['protocol_version'])
  await expect(insert(pool, table, { ...token, protocol_version: 2 })).rejects.toMatchObject({
    code: '23514',
    constraint: 'scim_token_protocol_version',
  })
  await expect(insert(pool, table, token)).resolves.toMatchObject({ rowCount: 1 })
  await expect(insert(pool, table, token)).rejects.toMatchObject({
    code: '23505',
    constraint: 'scim_token_protocol_versions_pkey',
  })
  await expect(
    pool.query(`SELECT protocol_version FROM ${table} WHERE token_id = $1`, [token.token_id]),
  ).resolves.toMatchObject({ rows: [{ protocol_version: 1 }] })
  await expect(
    pool.query('DELETE FROM scim_provisioning_tokens WHERE id = $1', [token.token_id]),
  ).resolves.toMatchObject({ rowCount: 1 })
  await expect(
    pool.query(`SELECT FROM ${table} WHERE token_id = $1`, [token.token_id]),
  ).resolves.toMatchObject({ rowCount: 0 })
}

export async function assertCustomRoleStorageProtections(pool: pg.Pool) {
  const teamId = randomUUID()
  const anotherTeamId = randomUUID()
  await expect(
    pool.query(
      `INSERT INTO auth.organization (id, name, slug, "createdAt")
     SELECT id, 'Storage team', id::text, now() FROM unnest($1::uuid[]) AS id`,
      [[teamId, anotherTeamId]],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })
  const member = await seedMember(pool, teamId, 'member')
  const owner = await seedMember(pool, teamId, 'owner')
  const foreignMember = await seedMember(pool, anotherTeamId, 'member', member.user_id)
  await assertPolicyStorage(pool, teamId, anotherTeamId)
  await assertMemberStorage(pool, member, foreignMember)
  for (const fixture of [owner, foreignMember]) {
    await expect(insert(pool, 'team_member_authorizations', fixture)).resolves.toMatchObject({
      rowCount: 1,
    })
  }
  const roleId = await seedRole(pool, teamId)
  const otherRoleId = await seedRole(pool, teamId)
  const foreignRoleId = await seedRole(pool, anotherTeamId)
  await assertRevisionStorage(pool, teamId, anotherTeamId, roleId)
  await assertAssignments(pool, member, owner, roleId, otherRoleId, foreignRoleId)
  await assertCredentialStorage(pool, member, owner, foreignMember)
  await assertMembershipIncarnationCleanup(pool, member, owner, otherRoleId)
  await assertScimProtocolStorage(pool, teamId)
}
