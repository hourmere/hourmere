// Behavioural assertions for every protection in 0087_workflow_creation_keys.sql. As for 0076
// (workflow-storage-protections.ts), the storage test runs them one by one on a migrated
// database, the constraint-coverage test drops each catalog object in turn and requires one of
// them to fail, and the mutation test applies each protection's source-copy mutants to the
// migration and requires its check to fail. Each check builds its own fixture and touches only
// its own rows, so one database serves every check.
import { randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import { reuseConnectionsAfterErrors } from './testing.ts'
import {
  accepted,
  committed,
  type Expected,
  mutant,
  refused,
  revisionContent,
  rolledBack,
  untilBlocked,
  type WorkflowMutant,
} from './workflow-storage-protections.ts'

export const creationKeyMigration = '0087_workflow_creation_keys.sql'
export const creationKeyTable = 'workflow_creation_keys'

const check = (constraint: string): Expected => ({ code: '23514', constraint })
const foreignKey = (constraint: string): Expected => ({ code: '23503', constraint })
const unique = (constraint: string): Expected => ({ code: '23505', constraint })
const notNull = (column: string): Expected => ({ code: '23502', column })

type Connection = pg.Pool | pg.PoolClient
type Row = Record<string, unknown>

/** Where a definition lives: a personal owner's own organization, or a team (no owner). */
export interface CreationOwner {
  organization: string
  user: string | null
}
/** A stored definition. */
export interface CreatedWorkflow {
  organization: string
  id: string
}

/** A definition with its first revision, written on `db` as a create writes it. */
async function insertWorkflow(db: Connection, by: CreationOwner): Promise<CreatedWorkflow> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO workflow_definitions (organization_id,owner_user_id) VALUES ($1,$2) RETURNING id',
    [by.organization, by.user],
  )
  const id = rows[0]?.id as string
  await db.query(
    'INSERT INTO workflow_revisions (organization_id,workflow_id,revision,definition) VALUES ($1,$2,1,$3)',
    [by.organization, id, JSON.stringify(revisionContent())],
  )
  return { organization: by.organization, id }
}

