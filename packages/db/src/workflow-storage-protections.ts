// Behavioural assertions for every protection in 0076_workflow_definitions.sql. The storage
// test runs them one by one on a migrated database; the constraint-coverage test drops each
// catalog object in turn and requires one of them to fail; the mutation test applies each
// protection's source-copy mutants to the migration and requires its check to fail. Each check
// builds its own fixture and touches only its own rows, so one database serves every check.
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import type pg from 'pg'
import { expect } from 'vitest'
import { reuseConnectionsAfterErrors } from './testing.ts'

export const workflowMigration = '0076_workflow_definitions.sql'
export const workflowTables = ['workflow_definitions', 'workflow_revisions'] as const

type Expected = { code: string; constraint?: string; column?: string }
const check = (constraint: string): Expected => ({ code: '23514', constraint })
const foreignKey = (constraint: string): Expected => ({ code: '23503', constraint })
const notNull = (column: string): Expected => ({ code: '23502', column })

/**
 * A stored revision: the canonical definition the workflow contract validated, without the
 * live `enabled` flag, which the definition row carries.
 */
export function revisionContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Prepare for our call',
    scope: { type: 'all_event_types' },
    trigger: { type: 'before_start', offsetMinutes: 60 },
    conditions: [],
    actions: [{ type: 'email', recipients: ['booker'] }],
    ...overrides,
  }
}

