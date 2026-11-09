import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkConstraintCoverage } from './constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

// A toy migration set: 0002 is the migration under test, 0003 adds and removes objects later.
const migrations = {
  '0001_parent.sql': 'CREATE TABLE parent (id integer PRIMARY KEY, code integer CHECK (code > 0));',
  '0002_child.sql': `
CREATE TABLE child (
  id integer PRIMARY KEY,
  parent_id integer NOT NULL REFERENCES parent(id),
  amount integer NOT NULL CHECK (amount > 0),
  note text
);
CREATE INDEX child_note ON child(note);
CREATE INDEX child_parent ON child(parent_id);
CREATE FUNCTION child_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.note = 'forbidden' THEN RAISE EXCEPTION 'forbidden note' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER child_guard BEFORE INSERT ON child FOR EACH ROW EXECUTE FUNCTION child_guard();
ALTER TABLE parent ADD COLUMN label text NOT NULL DEFAULT 'parent';
ALTER TABLE parent DROP CONSTRAINT parent_code_check,
  ADD CONSTRAINT parent_code_check CHECK (code > 1);`,
  '0003_later.sql': `
CREATE TABLE unrelated (id integer PRIMARY KEY CHECK (id > 0));
DROP INDEX child_note;`,
}

const created = [
  'constraint public.child.child_amount_check',
  'constraint public.child.child_parent_id_fkey',
  'constraint public.child.child_pkey',
  'constraint public.parent.parent_code_check',
  'index public.child.child_parent',
  'not_null public.child.amount',
  'not_null public.child.parent_id',
  'not_null public.parent.label',
  'trigger public.child.child_guard',
]

async function rejects(pool: pg.Pool, sql: string, code: string) {
  await expect(pool.query(sql)).rejects.toMatchObject({ code })
}

/** Guards the CHECKs, both child NOT NULL columns and the FK; not the key, index, label or trigger. */
async function partialSuite(pool: pg.Pool) {
  await pool.query('INSERT INTO parent (id) VALUES (1) ON CONFLICT DO NOTHING')
  await rejects(pool, 'INSERT INTO parent (id,code) VALUES (5,1)', '23514')
  await rejects(pool, 'INSERT INTO child (id,parent_id,amount) VALUES (10,1,0)', '23514')
  await rejects(pool, 'INSERT INTO child (id,parent_id,amount) VALUES (11,1,NULL)', '23502')
  await rejects(pool, 'INSERT INTO child (id,parent_id,amount) VALUES (12,NULL,1)', '23502')
  await rejects(pool, 'INSERT INTO child (id,parent_id,amount) VALUES (13,2,1)', '23503')
}

async function fullSuite(pool: pg.Pool) {
  await partialSuite(pool)
  await rejects(
    pool,
    "INSERT INTO child (id,parent_id,amount,note) VALUES (20,1,1,'forbidden')",
    '23514',
  )
  await rejects(pool, 'INSERT INTO child (id,parent_id,amount) VALUES (10,1,1),(10,1,2)', '23505')
  await rejects(pool, 'INSERT INTO parent (id,label) VALUES (3,NULL)', '23502')
}

