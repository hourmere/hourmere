// Behavioural assertions for every protection in 0083_routing_form_operations.sql. The storage
// test runs them one by one on a migrated database; the constraint-coverage test drops each
// catalog object in turn and requires one of them to fail; the mutation test applies each
// protection's source-copy mutants to the migration and requires its check to fail. Each check
// builds its own fixture and touches only its own rows, so one database serves every check.
import { randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'
import { reuseConnectionsAfterErrors } from './testing.ts'

export const operationsMigration = '0083_routing_form_operations.sql'
export const operationsTable = 'routing_form_operations'

type Expected = { code: string; constraint?: string; column?: string }
const check = (constraint: string): Expected => ({ code: '23514', constraint })
const unique = (constraint: string): Expected => ({ code: '23505', constraint })
const foreignKey = (constraint: string): Expected => ({ code: '23503', constraint })
const notNull = (column: string): Expected => ({ code: '23502', column })

type Connection = pg.Pool | pg.PoolClient

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

async function insertRow(db: Connection, table: string, values: Record<string, unknown>) {
  const fields = Object.keys(values)
  return (
    await db.query<{ id: string }>(
      `INSERT INTO ${table} (${fields.join(',')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      Object.values(values),
    )
  ).rows[0]?.id as string
}

export async function operationsFixture(database: pg.Pool) {
  // Checks expect many failed statements; keep one connection instead of one per failure.
  const pool = reuseConnectionsAfterErrors(database)
  const creator = (
    await pool.query<{ id: string }>(
      `INSERT INTO auth."user" (name,email,"emailVerified") VALUES ($1,$2,true) RETURNING id`,
      ['Synthetic routing author', `${randomUUID()}@example.test`],
    )
  ).rows[0]?.id as string
  const organization = async (label: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO auth.organization (name,slug,"createdAt") VALUES ($1,$2,now()) RETURNING id`,
        [`Synthetic routing ${label}`, randomUUID()],
      )
    ).rows[0]?.id as string
  const team = await organization('team')
  const otherTeam = await organization('other team')
  const form = (organizationId: string) =>
    insertRow(pool, 'routing_forms', {
      organization_id: organizationId,
      slug: `form-${randomUUID()}`,
      created_by_user_id: creator,
      draft: JSON.stringify({
        title: 'Qualification 東京',
        questions: [],
        rules: [],
        fallback: { kind: 'message', message: 'Thank you' },
      }),
    })
  const version = (organizationId: string, formId: string, number: number) =>
    insertRow(pool, 'routing_form_versions', {
      organization_id: organizationId,
      form_id: formId,
      version_number: number,
      questions: '[]',
      rules: '[]',
      fallback: JSON.stringify({ kind: 'message', message: 'Thank you' }),
      published_by_user_id: creator,
    })
  const teamForm = await form(team)
  const sibling = await form(team)
  const otherForm = await form(otherTeam)
  return {
    pool,
    team,
    otherTeam,
    form: teamForm,
    sibling,
    otherForm,
    version: await version(team, teamForm, 1),
    later: await version(team, teamForm, 2),
    siblingVersion: await version(team, sibling, 1),
    otherVersion: await version(otherTeam, otherForm, 1),
  }
}
export type OperationsFixture = Awaited<ReturnType<typeof operationsFixture>>

/** A valid record of a keyed creation of the team's form. */
export const createRecord = (f: OperationsFixture, overrides: Record<string, unknown> = {}) => ({
  organization_id: f.team,
  operation: 'create',
  actor_scope_digest: randomBytes(32),
  request_id: randomUUID(),
  request_fingerprint: randomBytes(32),
  form_id: f.form,
  ...overrides,
})

/** A valid record of a keyed publication of the team form's first version. */
export const publishRecord = (f: OperationsFixture, overrides: Record<string, unknown> = {}) =>
  createRecord(f, { operation: 'publish', version_id: f.version, ...overrides })

const insertRecord = (db: Connection, values: Record<string, unknown>) =>
  insertRow(db, operationsTable, values)

const records = async (f: OperationsFixture, ids: string[]) =>
  (
    await f.pool.query<{ id: string }>(
      `SELECT id FROM ${operationsTable} WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    )
  ).rows.map(({ id }) => id)

/** Whether another session can lock the organization row, i.e. nobody holds a lock on it. */
async function organizationUnlocked(pool: pg.Pool, organization: string) {
  // FOR UPDATE conflicts with FOR KEY SHARE, and SKIP LOCKED returns no row instead of
  // waiting, so a missing lock is a plain value mismatch.
  const { rows } = await pool.query(
    'SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE SKIP LOCKED',
    [organization],
  )
  return rows.length === 1
}

export interface OperationsMutant {
  name: string
  apply: (source: string) => string
}
export interface OperationsProtection {
  /** Catalog objects (constraint, trigger, NOT NULL column) and trigger rules covered. */
  objects: string[]
  check: (f: OperationsFixture) => Promise<void>
  mutants: OperationsMutant[]
}

/** A source-copy mutant that replaces exactly one occurrence of `before`. */
const mutant = (name: string, before: string, after = ''): OperationsMutant => ({
  name,
  apply: (source) => {
    const count = source.split(before).length - 1
    if (count !== 1) throw new Error(`mutant "${name}" matches ${count} times`)
    return source.replace(before, () => after)
  },
})

const REQUIRED = [
  'organization_id',
  'operation',
  'actor_scope_digest',
  'request_id',
  'request_fingerprint',
  'form_id',
  'created_at',
] as const

export const operationsProtections: Record<string, OperationsProtection> = {
  'required columns and defaults': {
    objects: REQUIRED.map((column) => `${operationsTable}.${column}`),
    check: async (f) => {
      for (const column of REQUIRED)
        await refused(
          f.pool,
          notNull(column),
          (db) => insertRecord(db, createRecord(f, { [column]: null })),
          column,
        )
      // A new record gets a time-ordered ID and the transaction's time.
      const defaults = await rolledBack(f.pool, async (db) => {
        const id = await accepted(insertRecord(db, publishRecord(f)))
        return (
          await db.query(
            `SELECT substr(id::text,15,1) AS uuid_version,created_at=now() AS created_now
            FROM ${operationsTable} WHERE id=$1`,
            [id],
          )
        ).rows[0]
      })
      expect(defaults).toEqual({ uuid_version: '7', created_now: true })
    },
    mutants: [
      mutant(
        'a record may lack its organization',
        'organization_id uuid NOT NULL REFERENCES auth.organization',
        'organization_id uuid REFERENCES auth.organization',
      ),
      mutant(
        'a record may lack its fingerprint',
        'request_fingerprint bytea NOT NULL',
        'request_fingerprint bytea',
      ),
      mutant('a record may lack its request key', 'request_id uuid NOT NULL,', 'request_id uuid,'),
      mutant('a record may lack its form', 'form_id uuid NOT NULL,', 'form_id uuid,'),
      mutant(
        'records get random IDs',
        'id uuid PRIMARY KEY DEFAULT uuidv7(),',
        'id uuid PRIMARY KEY DEFAULT gen_random_uuid(),',
      ),
      mutant(
        'records are stamped at the epoch',
        'created_at timestamptz NOT NULL DEFAULT now(),',
        "created_at timestamptz NOT NULL DEFAULT 'epoch',",
      ),
    ],
  },

  'record identity': {
    objects: [`${operationsTable}_pkey`],
    check: async (f) => {
      const id = randomUUID()
      await accepted(insertRecord(f.pool, createRecord(f, { id })))
      await refused(f.pool, unique(`${operationsTable}_pkey`), (db) =>
        insertRecord(db, createRecord(f, { id, form_id: f.sibling })),
      )
    },
    mutants: [
      mutant(
        'record IDs may repeat',
        'id uuid PRIMARY KEY DEFAULT uuidv7(),',
        'id uuid NOT NULL DEFAULT uuidv7(),',
      ),
    ],
  },

  'operation vocabulary': {
    objects: [`${operationsTable}_operation_check`],
    check: async (f) => {
      for (const operation of ['archive', 'update', 'Create', 'PUBLISH', ''])
        await refused(
          f.pool,
          check(`${operationsTable}_operation_check`),
          (db) => insertRecord(db, createRecord(f, { operation })),
          operation,
        )
      await rolledBack(f.pool, async (db) => {
        await accepted(insertRecord(db, createRecord(f)), 'create')
        await accepted(insertRecord(db, publishRecord(f)), 'publish')
      })
    },
    mutants: [
      mutant(
        'archives are recorded too',
        "CHECK (operation IN ('create', 'publish'))",
        "CHECK (operation IN ('create', 'publish', 'archive'))",
      ),
      mutant(
        'any operation name is accepted',
        "CHECK (operation IN ('create', 'publish'))",
        "CHECK (operation <> '')",
      ),
    ],
  },

  'digest lengths': {
    objects: [
      `${operationsTable}_actor_scope_digest_check`,
      `${operationsTable}_request_fingerprint_check`,
    ],
    check: async (f) => {
      for (const column of ['actor_scope_digest', 'request_fingerprint']) {
        for (const length of [0, 16, 31, 33, 64])
          await refused(
            f.pool,
            check(`${operationsTable}_${column}_check`),
            (db) => insertRecord(db, createRecord(f, { [column]: randomBytes(length) })),
            `${column} of ${length} bytes`,
          )
        await rolledBack(f.pool, (db) =>
          accepted(insertRecord(db, createRecord(f, { [column]: randomBytes(32) })), column),
        )
      }
    },
    mutants: [
      mutant(
        'longer actor digests are accepted',
        'octet_length(actor_scope_digest) = 32',
        'octet_length(actor_scope_digest) >= 32',
      ),
      mutant(
        'shorter actor digests are accepted',
        'octet_length(actor_scope_digest) = 32',
        'octet_length(actor_scope_digest) <= 32',
      ),
      mutant(
        'longer fingerprints are accepted',
        'octet_length(request_fingerprint) = 32',
        'octet_length(request_fingerprint) >= 32',
      ),
      mutant(
        'shorter fingerprints are accepted',
        'octet_length(request_fingerprint) = 32',
        'octet_length(request_fingerprint) <= 32',
      ),
    ],
  },

  'result shape': {
    objects: [`${operationsTable}_result_shape`],
    check: async (f) => {
      const shape = check(`${operationsTable}_result_shape`)
      await refused(
        f.pool,
        shape,
        (db) => insertRecord(db, createRecord(f, { version_id: f.version })),
        'a creation that names a version',
      )
      await refused(
        f.pool,
        shape,
        (db) => insertRecord(db, publishRecord(f, { version_id: null })),
        'a publication without its version',
      )
    },
    mutants: [
      mutant(
        'a creation may name a version',
        "CHECK ((operation = 'publish') = (version_id IS NOT NULL))",
        "CHECK (operation = 'create' OR version_id IS NOT NULL)",
      ),
      mutant(
        'a publication may lack its version',
        "CHECK ((operation = 'publish') = (version_id IS NOT NULL))",
        "CHECK (operation = 'publish' OR version_id IS NULL)",
      ),
    ],
  },

  'request key scope': {
    objects: [`${operationsTable}_request_key`],
    check: async (f) => {
      const actor = randomBytes(32)
      const requestId = randomUUID()
      const key = { actor_scope_digest: actor, request_id: requestId }
      await accepted(insertRecord(f.pool, createRecord(f, key)))
      // One key names one request of its credential in its organization, whatever operation.
      await refused(
        f.pool,
        unique(`${operationsTable}_request_key`),
        (db) => insertRecord(db, publishRecord(f, key)),
        'the same key for a publication',
      )
      await refused(
        f.pool,
        unique(`${operationsTable}_request_key`),
        (db) => insertRecord(db, createRecord(f, { ...key, form_id: f.sibling })),
        'the same key for another creation',
      )
      await rolledBack(f.pool, async (db) => {
        await accepted(
          insertRecord(db, publishRecord(f, { request_id: requestId })),
          'the same key of another credential',
        )
        await accepted(
          insertRecord(
            db,
            createRecord(f, { ...key, organization_id: f.otherTeam, form_id: f.otherForm }),
          ),
          'the same key in another organization',
        )
      })
    },
    mutants: [
      mutant(
        'keys are scoped per operation',
        'UNIQUE (organization_id, actor_scope_digest, request_id)',
        'UNIQUE (organization_id, operation, actor_scope_digest, request_id)',
      ),
      mutant(
        'keys are shared by every credential',
        'UNIQUE (organization_id, actor_scope_digest, request_id)',
        'UNIQUE (organization_id, request_id)',
      ),
      mutant(
        'keys are shared across organizations',
        'UNIQUE (organization_id, actor_scope_digest, request_id)',
        'UNIQUE (actor_scope_digest, request_id)',
      ),
    ],
  },

  'one record per result': {
    objects: [`${operationsTable}_result_key`],
    check: async (f) => {
      const result = unique(`${operationsTable}_result_key`)
      await accepted(insertRecord(f.pool, createRecord(f)))
      await accepted(insertRecord(f.pool, publishRecord(f)))
      await refused(f.pool, result, (db) => insertRecord(db, createRecord(f)), 'a second creation')
      await refused(
        f.pool,
        result,
        (db) => insertRecord(db, publishRecord(f)),
        'a second publication of one version',
      )
      await rolledBack(f.pool, async (db) => {
        await accepted(
          insertRecord(db, publishRecord(f, { version_id: f.later })),
          'a publication of the next version',
        )
        await accepted(
          insertRecord(db, createRecord(f, { form_id: f.sibling })),
          'the creation of another form',
        )
      })
    },
    mutants: [
      mutant(
        'a form may have several creation records',
        'UNIQUE NULLS NOT DISTINCT (organization_id, form_id, version_id)',
        'UNIQUE (organization_id, form_id, version_id)',
      ),
      mutant(
        'a form has one record in all',
        'UNIQUE NULLS NOT DISTINCT (organization_id, form_id, version_id)',
        'UNIQUE NULLS NOT DISTINCT (organization_id, form_id)',
      ),
    ],
  },

  'organization reference and lock': {
    objects: [`${operationsTable}_organization_id_fkey`],
    check: async (f) => {
      // An insert locks its organization row, as the other routing rows do: an organization
      // deletion that starts meanwhile waits for it instead of deadlocking in its cascade.
      await rolledBack(f.pool, async (db) => {
        await accepted(insertRecord(db, createRecord(f)))
        expect(await organizationUnlocked(f.pool, f.team), 'the team row is locked').toBe(false)
        expect(await organizationUnlocked(f.pool, f.otherTeam), 'the control is free').toBe(true)
      })
      // Deleting the organization deletes its records, and only its own.
      const own = await accepted(insertRecord(f.pool, publishRecord(f)))
      const other = await accepted(
        insertRecord(
          f.pool,
          createRecord(f, { organization_id: f.otherTeam, form_id: f.otherForm }),
        ),
      )
      await accepted(f.pool.query('DELETE FROM auth.organization WHERE id=$1', [f.team]))
      expect(await records(f, [own, other])).toEqual([other])
    },
    mutants: [
      mutant(
        'records leave their organization row unlocked',
        'organization_id uuid NOT NULL REFERENCES auth.organization (id) ON DELETE CASCADE,',
        'organization_id uuid NOT NULL,',
      ),
    ],
  },

  'form reference': {
    objects: [`${operationsTable}_form_fk`],
    check: async (f) => {
      const form = foreignKey(`${operationsTable}_form_fk`)
      await refused(
        f.pool,
        form,
        (db) => insertRecord(db, createRecord(f, { form_id: f.otherForm })),
        "another organization's form",
      )
      await refused(
        f.pool,
        form,
        (db) => insertRecord(db, createRecord(f, { form_id: randomUUID() })),
        'an unknown form',
      )
      // A record goes with its form, so it never outlives the result it returns.
      const created = await accepted(insertRecord(f.pool, createRecord(f, { form_id: f.sibling })))
      const kept = await accepted(insertRecord(f.pool, createRecord(f)))
      await accepted(f.pool.query('DELETE FROM routing_forms WHERE id=$1', [f.sibling]))
      expect(await records(f, [created, kept])).toEqual([kept])
    },
    mutants: [
      mutant(
        'records name forms of any organization',
        'FOREIGN KEY (organization_id, form_id)\n    REFERENCES routing_forms (organization_id, id)',
        'FOREIGN KEY (form_id)\n    REFERENCES routing_forms (id)',
      ),
      mutant(
        'records block the deletion of their form',
        'REFERENCES routing_forms (organization_id, id) ON DELETE CASCADE',
        'REFERENCES routing_forms (organization_id, id) ON DELETE NO ACTION',
      ),
    ],
  },

  'version reference': {
    objects: [`${operationsTable}_version_fk`],
    check: async (f) => {
      const version = foreignKey(`${operationsTable}_version_fk`)
      for (const [label, versionId] of [
        ['a version of another form', f.siblingVersion],
        ["a version of another organization's form", f.otherVersion],
        ['an unknown version', randomUUID()],
      ] as const)
        await refused(
          f.pool,
          version,
          (db) => insertRecord(db, publishRecord(f, { version_id: versionId })),
          label,
        )
      // A record goes with its version, so a later version cleanup is never blocked and
      // leaves no record whose result is gone.
      const published = await accepted(
        insertRecord(f.pool, publishRecord(f, { version_id: f.later })),
      )
      const kept = await accepted(insertRecord(f.pool, publishRecord(f)))
      const created = await accepted(insertRecord(f.pool, createRecord(f)))
      await accepted(f.pool.query('DELETE FROM routing_form_versions WHERE id=$1', [f.later]))
      expect(await records(f, [published, kept, created])).toEqual([kept, created].sort())
    },
    mutants: [
      mutant(
        'records name versions of any form',
        'FOREIGN KEY (organization_id, form_id, version_id)\n    REFERENCES routing_form_versions (organization_id, form_id, id)',
        'FOREIGN KEY (organization_id, version_id)\n    REFERENCES routing_form_versions (organization_id, id)',
      ),
      mutant(
        'records block version cleanup',
        'REFERENCES routing_form_versions (organization_id, form_id, id) ON DELETE CASCADE',
        'REFERENCES routing_form_versions (organization_id, form_id, id) ON DELETE NO ACTION',
      ),
      mutant(
        'records outlive their version',
        'REFERENCES routing_form_versions (organization_id, form_id, id) ON DELETE CASCADE',
        'REFERENCES routing_form_versions (organization_id, form_id, id) ON DELETE SET NULL (version_id)',
      ),
    ],
  },

  'immutable records': {
    objects: [`${operationsTable}_guard`, `${operationsTable}_immutable`],
    check: async (f) => {
      const created = await accepted(insertRecord(f.pool, createRecord(f)))
      const published = await accepted(insertRecord(f.pool, publishRecord(f)))
      const immutable = check(`${operationsTable}_immutable`)
      for (const [label, id, assignment, values] of [
        // Every change but the last passes every other check, so only the guard refuses it.
        ['request key', created, 'request_id=$2', [randomUUID()]],
        ['actor', created, 'actor_scope_digest=$2', [randomBytes(32)]],
        ['fingerprint', published, 'request_fingerprint=$2', [randomBytes(32)]],
        ['form', created, 'form_id=$2', [f.sibling]],
        ['version', published, 'version_id=$2', [f.later]],
        ['time', published, "created_at=created_at-interval '1 day'", []],
        ['nothing', published, 'id=id', []],
        ['operation', published, 'operation=$2', ['create']],
      ] as const)
        await refused(
          f.pool,
          immutable,
          (db) =>
            db.query(`UPDATE ${operationsTable} SET ${assignment} WHERE id=$1`, [id, ...values]),
          label,
        )
      // Deletion stays possible: it is how cascades remove records with their result.
      await accepted(f.pool.query(`DELETE FROM ${operationsTable} WHERE id=$1`, [created]))
      expect(await records(f, [created, published])).toEqual([published])
    },
    mutants: [
      mutant(
        'only fingerprints are immutable',
        `BEFORE UPDATE ON ${operationsTable}`,
        `BEFORE UPDATE OF request_fingerprint ON ${operationsTable}`,
      ),
      mutant(
        'records refuse deletion instead of updates',
        `BEFORE UPDATE ON ${operationsTable}`,
        `BEFORE DELETE ON ${operationsTable}`,
      ),
    ],
  },
}

/** Runs every protection on its own fixture; the error names the first failing check. */
export async function assertRoutingOperationProtections(pool: pg.Pool): Promise<void> {
  for (const [name, { check }] of Object.entries(operationsProtections)) {
    try {
      await check(await operationsFixture(pool))
    } catch (error) {
      if (error instanceof Error) error.message = `[${name}] ${error.message}`
      throw error
    }
  }
}