function insertKey(db: Connection, values: Row) {
  const fields = Object.keys(values)
  return db.query(
    `INSERT INTO workflow_creation_keys (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(values),
  )
}

async function backendPid(db: pg.PoolClient) {
  return (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid as number
}

export async function creationKeyFixture(database: pg.Pool) {
  // Checks expect many failed statements; keep one connection instead of one per failure.
  const pool = reuseConnectionsAfterErrors(database)
  const user = async (label: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO auth."user" (name,email,"emailVerified") VALUES ($1,$2,true) RETURNING id`,
        [`Synthetic workflow key ${label}`, `${randomUUID()}@example.test`],
      )
    ).rows[0]?.id as string
  const organization = async (label: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO auth.organization (name,slug,"createdAt") VALUES ($1,$2,now()) RETURNING id`,
        [`Synthetic workflow key ${label}`, randomUUID()],
      )
    ).rows[0]?.id as string
  const owner = await user('owner')
  const member = await user('member')
  const personal = await organization('personal')
  const team = await organization('team')
  const otherTeam = await organization('other team')
  await pool.query('INSERT INTO personal_organizations (user_id,organization_id) VALUES ($1,$2)', [
    owner,
    personal,
  ])
  const personalOwner: CreationOwner = { organization: personal, user: owner }
  const teamOwner: CreationOwner = { organization: team, user: null }
  const otherTeamOwner: CreationOwner = { organization: otherTeam, user: null }

  /** A key row for `workflow`: by default the owner's session principal, with a fresh key. */
  const keyValues = (workflow: CreatedWorkflow, overrides: Row = {}): Row => ({
    organization_id: workflow.organization,
    workflow_id: workflow.id,
    actor_user_id: owner,
    credential_kind: 'session',
    credential_id: null,
    idempotency_key: `create-${randomUUID()}`,
    request_fingerprint: randomBytes(32),
    ...overrides,
  })

  /** A committed definition without a key. */
  const workflow = (by: CreationOwner) =>
    accepted(
      committed(pool, (db) => insertWorkflow(db, by)),
      'create a workflow with its first revision',
    )

  /** The definition, its first revision and its key, written on `db` as a create writes them. */
  const createOn = async (db: Connection, by: CreationOwner, key: Row = {}) => {
    const created = await insertWorkflow(db, by)
    await insertKey(db, keyValues(created, key))
    return created
  }
  /** A committed create. */
  const create = (by: CreationOwner, key: Row = {}, label = 'a create with its key') =>
    accepted(
      committed(pool, (db) => createOn(db, by, key)),
      label,
    )

  /** The key rows of a definition, as text, so a later comparison sees every value. */
  const keysOf = async (workflow: CreatedWorkflow) =>
    (
      await pool.query<{ row: string }>(
        `SELECT to_jsonb(k)::text AS row FROM workflow_creation_keys k
        WHERE organization_id=$1 AND workflow_id=$2`,
        [workflow.organization, workflow.id],
      )
    ).rows.map(({ row }) => row)
  /** How many rows hold `key`. */
  const holding = async (key: string) =>
    (
      await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM workflow_creation_keys WHERE idempotency_key=$1',
        [key],
      )
    ).rows[0]?.count

  /** An API key record of `userId`. */
  const apiKey = async (userId: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO auth.apikey ("configId","referenceId",key,"createdAt","updatedAt")
        VALUES ('default',$1,$2,now(),now()) RETURNING id`,
        [userId, `synthetic-${randomUUID()}`],
      )
    ).rows[0]?.id as string
  /** An OAuth consent of `userId` for a new client. */
  const consent = async (userId: string) => {
    const clientId = `synthetic-${randomUUID()}`
    await pool.query(
      `INSERT INTO auth."oauthClient" ("clientId","redirectUris","createdAt","updatedAt")
      VALUES ($1,'["https://client.example.test/callback"]'::jsonb,now(),now())`,
      [clientId],
    )
    return (
      await pool.query<{ id: string }>(
        `INSERT INTO auth."oauthConsent" ("clientId","userId",scopes,"createdAt","updatedAt")
        VALUES ($1,$2,'["mcp:tools"]'::jsonb,now(),now()) RETURNING id`,
        [clientId, userId],
      )
    ).rows[0]?.id as string
  }
  /** A signed-in session of `userId`. */
  const session = async (userId: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO auth.session ("expiresAt",token,"updatedAt","userId")
        VALUES (now()+interval '1 day',$1,now(),$2) RETURNING id`,
        [randomUUID(), userId],
      )
    ).rows[0]?.id as string

  return {
    pool,
    owner,
    member,
    personal,
    team,
    otherTeam,
    personalOwner,
    teamOwner,
    otherTeamOwner,
    keyValues,
    workflow,
    createOn,
    create,
    keysOf,
    holding,
    apiKey,
    consent,
    session,
  }
}
export type CreationKeyFixture = Awaited<ReturnType<typeof creationKeyFixture>>

/**
 * Two creates with one key in one scope, each in its own transaction: the second waits for the
 * first, which commits, and is then refused by the scope's uniqueness. One row holds the key.
 */
async function race(f: CreationKeyFixture, label: string, key: Row) {
  const a = await f.pool.connect()
  const b = await f.pool.connect()
  let racing: Promise<unknown> = Promise.resolve()
  let settled = false
  try {
    await a.query('BEGIN')
    await accepted(f.createOn(a, f.teamOwner, key), `${label}: the first create`)
    const pid = await backendPid(b)
    await b.query('BEGIN')
    racing = f
      .createOn(b, f.teamOwner, { ...key, request_fingerprint: randomBytes(32) })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true
      })
    await untilBlocked(f.pool, pid, () => settled)
    await a.query('COMMIT')
    expect(await racing, `${label}: the second create`).toMatchObject(
      unique('workflow_creation_keys_scope'),
    )
  } finally {
    // Ends the first transaction if it is still open, so the second create finishes.
    await a.query('ROLLBACK')
    await racing
    await b.query('ROLLBACK')
    a.release()
    b.release()
  }
  expect(await f.holding(key.idempotency_key as string), `${label}: rows holding the key`).toBe(1)
}

export interface CreationKeyProtection {
  /**
   * Catalog objects (constraint, trigger, NOT NULL column) and trigger rules covered; none for a
   * behaviour of its own.
   */
  objects: string[]
  check: (f: CreationKeyFixture) => Promise<void>
  mutants: WorkflowMutant[]
}

/** A source-copy mutant that appends `sql` to the migration. */
const appended = (name: string, sql: string): WorkflowMutant => ({
  name,
  apply: (source) => `${source}\n${sql}\n`,
})

const SCOPE_COLUMNS =
  '(organization_id, actor_user_id, credential_kind, credential_id, idempotency_key),'

export const creationKeyProtections: Record<string, CreationKeyProtection> = {
  'required columns and defaults': {
    objects: [
      'workflow_creation_keys.actor_user_id',
      'workflow_creation_keys.credential_kind',
      'workflow_creation_keys.idempotency_key',
      'workflow_creation_keys.request_fingerprint',
      'workflow_creation_keys.created_at',
    ],
    check: async (f) => {
      const workflow = await f.workflow(f.teamOwner)
      for (const column of [
        'actor_user_id',
        'credential_kind',
        'idempotency_key',
        'request_fingerprint',
        'created_at',
      ])
        await refused(
          f.pool,
          notNull(column),
          (db) => insertKey(db, f.keyValues(workflow, { [column]: null })),
          column,
        )
      // A key is stamped with its creating transaction's time.
      const stamped = await rolledBack(f.pool, async (db) => {
        await accepted(insertKey(db, f.keyValues(workflow)))
        return (
          await db.query(
            'SELECT created_at=now() AS now FROM workflow_creation_keys WHERE workflow_id=$1',
            [workflow.id],
          )
        ).rows
      })
      expect(stamped).toEqual([{ now: true }])
    },
    mutants: [
      mutant('a key may lack its actor', 'actor_user_id uuid NOT NULL,', 'actor_user_id uuid,'),
      mutant(
        'a key may lack its credential kind',
        'credential_kind text NOT NULL,',
        'credential_kind text,',
      ),
      mutant('a key may lack its value', 'idempotency_key text NOT NULL,', 'idempotency_key text,'),
      mutant(
        'a key may lack its fingerprint',
        'request_fingerprint bytea NOT NULL,',
        'request_fingerprint bytea,',
      ),
      mutant(
        'a key may lack its creation time',
        'created_at timestamptz NOT NULL DEFAULT now(),',
        'created_at timestamptz DEFAULT now(),',
      ),
      mutant(
        'a key has no default creation time',
        'created_at timestamptz NOT NULL DEFAULT now(),',
        'created_at timestamptz NOT NULL,',
      ),
    ],
  },

  'one key per definition': {
    objects: ['workflow_creation_keys_pkey'],
    check: async (f) => {
      const workflow = await f.create(f.teamOwner)
      // A definition comes from one create request, so it holds one key, whoever asks again.
      await refused(f.pool, unique('workflow_creation_keys_pkey'), (db) =>
        insertKey(db, f.keyValues(workflow)),
      )
      const apiKey = randomUUID()
      await refused(
        f.pool,
        unique('workflow_creation_keys_pkey'),
        (db) =>
          insertKey(
            db,
            f.keyValues(workflow, {
              actor_user_id: f.member,
              credential_kind: 'api_key',
              credential_id: apiKey,
            }),
          ),
        'another credential',
      )
      expect(await f.keysOf(workflow)).toHaveLength(1)
    },
    mutants: [
      mutant('a definition may hold two keys', '  PRIMARY KEY (organization_id, workflow_id),\n'),
    ],
  },

  'definition reference': {
    objects: ['workflow_creation_keys_workflow'],
    check: async (f) => {
      const reference = foreignKey('workflow_creation_keys_workflow')
      await refused(
        f.pool,
        reference,
        (db) => insertKey(db, f.keyValues({ organization: f.team, id: randomUUID() })),
        'an unknown definition',
      )
      // The key's organization is its definition's: a key in another organization, or in a
      // personal organization for a team definition, names no definition.
      const workflow = await f.workflow(f.teamOwner)
      for (const organization of [f.otherTeam, f.personal])
        await refused(
          f.pool,
          reference,
          (db) => insertKey(db, f.keyValues({ organization, id: workflow.id })),
          `the team's definition under ${organization === f.personal ? 'a personal' : 'another'} organization`,
        )
      await accepted(insertKey(f.pool, f.keyValues(workflow)), "the definition's own organization")
    },
    mutants: [
      mutant(
        'the definition reference omits the organization',
        'FOREIGN KEY (organization_id, workflow_id)\n    REFERENCES workflow_definitions (organization_id, id)',
        'FOREIGN KEY (workflow_id)\n    REFERENCES workflow_definitions (id)',
      ),
    ],
  },

  'retained identity': {
    objects: ['workflow_creation_keys_workflow'],
    check: async (f) => {
      // A tombstone keeps its key unchanged: deletion is idempotent within retained identity.
      const tombstone = await f.create(f.teamOwner)
      const live = await f.create(f.teamOwner)
      const kept = await f.keysOf(tombstone)
      expect(kept).toHaveLength(1)
      await accepted(
        f.pool.query('UPDATE workflow_definitions SET enabled=true WHERE id=$1', [tombstone.id]),
        'enable',
      )
      await accepted(
        f.pool.query('UPDATE workflow_definitions SET enabled=false,deleted_at=now() WHERE id=$1', [
          tombstone.id,
        ]),
        'tombstone',
      )
      expect(await f.keysOf(tombstone), 'the tombstone keeps its key').toEqual(kept)
      // Purging the tombstone removes its key with it, and nothing else.
      const other = await f.keysOf(live)
      await accepted(
        f.pool.query('DELETE FROM workflow_definitions WHERE id=$1', [tombstone.id]),
        'purge',
      )
      expect(await f.keysOf(tombstone), 'the purged key').toEqual([])
      expect(await f.keysOf(live), 'a live key').toEqual(other)

      // Deleting an organization removes the keys of its live and tombstoned definitions.
      const deleted = await f.create(f.teamOwner)
      await accepted(
        f.pool.query('UPDATE workflow_definitions SET deleted_at=now() WHERE id=$1', [deleted.id]),
      )
      const elsewhere = await f.create(f.otherTeamOwner)
      const elsewhereKeys = await f.keysOf(elsewhere)
      await accepted(f.pool.query('DELETE FROM auth.organization WHERE id=$1', [f.team]))
      for (const workflow of [live, deleted])
        expect(await f.keysOf(workflow), 'a deleted organization').toEqual([])
      expect(await f.keysOf(elsewhere), 'another organization').toEqual(elsewhereKeys)

      // Deleting a personal owner removes their personal definitions with their keys.
      const personal = await f.create(f.personalOwner)
      expect(await f.keysOf(personal)).toHaveLength(1)
      await accepted(f.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.owner]))
      expect(await f.keysOf(personal), 'a deleted personal owner').toEqual([])
      expect(await f.keysOf(elsewhere), 'another organization').toEqual(elsewhereKeys)
    },
    mutants: [
      mutant(
        'a purge keeps the key',
        'REFERENCES workflow_definitions (organization_id, id) ON DELETE CASCADE,',
        'REFERENCES workflow_definitions (organization_id, id),',
      ),
      appended(
        'a tombstone removes the key',
        `CREATE FUNCTION forget_tombstoned_workflow_creation_key() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM public.workflow_creation_keys
    WHERE organization_id = NEW.organization_id AND workflow_id = NEW.id;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_definitions_forget_creation_key AFTER UPDATE OF deleted_at
  ON workflow_definitions FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION forget_tombstoned_workflow_creation_key();`,
      ),
      mutant(
        'a key blocks the cascades too',
        `  IF EXISTS (SELECT FROM public.workflow_definitions
      WHERE organization_id = OLD.organization_id AND id = OLD.workflow_id) THEN`,
        '  IF true THEN',
      ),
    ],
  },

  guard: {
    objects: [
      'workflow_creation_keys_guard',
      'workflow_creation_keys_immutable',
      'workflow_creation_keys_retained',
    ],
    check: async (f) => {
      const live = await f.create(f.teamOwner)
      const kept = await f.keysOf(live)
      expect(kept).toHaveLength(1)
      // Every column is fixed, whatever the new value; each one here is otherwise valid.
      const keyless = await f.workflow(f.teamOwner)
      const elsewhere = await f.workflow(f.otherTeamOwner)
      const updates: [string, string, unknown[]][] = [
        ['the definition', 'workflow_id=$3', [keyless.id]],
        [
          'the organization and definition',
          'organization_id=$3,workflow_id=$4',
          [elsewhere.organization, elsewhere.id],
        ],
        ['the actor', 'actor_user_id=$3', [f.member]],
        ['the credential', "credential_kind='api_key',credential_id=$3", [randomUUID()]],
        ['the key', 'idempotency_key=$3', [`create-${randomUUID()}`]],
        ['the fingerprint', 'request_fingerprint=$3', [randomBytes(32)]],
        ['the creation time', "created_at=created_at-interval '1 day'", []],
        ['no value', 'idempotency_key=idempotency_key', []],
      ]
      for (const [label, set, values] of updates)
        await refused(
          f.pool,
          check('workflow_creation_keys_immutable'),
          (db) =>
            db.query(
              `UPDATE workflow_creation_keys SET ${set} WHERE organization_id=$1 AND workflow_id=$2`,
              [live.organization, live.id, ...values],
            ),
          label,
        )
      expect(await f.keysOf(live), 'after the updates').toEqual(kept)
      // A key is deleted only with its definition row, never while it exists, tombstoned or not.
      const remove = (db: Connection) =>
        db.query('DELETE FROM workflow_creation_keys WHERE organization_id=$1 AND workflow_id=$2', [
          live.organization,
          live.id,
        ])
      const retained = check('workflow_creation_keys_retained')
      await refused(f.pool, retained, remove, 'a live definition')
      await accepted(
        f.pool.query('UPDATE workflow_definitions SET deleted_at=now() WHERE id=$1', [live.id]),
        'tombstone',
      )
      await refused(f.pool, retained, remove, 'a tombstone')
      expect(await f.keysOf(live), 'the tombstone keeps its key').toEqual(kept)
      await accepted(
        f.pool.query('DELETE FROM workflow_definitions WHERE id=$1', [live.id]),
        'purge',
      )
      expect(await f.keysOf(live), 'the purged key').toEqual([])
    },
    mutants: [
      mutant(
        'the guard is dropped',
        `CREATE TRIGGER workflow_creation_keys_guard BEFORE UPDATE OR DELETE ON workflow_creation_keys
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_creation_key();`,
      ),
      mutant(
        'a key may be updated',
        `    RAISE EXCEPTION 'workflow creation keys are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_creation_keys_immutable';`,
        '    RETURN NEW;',
      ),
      mutant(
        'a key may be deleted while its definition lives',
        `  IF EXISTS (SELECT FROM public.workflow_definitions
      WHERE organization_id = OLD.organization_id AND id = OLD.workflow_id) THEN
    RAISE EXCEPTION 'a workflow creation key is removed only with its workflow'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'workflow_creation_keys_retained';
  END IF;
`,
      ),
      mutant(
        'a key may be deleted once its definition is tombstoned',
        'WHERE organization_id = OLD.organization_id AND id = OLD.workflow_id) THEN',
        'WHERE organization_id = OLD.organization_id AND id = OLD.workflow_id\n        AND deleted_at IS NULL) THEN',
      ),
      mutant(
        'the guard does not run on DELETE',
        'BEFORE UPDATE OR DELETE ON workflow_creation_keys',
        'BEFORE UPDATE ON workflow_creation_keys',
      ),
      mutant(
        'the guard does not run on UPDATE',
        'BEFORE UPDATE OR DELETE ON workflow_creation_keys',
        'BEFORE DELETE ON workflow_creation_keys',
      ),
    ],
  },

  scope: {
    objects: ['workflow_creation_keys_scope'],
    check: async (f) => {
      // Two concurrent creates with one key write once, for a session principal (which names
      // no credential) and for a credential record alike.
      await race(f, 'a session principal', { idempotency_key: `race-${randomUUID()}` })
      await race(f, 'an API key', {
        idempotency_key: `race-${randomUUID()}`,
        credential_kind: 'api_key',
        credential_id: randomUUID(),
      })
      // A later create with the key of a committed one is refused too.
      const key = `create-${randomUUID()}`
      await f.create(f.teamOwner, { idempotency_key: key })
      await refused(
        f.pool,
        unique('workflow_creation_keys_scope'),
        (db) => f.createOn(db, f.teamOwner, { idempotency_key: key }),
        'a later create in the same scope',
      )
      expect(await f.holding(key)).toBe(1)

      // The same key under another credential kind, credential, actor or organization is
      // another row; so is another key in the same scope. The API key and the OAuth consent
      // share one record ID, so only the kind tells them apart.
      const shared = randomUUID()
      const scopes: [string, CreationOwner, Row][] = [
        ['an API key', f.teamOwner, { credential_kind: 'api_key', credential_id: shared }],
        ['an OAuth consent', f.teamOwner, { credential_kind: 'oauth', credential_id: shared }],
        [
          'another API key',
          f.teamOwner,
          { credential_kind: 'api_key', credential_id: randomUUID() },
        ],
        ['another actor', f.teamOwner, { actor_user_id: f.member }],
        ['another organization', f.otherTeamOwner, {}],
        ['a personal organization', f.personalOwner, {}],
      ]
      for (const [label, by, values] of scopes)
        await f.create(by, { idempotency_key: key, ...values }, label)
      expect(await f.holding(key)).toBe(1 + scopes.length)
      await f.create(f.teamOwner, {}, 'another key in the same scope')
    },
    mutants: [
      mutant(
        'the scope omits the credential kind',
        SCOPE_COLUMNS,
        '(organization_id, actor_user_id, credential_id, idempotency_key),',
      ),
      mutant(
        'session keys are NULLS DISTINCT',
        'UNIQUE NULLS NOT DISTINCT',
        'UNIQUE NULLS DISTINCT',
      ),
      mutant(
        'the scope omits the actor',
        SCOPE_COLUMNS,
        '(organization_id, credential_kind, credential_id, idempotency_key),',
      ),
      mutant(
        'the scope omits the organization',
        SCOPE_COLUMNS,
        '(actor_user_id, credential_kind, credential_id, idempotency_key),',
      ),
      mutant(
        'the scope omits the credential',
        SCOPE_COLUMNS,
        '(organization_id, actor_user_id, credential_kind, idempotency_key),',
      ),
      mutant(
        'the scope omits the key',
        SCOPE_COLUMNS,
        '(organization_id, actor_user_id, credential_kind, credential_id),',
      ),
      // A wider key would let a changed replay write a second definition.
      mutant(
        'the scope includes the fingerprint',
        SCOPE_COLUMNS,
        '(organization_id, actor_user_id, credential_kind, credential_id, idempotency_key, request_fingerprint),',
      ),
    ],
  },

  'credential kinds': {
    objects: ['workflow_creation_keys_credential'],
    check: async (f) => {
      const shape = check('workflow_creation_keys_credential')
      const record = randomUUID()
      const cases: [string, string | null][] = [
        // A session principal names no credential record; the others always name theirs.
        ['session', record],
        ['api_key', null],
        ['oauth', null],
        // Only the three kinds exist.
        ['scim_token', record],
        ['scim_token', null],
        ['Session', null],
        ['', null],
      ]
      for (const [kind, credential] of cases)
        await refused(
          f.pool,
          shape,
          (db) => f.createOn(db, f.teamOwner, { credential_kind: kind, credential_id: credential }),
          `${kind || 'an empty kind'} ${credential ? 'with' : 'without'} a credential`,
        )
      for (const [kind, credential] of [
        ['session', null],
        ['api_key', record],
        ['oauth', record],
      ] as const)
        await f.create(f.teamOwner, { credential_kind: kind, credential_id: credential }, kind)
    },
    mutants: [
      mutant(
        'a session key may name a credential',
        "(credential_kind = 'session' AND credential_id IS NULL)",
        "(credential_kind = 'session')",
      ),
      mutant(
        'an API key or OAuth consent key may omit its credential',
        "IN ('api_key', 'oauth') AND credential_id IS NOT NULL)",
        "IN ('api_key', 'oauth'))",
      ),
      mutant(
        'another credential kind',
        "IN ('api_key', 'oauth')",
        "IN ('api_key', 'oauth', 'scim_token')",
      ),
    ],
  },

  'key format': {
    objects: ['workflow_creation_keys_key_format'],
    check: async (f) => {
      const format = check('workflow_creation_keys_key_format')
      for (const key of [
        '',
        'k'.repeat(256),
        'with space',
        ' leading',
        'tab\there',
        'line\nbreak',
        'trailing\n',
        'del\u007f',
        'café',
        '界',
      ])
        await refused(
          f.pool,
          format,
          (db) => f.createOn(db, f.teamOwner, { idempotency_key: key }),
          JSON.stringify(key),
        )
      for (const key of ['!', '~', 'k'.repeat(255), `Order-${randomUUID()}_~!{}`])
        await f.create(f.teamOwner, { idempotency_key: key }, JSON.stringify(key))
    },
    mutants: [
      mutant('the key length bound is dropped', "'^[!-~]{1,255}$'", "'^[!-~]+$'"),
      mutant('an empty key', "'^[!-~]{1,255}$'", "'^[!-~]{0,255}$'"),
      mutant('a key may contain a space', "'^[!-~]{1,255}$'", "'^[ -~]{1,255}$'"),
    ],
  },

  'fingerprint length': {
    objects: ['workflow_creation_keys_fingerprint_length'],
    check: async (f) => {
      for (const bytes of [0, 31, 33, 64])
        await refused(
          f.pool,
          check('workflow_creation_keys_fingerprint_length'),
          (db) => f.createOn(db, f.teamOwner, { request_fingerprint: randomBytes(bytes) }),
          `${bytes} bytes`,
        )
      await f.create(f.teamOwner, { request_fingerprint: randomBytes(32) }, '32 bytes')
    },
    mutants: [
      mutant(
        'the fingerprint length check is dropped',
        `,
  -- A SHA-256 digest of the canonical input.
  CONSTRAINT workflow_creation_keys_fingerprint_length
    CHECK (octet_length(request_fingerprint) = 32)`,
      ),
      mutant(
        'a longer fingerprint',
        'octet_length(request_fingerprint) = 32',
        'octet_length(request_fingerprint) >= 32',
      ),
    ],
  },

  // No catalog object of its own: the actor and credential IDs have no foreign key, as bookings
  // keep theirs. Deleting a credential or user changes no key, and a later credential gets a new
  // random ID, so it never matches a retained key.
  'credential deletion': {
    objects: [],
    check: async (f) => {
      const apiKey = await f.apiKey(f.owner)
      const consent = await f.consent(f.owner)
      await f.session(f.owner)
      const keys = {
        api: `api-${randomUUID()}`,
        oauth: `oauth-${randomUUID()}`,
        session: `session-${randomUUID()}`,
        member: `member-${randomUUID()}`,
      }
      const created = [
        await f.create(f.teamOwner, {
          credential_kind: 'api_key',
          credential_id: apiKey,
          idempotency_key: keys.api,
        }),
        await f.create(f.teamOwner, {
          credential_kind: 'oauth',
          credential_id: consent,
          idempotency_key: keys.oauth,
        }),
        await f.create(f.teamOwner, { idempotency_key: keys.session }),
        await f.create(f.teamOwner, { actor_user_id: f.member, idempotency_key: keys.member }),
      ]
      const personal = await f.create(f.personalOwner, { idempotency_key: keys.session })
      const keysOfAll = async () => {
        const rows: string[][] = []
        for (const workflow of created) rows.push(await f.keysOf(workflow))
        return rows
      }
      const before = await keysOfAll()
      expect(before.map((rows) => rows.length)).toEqual([1, 1, 1, 1])

      // Revoking the API key and the OAuth consent and signing out change no key.
      await accepted(f.pool.query('DELETE FROM auth.apikey WHERE id=$1', [apiKey]))
      await accepted(f.pool.query(`DELETE FROM auth."oauthConsent" WHERE id=$1`, [consent]))
      await accepted(f.pool.query('DELETE FROM auth.session WHERE "userId"=$1', [f.owner]))
      expect(await keysOfAll()).toEqual(before)
      // A later API key, OAuth consent or session principal of the same user does not match a
      // revoked credential's key: the same key creates a new definition.
      await f.create(
        f.teamOwner,
        {
          credential_kind: 'api_key',
          credential_id: await f.apiKey(f.owner),
          idempotency_key: keys.api,
        },
        'a new API key',
      )
      await f.create(
        f.teamOwner,
        {
          credential_kind: 'oauth',
          credential_id: await f.consent(f.owner),
          idempotency_key: keys.oauth,
        },
        'a new OAuth consent',
      )
      await f.create(f.teamOwner, { idempotency_key: keys.api }, 'the session principal')
      expect(await f.holding(keys.api)).toBe(3)
      expect(await f.holding(keys.oauth)).toBe(2)

      // Deleting a user keeps the keys they made for a team; their personal definitions go.
      await accepted(f.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.member]))
      await accepted(f.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.owner]))
      expect(await keysOfAll()).toEqual(before)
      expect(await f.keysOf(personal)).toEqual([])
    },
    mutants: [
      appended(
        'an API key deletion removes its keys',
        `CREATE FUNCTION forget_api_key_creation_keys() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM public.workflow_creation_keys
    WHERE credential_kind = 'api_key' AND credential_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER apikey_forget_creation_keys AFTER DELETE ON auth.apikey
  FOR EACH ROW EXECUTE FUNCTION forget_api_key_creation_keys();`,
      ),
      appended(
        "a revoked API key's keys pass to the session principal",
        `CREATE FUNCTION reassign_api_key_creation_keys() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.workflow_creation_keys SET credential_kind = 'session', credential_id = NULL
    WHERE credential_kind = 'api_key' AND credential_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER apikey_reassign_creation_keys AFTER DELETE ON auth.apikey
  FOR EACH ROW EXECUTE FUNCTION reassign_api_key_creation_keys();`,
      ),
      appended(
        'an OAuth consent deletion removes its keys',
        `CREATE FUNCTION forget_oauth_creation_keys() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM public.workflow_creation_keys
    WHERE credential_kind = 'oauth' AND credential_id = OLD.id;
  RETURN OLD;
END $$;
CREATE TRIGGER oauth_consent_forget_creation_keys AFTER DELETE ON auth."oauthConsent"
  FOR EACH ROW EXECUTE FUNCTION forget_oauth_creation_keys();`,
      ),
      mutant(
        'a user deletion removes the keys they made',
        'actor_user_id uuid NOT NULL,',
        'actor_user_id uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,',
      ),
    ],
  },
}

/** Runs every protection on its own fixture; the error names the first failing check. */
export async function assertCreationKeyProtections(pool: pg.Pool): Promise<void> {
  for (const [name, { check }] of Object.entries(creationKeyProtections)) {
    try {
      await check(await creationKeyFixture(pool))
    } catch (error) {
      if (error instanceof Error) error.message = `[${name}] ${error.message}`
      throw error
    }
  }
}