describe.skipIf(!serverUrl)('constraint coverage helper', () => {
  let directory: string
  let expectationFile: string
  const coverage = (options: Partial<Parameters<typeof checkConstraintCoverage>[0]> = {}) =>
    checkConstraintCoverage({
      serverUrl: serverUrl as string,
      migration: '0002_child.sql',
      migrationsDirectory: directory,
      expectationFile,
      assertions: partialSuite,
      concurrency: 2,
      ...options,
    })
  const writeExpectation = async () => {
    vi.stubEnv('HOURMERE_UPDATE_CONSTRAINT_COVERAGE', '1')
    try {
      await coverage({ assertions: fullSuite })
    } finally {
      vi.unstubAllEnvs()
    }
    return JSON.parse(await readFile(expectationFile, 'utf8')) as {
      migration: string
      objects: Record<string, string>
    }
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hourmere-coverage-test-'))
    for (const [file, sql] of Object.entries(migrations))
      await writeFile(join(directory, file), sql)
    expectationFile = join(directory, 'expected.json')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('enumerates the surviving objects the migration creates or redefines', async () => {
    const expectation = await writeExpectation()
    expect(expectation.migration).toBe('0002_child.sql')
    expect(Object.keys(expectation.objects)).toEqual(created)
    expect(expectation.objects).toMatchObject({
      'constraint public.parent.parent_code_check': 'CHECK ((code > 1))',
      'index public.child.child_parent':
        'CREATE INDEX child_parent ON public.child USING btree (parent_id)',
      'not_null public.parent.label': "NOT NULL DEFAULT 'parent'::text",
      'trigger public.child.child_guard': expect.stringMatching(
        /^CREATE TRIGGER child_guard BEFORE INSERT ON public\.child .* -- function md5 [0-9a-f]{32}$/,
      ),
    })
  }, 120_000)

  it('reports each uncovered object and accepts allow-listed ones', async () => {
    await writeExpectation()
    const report = await coverage({
      allowList: { 'index public.child.child_parent': 'Lookup index only' },
    })
    expect(Object.fromEntries(report.results.map((result) => [result.key, result.status]))).toEqual(
      {
        'constraint public.child.child_amount_check': 'covered',
        'constraint public.child.child_parent_id_fkey': 'covered',
        'constraint public.child.child_pkey': 'uncovered',
        'constraint public.parent.parent_code_check': 'covered',
        'index public.child.child_parent': 'allowed',
        'not_null public.child.amount': 'covered',
        'not_null public.child.parent_id': 'covered',
        'not_null public.parent.label': 'uncovered',
        'trigger public.child.child_guard': 'uncovered',
      },
    )
    expect(report.problems).toEqual([
      'no assertion fails after ALTER TABLE public.child DROP CONSTRAINT child_pkey (constraint public.child.child_pkey)',
      'no assertion fails after ALTER TABLE public.parent ALTER COLUMN label DROP NOT NULL (not_null public.parent.label)',
      'no assertion fails after DROP TRIGGER child_guard ON public.child (trigger public.child.child_guard)',
    ])
  }, 120_000)

  it('reports expectation drift, redefinitions, stale allow-list entries and missing files', async () => {
    const expectation = await writeExpectation()
    delete expectation.objects['trigger public.child.child_guard']
    expectation.objects['index public.child.child_note'] = 'CREATE INDEX child_note'
    expectation.objects['constraint public.child.child_amount_check'] = 'CHECK ((amount > 1))'
    await writeFile(expectationFile, JSON.stringify(expectation))
    const report = await coverage({
      assertions: fullSuite,
      allowList: {
        'index public.child.child_parent': 'Lookup index only',
        'index public.child.child_note': 'Dropped by a later migration',
        'constraint public.child.child_amount_check': 'Claimed redundant',
      },
    })
    expect(report.problems).toEqual([
      'allow-list entry is not created: index public.child.child_note',
      'allow-listed but an assertion fails without it, remove the entry: constraint public.child.child_amount_check',
      'definition changed: constraint public.child.child_amount_check',
      'expected but not created: index public.child.child_note',
      'not in the expectation file: trigger public.child.child_guard',
    ])
    expect(report.results.filter((result) => result.status === 'uncovered')).toEqual([])

    await rm(expectationFile)
    const missing = await coverage({
      assertions: fullSuite,
      allowList: { 'index public.child.child_parent': 'Lookup index only' },
    })
    expect(missing.problems).toEqual([`missing expectation file ${expectationFile}`])
  }, 120_000)

  it('requires the suite to pass unmodified and aborts on errors that are not assertions', async () => {
    await writeExpectation()
    await expect(
      coverage({
        assertions: async (pool) => {
          await rejects(pool, 'INSERT INTO parent (id) VALUES (1)', '23505')
        },
      }),
    ).rejects.toThrow('The assertion suite fails on the unmodified schema')
    let calls = 0
    for (const [name, suite] of [
      [
        'a bug in the suite',
        async (pool: pg.Pool) => {
          calls += 1
          if (calls > 1) throw new TypeError('suite bug')
          await fullSuite(pool)
        },
      ],
      [
        'a raw statement error',
        async (pool: pg.Pool) => {
          await pool.query('INSERT INTO parent (id) VALUES (1) ON CONFLICT DO NOTHING')
          // Without child_pkey this fails with 42P10 instead of an assertion.
          await pool.query(
            'INSERT INTO child (id,parent_id,amount) VALUES (30,1,1) ON CONFLICT (id) DO NOTHING',
          )
          await fullSuite(pool)
        },
      ],
      [
        'an assertion about an unrelated error',
        async (pool: pg.Pool) => {
          await fullSuite(pool)
          await rejects(pool, 'SELECT * FROM missing_relation', '23514')
        },
      ],
    ] as const)
      await expect(coverage({ concurrency: 1, assertions: suite }), name).rejects.toThrow(
        'Constraint coverage could not evaluate',
      )
  }, 240_000)
})