/** Runs `action` in a transaction that is always rolled back. */
async function rolledBack<T>(pool: pg.Pool, action: (db: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    return await action(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

/** Runs `action` in a transaction that commits; a failure rolls it back and rethrows. */
async function committed<T>(pool: pg.Pool, action: (db: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await action(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/** A write that must succeed: a stray rejection fails an assertion instead of the run. */
async function accepted<T>(operation: Promise<T>, label?: string): Promise<T> {
  let value: T | undefined
  await expect(
    operation.then((result) => {
      value = result
    }),
    label,
  ).resolves.toBeUndefined()
  return value as T
}

/** `write` runs in a rolled-back transaction and must be refused with `expected`. */
async function refused(
  pool: pg.Pool,
  expected: Expected,
  write: (db: pg.PoolClient) => Promise<unknown>,
  label?: string,
) {
  await rolledBack(pool, async (db) => {
    await expect(write(db), label).rejects.toMatchObject(expected)
  })
}

type Connection = pg.Pool | pg.PoolClient

async function insertDefinition(db: Connection, values: Record<string, unknown>) {
  const fields = Object.keys(values)
  return (
    await db.query<{ id: string }>(
      `INSERT INTO workflow_definitions (${fields.join(',')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      Object.values(values),
    )
  ).rows[0]?.id as string
}

function insertRevision(
  db: Connection,
  organization: string,
  workflow: string,
  revision: number,
  definition: unknown = revisionContent(),
) {
  return db.query(
    'INSERT INTO workflow_revisions (organization_id,workflow_id,revision,definition) VALUES ($1,$2,$3,$4)',
    [organization, workflow, revision, JSON.stringify(definition)],
  )
}

/** One personal owner per user, in that user's personal organization, or a team. */
export interface WorkflowOwnerRow {
  organization: string
  user: string | null
}

export async function workflowFixture(database: pg.Pool) {
  // Checks expect many failed statements; keep one connection instead of one per failure.
  const pool = reuseConnectionsAfterErrors(database)
  const user = async (label: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO auth."user" (name,email,"emailVerified") VALUES ($1,$2,true) RETURNING id`,
        [`Synthetic workflow ${label}`, `${randomUUID()}@example.test`],
      )
    ).rows[0]?.id as string
  const organization = async (label: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO auth.organization (name,slug,"createdAt") VALUES ($1,$2,now()) RETURNING id`,
        [`Synthetic workflow ${label}`, randomUUID()],
      )
    ).rows[0]?.id as string
  const owner = await user('owner')
  const otherUser = await user('other owner')
  const personal = await organization('personal')
  const otherPersonal = await organization('other personal')
  const team = await organization('team')
  const otherTeam = await organization('other team')
  await pool.query(
    'INSERT INTO personal_organizations (user_id,organization_id) VALUES ($1,$2),($3,$4)',
    [owner, personal, otherUser, otherPersonal],
  )
  const personalOwner: WorkflowOwnerRow = { organization: personal, user: owner }
  const teamOwner: WorkflowOwnerRow = { organization: team, user: null }

  /** A definition with its first revision, written in one transaction like a create. */
  const create = (
    by: WorkflowOwnerRow,
    options: { id?: string; enabled?: boolean; definition?: unknown } = {},
  ) =>
    accepted(
      committed(pool, async (db) => {
        const id = await insertDefinition(db, {
          ...(options.id ? { id: options.id } : {}),
          organization_id: by.organization,
          owner_user_id: by.user,
          enabled: options.enabled ?? false,
        })
        await insertRevision(db, by.organization, id, 1, options.definition)
        return id
      }),
      'create a workflow with its first revision',
    )

  const definition = async (id: string) =>
    (
      await pool.query<{
        revision: number
        enabled: boolean
        created_at: Date
        updated_at: Date
        deleted_at: Date | null
      }>(
        'SELECT revision,enabled,created_at,updated_at,deleted_at FROM workflow_definitions WHERE id=$1',
        [id],
      )
    ).rows[0]
  const revisions = async (id: string) =>
    (
      await pool.query<{ revision: number }>(
        'SELECT revision FROM workflow_revisions WHERE workflow_id=$1 ORDER BY revision',
        [id],
      )
    ).rows.map(({ revision }) => revision)

  return {
    pool,
    owner,
    otherUser,
    personal,
    otherPersonal,
    team,
    otherTeam,
    personalOwner,
    teamOwner,
    create,
    definition,
    revisions,
  }
}
export type WorkflowFixture = Awaited<ReturnType<typeof workflowFixture>>

/** Whether another session can lock the organization row, i.e. nobody holds a lock on it. */
async function organizationUnlocked(pool: pg.Pool, organization: string) {
  const { rows } = await pool.query(
    'SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE SKIP LOCKED',
    [organization],
  )
  return rows.length === 1
}

/** Waits until session `pid` waits for a lock, so the next step happens while it waits. */
async function untilBlocked(pool: pg.Pool, pid: number) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await pool.query<{ wait: string | null }>(
      'SELECT wait_event_type AS wait FROM pg_stat_activity WHERE pid=$1',
      [pid],
    )
    if (rows[0]?.wait === 'Lock') return
    await setTimeout(25)
  }
  expect.fail('the second writer never waited for the first')
}

export interface WorkflowMutant {
  name: string
  apply: (source: string) => string
}
export interface WorkflowProtection {
  /** Catalog objects (constraint, index, trigger, NOT NULL column) and trigger rules covered. */
  objects: string[]
  check: (f: WorkflowFixture) => Promise<void>
  mutants: WorkflowMutant[]
}

/** A source-copy mutant that replaces exactly one occurrence of `before`. */
const mutant = (name: string, before: string, after = ''): WorkflowMutant => ({
  name,
  apply: (source) => {
    const count = source.split(before).length - 1
    if (count !== 1) throw new Error(`mutant "${name}" matches ${count} times`)
    return source.replace(before, () => after)
  },
})

const conditionFields = ['event_type', 'booking_source', 'answer', 'location_kind', 'guest_count']
const conditionFor = (field: string) => ({ field, operator: 'equals', value: 'x' })

export const workflowProtections: Record<string, WorkflowProtection> = {
  'required columns and defaults': {
    objects: [
      'workflow_definitions.organization_id',
      'workflow_definitions.revision',
      'workflow_definitions.enabled',
      'workflow_definitions.created_at',
      'workflow_definitions.updated_at',
      'workflow_revisions.definition',
      'workflow_revisions.created_at',
    ],
    check: async (f) => {
      await refused(f.pool, notNull('organization_id'), (db) =>
        insertDefinition(db, { organization_id: null }),
      )
      for (const column of ['revision', 'enabled', 'created_at', 'updated_at'])
        await refused(
          f.pool,
          notNull(column),
          (db) => insertDefinition(db, { organization_id: f.team, [column]: null }),
          column,
        )
      await refused(f.pool, notNull('definition'), async (db) => {
        const id = await insertDefinition(db, { organization_id: f.team })
        await db.query(
          'INSERT INTO workflow_revisions (organization_id,workflow_id,revision,definition) VALUES ($1,$2,1,NULL)',
          [f.team, id],
        )
      })
      await refused(f.pool, notNull('created_at'), async (db) => {
        const id = await insertDefinition(db, { organization_id: f.team })
        await db.query(
          'INSERT INTO workflow_revisions (organization_id,workflow_id,revision,definition,created_at) VALUES ($1,$2,1,$3,NULL)',
          [f.team, id, JSON.stringify(revisionContent())],
        )
      })
      // A new definition is disabled, at its first revision, owned by nobody else and live.
      const defaults = await rolledBack(f.pool, async (db) => {
        const id = await accepted(insertDefinition(db, { organization_id: f.team }))
        await accepted(insertRevision(db, f.team, id, 1))
        return (
          await db.query(
            `SELECT d.revision,d.enabled,d.owner_user_id,d.deleted_at,
              d.created_at=now() AS created_now,d.updated_at=now() AS updated_now,
              r.created_at=now() AS revision_now
            FROM workflow_definitions d JOIN workflow_revisions r ON r.workflow_id=d.id
            WHERE d.id=$1`,
            [id],
          )
        ).rows[0]
      })
      expect(defaults).toEqual({
        revision: 1,
        enabled: false,
        owner_user_id: null,
        deleted_at: null,
        created_now: true,
        updated_now: true,
        revision_now: true,
      })
    },
    mutants: [
      mutant(
        'a new definition is enabled',
        'enabled boolean NOT NULL DEFAULT false',
        'enabled boolean NOT NULL DEFAULT true',
      ),
      mutant(
        'a new definition starts at revision 2',
        'revision integer NOT NULL DEFAULT 1,',
        'revision integer NOT NULL DEFAULT 2,',
      ),
      mutant(
        'a definition may lack its organization',
        'organization_id uuid NOT NULL REFERENCES auth.organization',
        'organization_id uuid REFERENCES auth.organization',
      ),
      mutant(
        'a revision may store no definition',
        'definition jsonb NOT NULL,',
        'definition jsonb,',
      ),
      mutant(
        'a definition may lack its update time',
        'updated_at timestamptz NOT NULL DEFAULT now(),',
        'updated_at timestamptz DEFAULT now(),',
      ),
    ],
  },

  'definition identity': {
    objects: ['workflow_definitions_pkey'],
    check: async (f) => {
      const id = randomUUID()
      await f.create(f.teamOwner, { id })
      // A workflow ID is unique on the instance, not only within one organization.
      await refused(f.pool, { code: '23505', constraint: 'workflow_definitions_pkey' }, (db) =>
        insertDefinition(db, { id, organization_id: f.otherTeam }),
      )
    },
    mutants: [
      mutant(
        'workflow IDs are unique only per organization',
        'id uuid PRIMARY KEY DEFAULT uuidv7(),',
        'id uuid NOT NULL DEFAULT uuidv7(),',
      ),
    ],
  },

  'organization reference and lock': {
    objects: ['workflow_definitions_organization_id_fkey'],
    check: async (f) => {
      // A full create that commits, so the reference is enforced whenever it is checked.
      const unknown = randomUUID()
      await expect(
        committed(f.pool, async (db) => {
          await insertRevision(
            db,
            unknown,
            await insertDefinition(db, { organization_id: unknown }),
            1,
          )
        }),
        'an unknown organization',
      ).rejects.toMatchObject(foreignKey('workflow_definitions_organization_id_fkey'))
      // An insert locks its organization row before anything else, as other organization
      // writers do: a concurrent organization deletion waits instead of deadlocking.
      await rolledBack(f.pool, async (db) => {
        await accepted(insertDefinition(db, { organization_id: f.team }))
        expect(await organizationUnlocked(f.pool, f.team), 'the team row is locked').toBe(false)
        expect(await organizationUnlocked(f.pool, f.otherTeam), 'the control is free').toBe(true)
      })
      // Deleting the organization deletes its live and tombstoned definitions and revisions.
      const live = await f.create(f.teamOwner)
      await accepted(insertRevision(f.pool, f.team, live, 2))
      const tombstone = await f.create(f.teamOwner)
      await accepted(
        f.pool.query('UPDATE workflow_definitions SET deleted_at=now() WHERE id=$1', [tombstone]),
      )
      const other = await f.create({ organization: f.otherTeam, user: null })
      await accepted(f.pool.query('DELETE FROM auth.organization WHERE id=$1', [f.team]))
      expect(await f.definition(live)).toBeUndefined()
      expect(await f.definition(tombstone)).toBeUndefined()
      expect(await f.revisions(live)).toEqual([])
      expect(await f.revisions(tombstone)).toEqual([])
      expect(await f.revisions(other)).toEqual([1])
    },
    mutants: [
      mutant(
        'definitions block their organization deletion',
        'organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,',
        'organization_id uuid NOT NULL REFERENCES auth.organization (id),',
      ),
      mutant(
        'the organization reference is checked only at commit',
        'organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,',
        'organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,',
      ),
    ],
  },

  'personal owner reference': {
    objects: ['workflow_definitions_owner_user_id_fkey'],
    check: async (f) => {
      const kept = await f.create(f.personalOwner)
      const other = await f.create({ organization: f.otherPersonal, user: f.otherUser })
      // Without the personal marker, deleting the user keeps the organization; the user's
      // personal definitions still go with the user.
      await accepted(f.pool.query('DELETE FROM personal_organizations WHERE user_id=$1', [f.owner]))
      await accepted(f.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.owner]))
      expect(await f.definition(kept)).toBeUndefined()
      expect(await f.revisions(kept)).toEqual([])
      const { rows } = await f.pool.query('SELECT id FROM auth.organization WHERE id=$1', [
        f.personal,
      ])
      expect(rows).toHaveLength(1)
      // The usual path: the user's personal organization goes with the user.
      await accepted(f.pool.query('DELETE FROM auth."user" WHERE id=$1', [f.otherUser]))
      expect(await f.definition(other)).toBeUndefined()
      expect(await f.revisions(other)).toEqual([])
    },
    mutants: [
      mutant(
        'personal definitions block their owner deletion',
        'owner_user_id uuid REFERENCES auth."user" (id) ON DELETE CASCADE,',
        'owner_user_id uuid REFERENCES auth."user" (id),',
      ),
    ],
  },

  'owner shape': {
    objects: ['workflow_definitions_guard', 'workflow_definitions_owner'],
    check: async (f) => {
      const owner = check('workflow_definitions_owner')
      // A personal definition lives in its owner's own personal organization only.
      await refused(
        f.pool,
        owner,
        (db) => insertDefinition(db, { organization_id: f.team, owner_user_id: f.owner }),
        'a personal owner in a team',
      )
      await refused(
        f.pool,
        owner,
        (db) => insertDefinition(db, { organization_id: f.otherPersonal, owner_user_id: f.owner }),
        "a personal owner in another user's personal organization",
      )
      // A team definition belongs to a team, never to a personal organization.
      await refused(
        f.pool,
        owner,
        (db) => insertDefinition(db, { organization_id: f.personal }),
        'a team definition in a personal organization',
      )
      await f.create(f.personalOwner)
      await f.create(f.teamOwner)
    },
    mutants: [
      mutant(
        'team definitions in personal organizations',
        `    IF (NEW.owner_user_id IS NULL AND EXISTS (SELECT FROM public.personal_organizations
          WHERE organization_id = NEW.organization_id))
       OR (`,
        '    IF (',
      ),
      mutant(
        'personal definitions in any organization of a personal owner',
        'WHERE user_id = NEW.owner_user_id AND organization_id = NEW.organization_id)) THEN',
        'WHERE user_id = NEW.owner_user_id)) THEN',
      ),
      mutant(
        "personal definitions in another user's personal organization",
        'WHERE user_id = NEW.owner_user_id AND organization_id = NEW.organization_id)) THEN',
        'WHERE organization_id = NEW.organization_id)) THEN',
      ),
    ],
  },

  'identity and ownership are immutable': {
    objects: ['workflow_definitions_identity_immutable'],
    check: async (f) => {
      const team = await f.create(f.teamOwner)
      const personal = await f.create(f.personalOwner)
      const immutable = check('workflow_definitions_identity_immutable')
      for (const [label, id, assignment, params] of [
        ['ID', team, 'id=$2', [randomUUID()]],
        ['organization', team, 'organization_id=$2', [f.otherTeam]],
        ['owner', personal, 'owner_user_id=NULL', []],
        ['team to personal owner', team, 'owner_user_id=$2', [f.owner]],
        ['creation time', team, "created_at=created_at-interval '1 day'", []],
      ] as const)
        await refused(
          f.pool,
          immutable,
          (db) =>
            db.query(`UPDATE workflow_definitions SET ${assignment} WHERE id=$1`, [id, ...params]),
          label,
        )
    },
    mutants: [
      ['id', 'OLD.id, NEW.organization_id, NEW.owner_user_id, NEW.created_at'],
      ['organization', 'NEW.id, OLD.organization_id, NEW.owner_user_id, NEW.created_at'],
      ['owner', 'NEW.id, NEW.organization_id, OLD.owner_user_id, NEW.created_at'],
      ['creation time', 'NEW.id, NEW.organization_id, NEW.owner_user_id, OLD.created_at'],
    ].map(([column, row]) =>
      mutant(
        `the ${column} is mutable`,
        'IF ROW(NEW.id, NEW.organization_id, NEW.owner_user_id, NEW.created_at)',
        `IF ROW(${row})`,
      ),
    ),
  },

  'current revision': {
    objects: ['workflow_definitions_current_revision', 'workflow_definitions_revision_monotonic'],
    check: async (f) => {
      const workflow = await f.create(f.teamOwner)
      // The current revision always exists, checked when the transaction commits.
      const current = foreignKey('workflow_definitions_current_revision')
      const commit = (write: (db: pg.PoolClient) => Promise<unknown>) =>
        rolledBack(f.pool, async (db) => {
          await accepted(write(db))
          await db.query('COMMIT')
        })
      await expect(
        commit((db) => insertDefinition(db, { organization_id: f.team })),
        'a definition without a revision',
      ).rejects.toMatchObject(current)
      await expect(
        commit((db) =>
          db.query('UPDATE workflow_definitions SET revision=2 WHERE id=$1', [workflow]),
        ),
        'a missing current revision',
      ).rejects.toMatchObject(current)
      await accepted(insertRevision(f.pool, f.team, workflow, 2))
      await refused(
        f.pool,
        check('workflow_definitions_revision_monotonic'),
        (db) => db.query('UPDATE workflow_definitions SET revision=1 WHERE id=$1', [workflow]),
        'back to an earlier revision',
      )
      expect((await f.definition(workflow))?.revision).toBe(2)
    },
    mutants: [
      mutant(
        'the current revision is checked per statement',
        '  REFERENCES workflow_revisions (organization_id, workflow_id, revision)\n  DEFERRABLE INITIALLY DEFERRED;',
        '  REFERENCES workflow_revisions (organization_id, workflow_id, revision);',
      ),
      mutant(
        'the current revision can go back',
        '  IF NEW.revision < OLD.revision THEN',
        '  IF NEW.revision < OLD.revision - 1 THEN',
      ),
    ],
  },

  'revision numbering and locks': {
    objects: ['workflow_revisions_guard', 'workflow_revisions_sequence'],
    check: async (f) => {
      const sequence = check('workflow_revisions_sequence')
      // The first revision is 1 …
      await refused(
        f.pool,
        sequence,
        async (db) => {
          const id = await insertDefinition(db, { organization_id: f.team })
          await insertRevision(db, f.team, id, 2)
        },
        'a first revision 2',
      )
      // … and each next one follows the latest, with no gap and no repeat.
      const workflow = await f.create(f.teamOwner)
      for (const revision of [1, 3])
        await refused(
          f.pool,
          sequence,
          (db) => insertRevision(db, f.team, workflow, revision),
          `revision ${revision} after 1`,
        )
      // A new revision becomes the current one.
      await accepted(insertRevision(f.pool, f.team, workflow, 2))
      expect(await f.revisions(workflow)).toEqual([1, 2])
      expect((await f.definition(workflow))?.revision).toBe(2)
      // It locks the organization first, as other organization writers do.
      await rolledBack(f.pool, async (db) => {
        await accepted(insertRevision(db, f.team, workflow, 3))
        expect(await organizationUnlocked(f.pool, f.team), 'the team row is locked').toBe(false)
      })
      // Concurrent writers of the same next revision: the second waits for the definition
      // and is then refused as out of sequence.
      const first = await f.pool.connect()
      const second = await f.pool.connect()
      let racing: Promise<unknown> = Promise.resolve()
      try {
        await first.query('BEGIN')
        await accepted(insertRevision(first, f.team, workflow, 3))
        const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
          ?.pid as number
        racing = insertRevision(second, f.team, workflow, 3).then(
          () => undefined,
          (error: unknown) => error,
        )
        await untilBlocked(f.pool, pid)
        await first.query('COMMIT')
        expect(await racing, 'the second writer').toMatchObject(sequence)
      } finally {
        // Ends the first transaction if it is still open, so the second writer finishes.
        await first.query('ROLLBACK')
        await racing
        first.release()
        second.release()
      }
      expect(await f.revisions(workflow)).toEqual([1, 2, 3])
    },
    mutants: [
      mutant(
        'revisions may skip numbers',
        '  IF NEW.revision IS DISTINCT FROM coalesce(latest, 0) + 1 THEN',
        '  IF NEW.revision <= coalesce(latest, 0) THEN',
      ),
      mutant(
        'a new revision does not become current',
        `  IF NEW.revision > parent.revision THEN
    UPDATE public.workflow_definitions SET revision = NEW.revision
      WHERE organization_id = NEW.organization_id AND id = NEW.workflow_id;
  END IF;
`,
      ),
      mutant(
        'concurrent revisions are not serialized on the definition',
        'WHERE organization_id = NEW.organization_id AND id = NEW.workflow_id FOR UPDATE;',
        'WHERE organization_id = NEW.organization_id AND id = NEW.workflow_id;',
      ),
      mutant(
        'a new revision leaves the organization unlocked',
        '  PERFORM FROM auth.organization WHERE id = NEW.organization_id FOR KEY SHARE;\n',
      ),
    ],
  },

  'revisions are immutable': {
    objects: ['workflow_revisions_immutable', 'workflow_revisions_retained'],
    check: async (f) => {
      const workflow = await f.create(f.personalOwner)
      const immutable = check('workflow_revisions_immutable')
      for (const assignment of [
        `definition=jsonb_set(definition,'{name}','"Changed"')`,
        "created_at=created_at-interval '1 day'",
        'revision=revision',
      ])
        await refused(
          f.pool,
          immutable,
          (db) =>
            db.query(`UPDATE workflow_revisions SET ${assignment} WHERE workflow_id=$1`, [
              workflow,
            ]),
          assignment,
        )
      // A revision is removed only with its definition, tombstoned or not.
      const retained = check('workflow_revisions_retained')
      await refused(f.pool, retained, (db) =>
        db.query('DELETE FROM workflow_revisions WHERE workflow_id=$1', [workflow]),
      )
      await accepted(
        f.pool.query('UPDATE workflow_definitions SET deleted_at=now() WHERE id=$1', [workflow]),
      )
      await refused(f.pool, retained, (db) =>
        db.query('DELETE FROM workflow_revisions WHERE workflow_id=$1', [workflow]),
      )
      expect(await f.revisions(workflow)).toEqual([1])
    },
    mutants: [
      mutant(
        'revisions can be rewritten',
        `  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'workflow revisions are immutable'`,
        `  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
    RAISE EXCEPTION 'workflow revisions are immutable'`,
      ),
      mutant(
        'revisions can be deleted on their own',
        `    IF EXISTS (SELECT FROM public.workflow_definitions
        WHERE organization_id = OLD.organization_id AND id = OLD.workflow_id) THEN`,
        '    IF false THEN',
      ),
    ],
  },

  tombstones: {
    objects: [
      'workflow_definitions_deleted_disabled',
      'workflow_definitions_deleted_final',
      'workflow_definitions_tombstone_first',
      'workflow_revisions_deleted',
    ],
    check: async (f) => {
      const workflow = await f.create(f.teamOwner, { enabled: true })
      // A tombstone is disabled.
      const disabled = check('workflow_definitions_deleted_disabled')
      await refused(f.pool, disabled, (db) =>
        db.query('UPDATE workflow_definitions SET deleted_at=now() WHERE id=$1', [workflow]),
      )
      await refused(f.pool, disabled, (db) =>
        insertDefinition(db, { organization_id: f.team, enabled: true, deleted_at: new Date() }),
      )
      // A live definition is tombstoned before it can be removed.
      await refused(f.pool, check('workflow_definitions_tombstone_first'), (db) =>
        db.query('DELETE FROM workflow_definitions WHERE id=$1', [workflow]),
      )
      await accepted(
        f.pool.query('UPDATE workflow_definitions SET enabled=false,deleted_at=now() WHERE id=$1', [
          workflow,
        ]),
      )
      // A tombstone is final and takes no new revision.
      await refused(f.pool, check('workflow_definitions_deleted_final'), (db) =>
        db.query('UPDATE workflow_definitions SET deleted_at=NULL WHERE id=$1', [workflow]),
      )
      await refused(f.pool, check('workflow_revisions_deleted'), (db) =>
        insertRevision(db, f.team, workflow, 2),
      )
      expect(await f.definition(workflow)).toMatchObject({ revision: 1, enabled: false })
      // Purging a tombstone removes the definition and its revisions.
      await accepted(f.pool.query('DELETE FROM workflow_definitions WHERE id=$1', [workflow]))
      expect(await f.definition(workflow)).toBeUndefined()
      expect(await f.revisions(workflow)).toEqual([])
    },
    mutants: [
      mutant(
        'an enabled tombstone',
        'CHECK (deleted_at IS NULL OR NOT enabled)',
        'CHECK (deleted_at IS NULL OR enabled IS NOT NULL)',
      ),
      mutant(
        'a tombstone can be revived',
        `  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a deleted workflow is final'`,
        `  IF false THEN
    RAISE EXCEPTION 'a deleted workflow is final'`,
      ),
      mutant(
        'a live definition can be removed',
        `    IF OLD.deleted_at IS NULL
       AND EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)`,
        `    IF false
       AND EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)`,
      ),
      mutant(
        'a tombstone cannot be purged',
        `    IF OLD.deleted_at IS NULL
       AND EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)`,
        `    IF EXISTS (SELECT FROM auth.organization WHERE id = OLD.organization_id)`,
      ),
      mutant(
        'a tombstone takes a new revision',
        `  IF parent.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'a deleted workflow takes no new revision'`,
        `  IF false THEN
    RAISE EXCEPTION 'a deleted workflow takes no new revision'`,
      ),
    ],
  },

  'revision workflow reference': {
    objects: ['workflow_revisions_workflow'],
    check: async (f) => {
      const reference = foreignKey('workflow_revisions_workflow')
      await refused(
        f.pool,
        reference,
        (db) => insertRevision(db, f.team, randomUUID(), 1),
        'an unknown workflow',
      )
      // A revision belongs to its workflow's organization.
      const workflow = await f.create(f.teamOwner)
      await refused(
        f.pool,
        reference,
        (db) => insertRevision(db, f.otherTeam, workflow, 2),
        'another organization',
      )
      expect(await f.revisions(workflow)).toEqual([1])
      // Removing the definition removes its revisions.
      await accepted(
        f.pool.query('UPDATE workflow_definitions SET deleted_at=now() WHERE id=$1', [workflow]),
      )
      await accepted(f.pool.query('DELETE FROM workflow_definitions WHERE id=$1', [workflow]))
      expect(await f.revisions(workflow)).toEqual([])
    },
    mutants: [
      mutant(
        'a revision may name another organization',
        `CONSTRAINT workflow_revisions_workflow FOREIGN KEY (organization_id, workflow_id)
    REFERENCES workflow_definitions (organization_id, id) ON DELETE CASCADE,`,
        `CONSTRAINT workflow_revisions_workflow FOREIGN KEY (workflow_id)
    REFERENCES workflow_definitions (id) ON DELETE CASCADE,`,
      ),
      mutant(
        'revisions block their definition removal',
        '    REFERENCES workflow_definitions (organization_id, id) ON DELETE CASCADE,',
        '    REFERENCES workflow_definitions (organization_id, id),',
      ),
    ],
  },

  'revision content': {
    objects: [
      'workflow_revisions_shape',
      'workflow_revisions_name',
      'workflow_revisions_scope',
      'workflow_revisions_trigger',
      'workflow_revisions_conditions',
      'workflow_revisions_actions',
    ],
    check: async (f) => {
      const workflow = await f.create(f.teamOwner)
      const store = (definition: unknown, db: Connection = f.pool) =>
        insertRevision(db, f.team, workflow, 2, definition)
      // Accepted at every boundary these checks mirror. Each runs in its own rolled-back
      // transaction, so the same next revision number is free each time.
      const valid: [string, Record<string, unknown>][] = [
        ['a name of one byte', { name: 'a' }],
        ['a name of 200 bytes', { name: `${'界'.repeat(66)}ab` }],
        ['one event type', { scope: { type: 'event_type', eventTypeId: randomUUID() } }],
        ...['booking.created', 'booking.cancelled', 'booking.rescheduled'].flatMap(
          (type): [string, Record<string, unknown>][] => [
            [`${type} now`, { trigger: { type, delayMinutes: 0 } }],
            [`${type} at the largest delay`, { trigger: { type, delayMinutes: 43200 } }],
          ],
        ),
        ...['before_start', 'after_end'].flatMap((type): [string, Record<string, unknown>][] => [
          [`${type} at the smallest offset`, { trigger: { type, offsetMinutes: 5 } }],
          [`${type} at the largest offset`, { trigger: { type, offsetMinutes: 43200 } }],
        ]),
        ['five conditions', { conditions: conditionFields.map(conditionFor) }],
        ['a webhook action', { actions: [{ type: 'webhook', webhookId: randomUUID() }] }],
      ]
      for (const [label, overrides] of valid)
        await rolledBack(f.pool, (db) => accepted(store(revisionContent(overrides), db), label))

      const refusals: [string, string, unknown][] = [
        ['workflow_revisions_shape', 'the enabled flag', revisionContent({ enabled: false })],
        ['workflow_revisions_shape', 'an unknown key', revisionContent({ html: '<b>' })],
        ['workflow_revisions_name', 'an empty name', revisionContent({ name: '' })],
        [
          'workflow_revisions_name',
          'a name of 201 bytes',
          revisionContent({ name: 'a'.repeat(201) }),
        ],
        ['workflow_revisions_name', 'a name that is not text', revisionContent({ name: 7 })],
        [
          'workflow_revisions_scope',
          'an unknown scope',
          revisionContent({ scope: { type: 'all' } }),
        ],
        [
          'workflow_revisions_scope',
          'a scope that is not an object',
          revisionContent({ scope: 'all_event_types' }),
        ],
        [
          'workflow_revisions_trigger',
          'an unknown trigger',
          revisionContent({ trigger: { type: 'booking.no_show', delayMinutes: 0 } }),
        ],
        [
          'workflow_revisions_trigger',
          'an offset below 5',
          revisionContent({ trigger: { type: 'before_start', offsetMinutes: 4 } }),
        ],
        [
          'workflow_revisions_trigger',
          'an offset above 43200',
          revisionContent({ trigger: { type: 'after_end', offsetMinutes: 43201 } }),
        ],
        [
          'workflow_revisions_trigger',
          'a fractional offset',
          revisionContent({ trigger: { type: 'after_end', offsetMinutes: 5.5 } }),
        ],
        [
          'workflow_revisions_trigger',
          'an offset as text',
          revisionContent({ trigger: { type: 'after_end', offsetMinutes: '60' } }),
        ],
        [
          'workflow_revisions_trigger',
          'a negative delay',
          revisionContent({ trigger: { type: 'booking.created', delayMinutes: -1 } }),
        ],
        [
          'workflow_revisions_trigger',
          'a delay above 43200',
          revisionContent({ trigger: { type: 'booking.cancelled', delayMinutes: 43201 } }),
        ],
        [
          'workflow_revisions_trigger',
          'a fractional delay',
          revisionContent({ trigger: { type: 'booking.cancelled', delayMinutes: 0.5 } }),
        ],
        [
          'workflow_revisions_trigger',
          'a timer with a second delay',
          revisionContent({
            trigger: { type: 'before_start', offsetMinutes: 60, delayMinutes: 0 },
          }),
        ],
        [
          'workflow_revisions_trigger',
          'a lifecycle trigger with an offset',
          revisionContent({
            trigger: { type: 'booking.created', delayMinutes: 0, offsetMinutes: 60 },
          }),
        ],
        [
          'workflow_revisions_trigger',
          'a lifecycle trigger without its delay',
          revisionContent({ trigger: { type: 'booking.created' } }),
        ],
        [
          'workflow_revisions_conditions',
          'six conditions',
          revisionContent({ conditions: [...conditionFields, 'answer'].map(conditionFor) }),
        ],
        [
          'workflow_revisions_conditions',
          'conditions that are not a list',
          revisionContent({ conditions: {} }),
        ],
        ...[0, 1, 2, 3, 4].map((position): [string, string, unknown] => [
          'workflow_revisions_conditions',
          `an unknown field at position ${position}`,
          revisionContent({
            conditions: conditionFields.map((field, index) =>
              conditionFor(index === position ? 'attendee_no_show' : field),
            ),
          }),
        ]),
        [
          'workflow_revisions_conditions',
          'a field that is not text',
          revisionContent({ conditions: [{ field: ['answer'] }] }),
        ],
        ['workflow_revisions_actions', 'no action', revisionContent({ actions: [] })],
        [
          'workflow_revisions_actions',
          'two actions',
          revisionContent({
            actions: [
              { type: 'email', recipients: ['booker'] },
              { type: 'webhook', webhookId: randomUUID() },
            ],
          }),
        ],
        [
          'workflow_revisions_actions',
          'an unknown action',
          revisionContent({ actions: [{ type: 'sms' }] }),
        ],
      ]
      for (const [constraint, label, definition] of refusals)
        await refused(f.pool, check(constraint), (db) => store(definition, db), label)
    },
    mutants: [
      mutant(
        'any top-level key',
        "\n      AND definition - ARRAY['name', 'scope', 'trigger', 'conditions', 'actions'] = '{}'::jsonb",
      ),
      mutant(
        'a name of 201 bytes',
        "octet_length(definition->>'name') BETWEEN 1 AND 200",
        "octet_length(definition->>'name') BETWEEN 1 AND 201",
      ),
      mutant(
        'an empty name',
        "octet_length(definition->>'name') BETWEEN 1 AND 200",
        "octet_length(definition->>'name') BETWEEN 0 AND 200",
      ),
      mutant(
        'no event-type scope',
        "IN ('all_event_types', 'event_type')",
        "IN ('all_event_types')",
      ),
      mutant(
        'a timer offset of 4 minutes',
        '::numeric BETWEEN 5 AND 43200',
        '::numeric BETWEEN 4 AND 43200',
      ),
      mutant(
        'a timer offset of 43201 minutes',
        '::numeric BETWEEN 5 AND 43200',
        '::numeric BETWEEN 5 AND 43201',
      ),
      mutant(
        'a lifecycle delay above the largest offset',
        '::numeric BETWEEN 0 AND 43200',
        '::numeric BETWEEN 0 AND 43201',
      ),
      mutant(
        'fractional delays',
        `          AND (definition->'trigger'->>'delayMinutes')::numeric
            = trunc((definition->'trigger'->>'delayMinutes')::numeric)`,
      ),
      mutant(
        'a lifecycle trigger with an offset',
        "ARRAY['type', 'delayMinutes']",
        "ARRAY['type', 'delayMinutes', 'offsetMinutes']",
      ),
      mutant(
        'no rescheduled trigger',
        "('booking.created', 'booking.cancelled', 'booking.rescheduled')",
        "('booking.created', 'booking.cancelled')",
      ),
      mutant(
        'six conditions',
        "jsonb_array_length(definition->'conditions') <= 5",
        "jsonb_array_length(definition->'conditions') <= 6",
      ),
      mutant(
        'an unknown field at the last position',
        `      AND (definition->'conditions'->4 IS NULL OR definition->'conditions'->4->>'field'
        IN ('event_type', 'booking_source', 'answer', 'location_kind', 'guest_count'))
`,
      ),
      mutant(
        'two actions',
        "jsonb_array_length(definition->'actions') BETWEEN 1 AND 1",
        "jsonb_array_length(definition->'actions') BETWEEN 1 AND 2",
      ),
      mutant('no webhook action', "IN ('email', 'webhook')", "IN ('email')"),
    ],
  },

  'owner index': {
    objects: ['workflow_definitions_owner_user_id'],
    check: async (f) => {
      await f.create(f.personalOwner)
      // The owner's deletion and per-owner lookups find personal definitions by index.
      const plan = await rolledBack(f.pool, async (db) => {
        await db.query('SET LOCAL enable_seqscan=off')
        return (
          await db.query(
            'EXPLAIN (FORMAT JSON) SELECT id FROM workflow_definitions WHERE owner_user_id=$1',
            [f.owner],
          )
        ).rows[0]?.['QUERY PLAN']
      })
      expect(JSON.stringify(plan)).toContain('"Index Name":"workflow_definitions_owner_user_id"')
    },
    mutants: [
      mutant(
        'only enabled definitions are indexed',
        'ON workflow_definitions (owner_user_id);',
        'ON workflow_definitions (owner_user_id) WHERE enabled;',
      ),
    ],
  },

  'update time': {
    objects: ['workflow_definitions_updated_at'],
    check: async (f) => {
      const workflow = await f.create(f.teamOwner)
      const created = await f.definition(workflow)
      expect(created?.updated_at).toEqual(created?.created_at)
      await accepted(
        f.pool.query('UPDATE workflow_definitions SET enabled=true WHERE id=$1', [workflow]),
      )
      const toggled = await f.definition(workflow)
      expect(toggled?.updated_at.getTime()).toBeGreaterThan(created?.updated_at.getTime() as number)
      // A new revision is a change of the definition too.
      await accepted(insertRevision(f.pool, f.team, workflow, 2))
      expect((await f.definition(workflow))?.updated_at.getTime()).toBeGreaterThan(
        toggled?.updated_at.getTime() as number,
      )
    },
    mutants: [
      mutant(
        'updates keep the creation time',
        'CREATE TRIGGER workflow_definitions_updated_at BEFORE UPDATE',
        'CREATE TRIGGER workflow_definitions_updated_at BEFORE INSERT',
      ),
    ],
  },
}

/** Runs every protection on its own fixture; the error names the first failing check. */
export async function assertWorkflowStorageProtections(pool: pg.Pool): Promise<void> {
  for (const [name, { check }] of Object.entries(workflowProtections)) {
    try {
      await check(await workflowFixture(pool))
    } catch (error) {
      if (error instanceof Error) error.message = `[${name}] ${error.message}`
      throw error
    }
  }
}
