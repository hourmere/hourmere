import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkConstraintCoverage, openRelatedPool } from './constraint-coverage.ts'

const serverUrl = process.env.DATABASE_URL

/** A driver error with the given SQLSTATE, as pg raises it (its name is 'error'). */
const databaseError = (code: string, message: string) =>
  Object.assign(new pg.DatabaseError(message, 0, 'error'), { code })

// One case per SQLSTATE class that must abort the run: connection, transaction state,
// deadlock/serialization, syntax/privilege, resources, locks, timeouts/shutdown, system, internal.
const abortingErrors: [code: string, message: string][] = [
  ['08006', 'Connection terminated unexpectedly'],
  ['25P02', 'current transaction is aborted, commands ignored until end of transaction block'],
  ['40P01', 'deadlock detected'],
  ['42P01', 'relation "missing_relation" does not exist'],
  ['53300', 'sorry, too many clients already'],
  ['55P03', 'could not obtain lock on relation'],
  ['57014', 'canceling statement due to statement timeout'],
  ['58030', 'could not write to file: No space left on device'],
  ['XX000', 'internal error'],
]

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

/** A real SQLSTATE 57014 from the server, on a client of the given pool. */
async function realTimeout(pool: pg.Pool): Promise<never> {
  const client = await pool.connect()
  try {
    await client.query("SET statement_timeout='10ms'")
    await client.query('SELECT pg_sleep(1)')
    throw new Error('expected a statement timeout')
  } finally {
    await client.query('RESET statement_timeout').catch(() => {})
    client.release()
  }
}

const caught = (pool: pg.Pool) => realTimeout(pool).catch((error: unknown) => error)

/** A real code-less driver error: the socket is cut while the statement is in flight. */
async function socketCut(pool: pg.Pool): Promise<never> {
  const client = await pool.connect()
  try {
    const pending = client.query('SELECT pg_sleep(1)')
    ;(
      client as unknown as { connection: { stream: { destroy(): void } } }
    ).connection.stream.destroy()
    await pending
    throw new Error('expected a lost connection')
  } finally {
    client.release(true)
  }
}

/** An expected success, written the way suites write it (CONTRIBUTING.md). */
async function accept(pool: pg.Pool, sql: string) {
  await expect(pool.query(sql)).resolves.toBeDefined()
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
          if (calls > 2) throw new TypeError('suite bug')
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

  it('aborts when expect(...).resolves hides an error that is not an integrity rejection', async () => {
    await writeExpectation()
    // A real 42P10 on the copy without child_pkey: the "expected success" is the suite's bug.
    await expect(
      coverage({
        concurrency: 1,
        assertions: async (pool) => {
          await pool.query('INSERT INTO parent (id) VALUES (1) ON CONFLICT DO NOTHING')
          await expect(
            pool.query(
              'INSERT INTO child (id,parent_id,amount) VALUES (30,1,1) ON CONFLICT (id) DO NOTHING',
            ),
          ).resolves.toBeDefined()
          await fullSuite(pool)
        },
      }),
    ).rejects.toThrow(
      /could not evaluate constraint public\.child\.child_pkey: .*code 42P10: there is no unique or exclusion constraint/,
    )

    // A real 57014 on one copy, as a loaded server produces; the first copy drops amount_check.
    let timeouts = 0
    await expect(
      coverage({
        concurrency: 1,
        assertions: async (pool) => {
          timeouts += 1
          if (timeouts > 2)
            await expect(
              pool.query("SET statement_timeout='10ms'; SELECT pg_sleep(1)"),
            ).resolves.toBeDefined()
          await fullSuite(pool)
        },
      }),
    ).rejects.toThrow(
      /could not evaluate constraint public\.child\.child_amount_check: .*code 57014: canceling statement/,
    )

    // Errors without a SQLSTATE: a dropped connection, or a driver/socket error.
    for (const [name, error] of [
      ['a code-less error', new Error('Connection terminated unexpectedly')],
      ['a socket error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ] as const) {
      let calls = 0
      await expect(
        coverage({
          concurrency: 1,
          assertions: async (pool) => {
            calls += 1
            if (calls > 2) await expect(Promise.reject(error)).resolves.toBeDefined()
            await fullSuite(pool)
          },
        }),
        name,
      ).rejects.toThrow(
        error.name === 'Error' && !('code' in error)
          ? /child_amount_check: .*an error without SQLSTATE in the cause chain: Connection terminated unexpectedly/
          : /child_amount_check: .*code ECONNRESET in the cause chain: read ECONNRESET/,
      )
    }
  }, 240_000)

  it.each(abortingErrors)(
    'aborts on SQLSTATE %s in a cause chain or an assertion',
    async (code, message) => {
      await writeExpectation()
      let calls = 0
      await expect(
        coverage({
          concurrency: 1,
          assertions: async (pool) => {
            calls += 1
            if (calls > 2)
              await expect(Promise.reject(databaseError(code, message))).resolves.toBeDefined()
            await fullSuite(pool)
          },
        }),
        'cause chain',
      ).rejects.toThrow(
        new RegExp(
          `child_amount_check: .*code ${code} in the cause chain: ${message.slice(0, 20)}`,
        ),
      )
      let attempts = 0
      await expect(
        coverage({
          concurrency: 1,
          assertions: async (pool) => {
            attempts += 1
            if (attempts > 2)
              await expect(Promise.reject(databaseError(code, message))).rejects.toMatchObject({
                code: '23514',
              })
            await fullSuite(pool)
          },
        }),
        'assertion actual',
      ).rejects.toThrow(
        // toMatchObject keeps only the compared subset of the error, so no message follows.
        new RegExp(`child_amount_check: .*an assertion about an error with code ${code}: `),
      )
    },
    120_000,
  )

  it('counts integrity rejections inside expect(...).resolves and value mismatches as coverage', async () => {
    await writeExpectation()
    const cases: [name: string, suite: (pool: pg.Pool) => Promise<void>][] = [
      ['23505 inside resolves', (pool) => accept(pool, 'INSERT INTO parent (id) VALUES (1)')],
      ['22012 inside resolves', (pool) => accept(pool, 'SELECT 1/0')],
      [
        'P0001 inside resolves',
        (pool) => accept(pool, "DO $$ BEGIN RAISE EXCEPTION 'guarded by a function'; END $$"),
      ],
      [
        'a different integrity code than asserted',
        (pool) => rejects(pool, 'INSERT INTO child (id,parent_id,amount) VALUES (13,2,1)', '23514'),
      ],
      [
        'a value mismatch',
        async (pool) => {
          expect((await pool.query('SELECT count(*)::int AS n FROM parent')).rows).toEqual([
            { n: 0 },
          ])
        },
      ],
    ]
    for (const [name, failing] of cases) {
      let calls = 0
      const report = await coverage({
        concurrency: 1,
        assertions: async (pool) => {
          calls += 1
          await pool.query('INSERT INTO parent (id) VALUES (1) ON CONFLICT DO NOTHING')
          if (calls > 2) await failing(pool)
          await partialSuite(pool)
        },
      })
      expect(report.problems, name).toEqual([])
      expect(
        report.results.map((result) => result.status),
        name,
      ).toEqual(created.map(() => 'covered'))
    }
  }, 240_000)

  it('pins the trigger function definition: SET clauses, SECURITY DEFINER and the body', async () => {
    const expectation = await writeExpectation()
    const pinned = expectation.objects['trigger public.child.child_guard'] as string
    expect(pinned).toMatch(/ -- function md5 [0-9a-f]{32}$/)
    const file = join(directory, '0002_child.sql')
    const original = migrations['0002_child.sql']
    try {
      for (const [name, before, after, visible] of [
        [
          'search_path pin',
          'LANGUAGE plpgsql AS $$',
          'LANGUAGE plpgsql SET search_path=public,pg_temp AS $$',
          ' -- function SET search_path=public, pg_temp md5 ',
        ],
        [
          'SECURITY DEFINER',
          'LANGUAGE plpgsql AS $$',
          'LANGUAGE plpgsql SECURITY DEFINER AS $$',
          ' -- function SECURITY DEFINER md5 ',
        ],
        [
          'volatility',
          'LANGUAGE plpgsql AS $$',
          'LANGUAGE plpgsql STABLE AS $$',
          ' -- function md5 ',
        ],
        [
          'body',
          "RAISE EXCEPTION 'forbidden note'",
          "RAISE EXCEPTION 'banned note'",
          ' -- function md5 ',
        ],
      ] as const) {
        // A replacer function keeps the `$$` quotes literal.
        const mutated = original.replace(before, () => after)
        expect(mutated, name).not.toBe(original)
        await writeFile(file, mutated)
        const report = await coverage({
          assertions: fullSuite,
          allowList: { 'index public.child.child_parent': 'Lookup index only' },
        })
        expect(report.problems, name).toEqual([
          'definition changed: trigger public.child.child_guard',
        ])
        const definition = report.objects.find(
          (object) => object.key === 'trigger public.child.child_guard',
        )?.definition
        expect(definition, name).toContain(visible)
        expect(definition, name).not.toBe(pinned)
      }
    } finally {
      await writeFile(file, original)
    }
  }, 240_000)

  // Styles that put the database error anywhere but on `actual.code` or in the cause chain.
  // Only the ledger of recorded query errors can see these, so each must still abort.
  it.each<[name: string, failing: (pool: pg.Pool) => Promise<void>, reason: RegExp]>([
    [
      'expect(error.code).toBe(...) on a real 57014',
      async (pool) => {
        const error = (await caught(pool)) as { code?: string }
        expect(error.code).toBe('23514')
      },
      /code 57014: canceling statement/,
    ],
    [
      '.rejects.toHaveProperty(code) on a real 57014',
      async (pool) => {
        await expect(realTimeout(pool)).rejects.toHaveProperty('code', '23514')
      },
      /code 57014: canceling statement/,
    ],
    [
      '.rejects.toThrow(/regex/) on a real 57014',
      async (pool) => {
        await expect(realTimeout(pool)).rejects.toThrow(/violates check constraint/)
      },
      /code 57014: canceling statement/,
    ],
    [
      'codes mapped to strings (the "required columns" shape) on a real 57014',
      async (pool) => {
        const errors = [(await caught(pool)) as { code?: string; column?: string } | undefined]
        expect(
          errors.flatMap((error) =>
            error?.code === '23502' && error?.column === 'amount'
              ? []
              : [`child.amount: ${error?.code ?? 'accepted'}`],
          ),
        ).toEqual([])
      },
      /code 57014: canceling statement/,
    ],
    [
      'an allSettled reason inside toEqual on a real 57014',
      async (pool) => {
        const [result] = await Promise.allSettled([realTimeout(pool)])
        expect(result).toEqual({
          status: 'rejected',
          reason: expect.objectContaining({ code: '23514' }),
        })
      },
      /code 57014: canceling statement/,
    ],
    [
      '.rejects.toMatchObject({ code }) receiving a wrapper whose cause is a real 57014',
      async (pool) => {
        await expect(
          realTimeout(pool).catch((error: unknown) => {
            throw new Error('insert failed', { cause: error })
          }),
        ).rejects.toMatchObject({ code: '23514' })
      },
      /code 57014: canceling statement/,
    ],
    [
      '.rejects.toMatchObject({ code }) receiving a real lost connection',
      async (pool) => {
        await expect(socketCut(pool)).rejects.toMatchObject({ code: '23514' })
      },
      /an error without SQLSTATE: Connection terminated/,
    ],
    [
      'a real 57014 swallowed entirely, then a value mismatch',
      async (pool) => {
        await caught(pool)
        expect(1).toBe(2)
      },
      /code 57014: canceling statement.*; the suite then failed with expected 1 to be 2/,
    ],
    [
      '.resolves on an AggregateError faking code 23505 around a real 57014',
      async (pool) => {
        const inner = await caught(pool)
        await expect(
          Promise.reject(Object.assign(new AggregateError([inner], 'x'), { code: '23505' })),
        ).resolves.toBeDefined()
      },
      /code 57014: canceling statement/,
    ],
    [
      'a 42P01 on a pool opened with openRelatedPool, swallowed',
      async (pool) => {
        const related = openRelatedPool(pool, pool.options.connectionString as string)
        try {
          await related.query('SELECT * FROM missing_relation').catch(() => {})
        } finally {
          await related.end()
        }
        expect(1).toBe(2)
      },
      /code 42P01: relation "missing_relation" does not exist/,
    ],
  ])(
    'aborts on %s, whatever the assertion style',
    async (_name, failing, reason) => {
      await writeExpectation()
      let calls = 0
      await expect(
        coverage({
          concurrency: 1,
          assertions: async (pool) => {
            calls += 1
            if (calls > 2) await failing(pool)
            await fullSuite(pool)
          },
        }),
      ).rejects.toThrow(
        new RegExp(
          `could not evaluate constraint public\\.child\\.child_amount_check: the database reported 1 error\\(s\\) that are not integrity rejections: ${reason.source}`,
        ),
      )
    },
    120_000,
  )

  it('aborts on a real 57014 inside the first check, between savepoints', async () => {
    await writeExpectation()
    let calls = 0
    // The reference suite's first check probes NOT NULL columns in savepoints of one
    // transaction and compares the codes as strings; a cancel in one probe must not count.
    const requiredColumns = async (pool: pg.Pool, cancelFirst: boolean) => {
      const client = await pool.connect()
      const codes: string[] = []
      try {
        await client.query('BEGIN')
        for (const [i, column] of ['amount', 'parent_id'].entries()) {
          await client.query('SAVEPOINT attempt')
          try {
            if (cancelFirst && i === 0) {
              await client.query("SET LOCAL statement_timeout='10ms'")
              await client.query('SELECT pg_sleep(1)')
            }
            await client.query(
              `INSERT INTO child (id,parent_id,amount) VALUES (40,${column === 'parent_id' ? 'NULL' : '1'},${column === 'amount' ? 'NULL' : '1'})`,
            )
            codes.push(`${column}: accepted`)
          } catch (error) {
            codes.push(`${column}: ${(error as { code?: string }).code}`)
          }
          await client.query('ROLLBACK TO SAVEPOINT attempt')
        }
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
      expect(codes).toEqual(['amount: 23502', 'parent_id: 23502'])
    }
    await expect(
      coverage({
        concurrency: 1,
        assertions: async (pool) => {
          calls += 1
          await pool.query('INSERT INTO parent (id) VALUES (1) ON CONFLICT DO NOTHING')
          await requiredColumns(pool, calls > 2)
          await fullSuite(pool)
        },
      }),
    ).rejects.toThrow(
      /could not evaluate constraint public\.child\.child_amount_check: the database reported 1 error\(s\) that are not integrity rejections: code 57014: canceling statement.*SELECT pg_sleep/,
    )
  }, 120_000)

  it('aborts when a non-integrity error is recorded even though the suite passes', async () => {
    await writeExpectation()
    let calls = 0
    await expect(
      coverage({
        concurrency: 1,
        assertions: async (pool) => {
          calls += 1
          if (calls === 1) await caught(pool)
          await fullSuite(pool)
        },
      }),
    ).rejects.toThrow(
      /could not evaluate the (second )?baseline: the database reported 1 error\(s\).*code 57014.*; the suite passed anyway/,
    )
  }, 120_000)

  // Shapes with no database error behind them: the walk over the thrown failure must abort.
  it.each<[name: string, failing: (pool: pg.Pool) => Promise<void>, reason: RegExp]>([
    [
      'a raw database error with an integrity code thrown outside expect',
      async () => {
        throw databaseError('23505', 'duplicate key value violates unique constraint')
      },
      /got error 23505: duplicate key value violates unique constraint \(the database reported no error\)/,
    ],
    [
      'a real integrity rejection outside expect',
      async (pool) => {
        await pool.query('INSERT INTO parent (id) VALUES (1)')
      },
      /got error 23505: duplicate key value violates unique constraint "parent_pkey"/,
    ],
    [
      '.resolves on an Error with code 23505 whose cause is a 57014',
      async () => {
        await expect(
          Promise.reject(
            Object.assign(
              new Error('outer', { cause: databaseError('57014', 'canceling statement') }),
              { code: '23505' },
            ),
          ),
        ).resolves.toBeDefined()
      },
      /got an error with code 57014 in the cause chain: canceling statement/,
    ],
    [
      '.resolves on a nested AssertionError whose actual is { code: 57014 }',
      async () => {
        let nested: unknown
        try {
          expect({ code: '57014' }).toMatchObject({ code: '23514' })
        } catch (error) {
          nested = error
        }
        await expect(Promise.reject(nested)).resolves.toBeDefined()
      },
      /got an assertion about an error with code 57014/,
    ],
    [
      '.rejects.toMatchObject({ code }) receiving an error without a code',
      async () => {
        await expect(
          Promise.reject(new Error('Connection terminated unexpectedly')),
        ).rejects.toMatchObject({ code: '23514' })
      },
      /got an assertion (about an error without SQLSTATE: Connection terminated unexpectedly|that expected code 23514 but received none)/,
    ],
    [
      'toEqual receiving an Error without a code',
      async () => {
        expect(new Error('read ECONNRESET')).toEqual({ code: '23514' })
      },
      /got an assertion about an error without SQLSTATE: read ECONNRESET/,
    ],
    [
      'an assertion that received an Error without a code and expected no code',
      async () => {
        expect(new Error('read ECONNRESET')).toBeUndefined()
      },
      /got an assertion about an error without SQLSTATE: read ECONNRESET/,
    ],
    [
      '.rejects.toMatchObject({ code }) receiving a plain object without a code',
      async () => {
        await expect(
          Promise.reject({ message: 'Connection terminated unexpectedly' }),
        ).rejects.toMatchObject({ code: '23514' })
      },
      /got an assertion that expected code 23514 but received none/,
    ],
    [
      '.resolves on an AggregateError with code 23505 whose errors hold a 57014',
      async () => {
        await expect(
          Promise.reject(
            Object.assign(new AggregateError([databaseError('57014', 'canceling')], 'x'), {
              code: '23505',
            }),
          ),
        ).resolves.toBeDefined()
      },
      /got an error with code 57014 in the cause chain: canceling/,
    ],
    [
      '.resolves on an AggregateError whose errors hold a 57014',
      async () => {
        await expect(
          Promise.reject(new AggregateError([databaseError('57014', 'canceling statement')], 'x')),
        ).resolves.toBeDefined()
      },
      /got an error without SQLSTATE in the cause chain: x/,
    ],
    [
      'an assertion whose received error has an integrity code but a 57014 cause',
      async () => {
        const error = Object.assign(
          new Error('wrapped', { cause: databaseError('57014', 'canceling') }),
          { code: '23505' },
        )
        expect(error).toEqual(expect.objectContaining({ code: '23514' }))
      },
      /got an error with code 57014 in the cause chain: canceling/,
    ],
  ])(
    'aborts on %s',
    async (_name, failing, reason) => {
      await writeExpectation()
      let calls = 0
      await expect(
        coverage({
          concurrency: 1,
          assertions: async (pool) => {
            calls += 1
            await pool.query('INSERT INTO parent (id) VALUES (1) ON CONFLICT DO NOTHING')
            if (calls > 2) await failing(pool)
            await fullSuite(pool)
          },
        }),
      ).rejects.toThrow(
        new RegExp(
          `could not evaluate constraint public\\.child\\.child_amount_check: .*${reason.source}`,
        ),
      )
    },
    120_000,
  )

  // The two baselines clone in parallel, so either label can receive either call: one of
  // these two cases always lands on "the second baseline", and both must abort.
  it.each([1, 2])(
    'aborts when the unmodified suite fails on baseline call %i only, before any drop',
    async (failing) => {
      await writeExpectation()
      let calls = 0
      await expect(
        coverage({
          concurrency: 1,
          assertions: async (pool) => {
            calls += 1
            if (calls === failing) expect('this run').toBe('stable')
            await fullSuite(pool)
          },
        }),
      ).rejects.toThrow(/The assertion suite fails on the unmodified schema/)
      expect(calls).toBe(2)
    },
    120_000,
  )

  it('records a refused connection on a related pool, however the suite asserts it', async () => {
    await writeExpectation()
    let calls = 0
    await expect(
      coverage({
        concurrency: 1,
        assertions: async (pool) => {
          calls += 1
          if (calls > 2) {
            const url = new URL(pool.options.connectionString as string)
            url.pathname = '/hourmere_test_coverage_missing_database'
            const related = openRelatedPool(pool, url.toString())
            try {
              const code = await related.connect().then(
                (client) => {
                  client.release()
                  return undefined
                },
                (error: unknown) => (error as { code?: string }).code,
              )
              expect(code).toBe('23514')
            } finally {
              await related.end()
            }
          }
          await fullSuite(pool)
        },
      }),
    ).rejects.toThrow(
      /could not evaluate constraint public\.child\.child_amount_check: the database reported 1 error\(s\) that are not integrity rejections: code 3D000: database "hourmere_test_coverage_missing_database" does not exist/,
    )
  }, 120_000)

  it('keeps one ledger per copy when copies run concurrently', async () => {
    await writeExpectation()
    let calls = 0
    let started = 0
    await expect(
      coverage({
        concurrency: 4,
        assertions: async (pool) => {
          calls += 1
          if (calls <= 2) {
            await fullSuite(pool)
            return
          }
          started += 1
          const injected =
            (
              await pool.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM pg_constraint WHERE conname='child_amount_check'",
              )
            ).rows[0]?.n === 0
          if (injected) {
            const code = await realTimeout(pool).catch(
              (error: unknown) => (error as { code?: string }).code,
            )
            // Fail only after other copies have started (and finished) their own runs, so a
            // ledger shared between copies would have lost this entry by now.
            const deadline = Date.now() + 15_000
            while (started < 6 && Date.now() < deadline)
              await new Promise((resolve) => setTimeout(resolve, 50))
            expect(code).toBe('23514')
          }
          await fullSuite(pool)
        },
      }),
    ).rejects.toThrow(
      /could not evaluate constraint public\.child\.child_amount_check: the database reported 1 error\(s\) that are not integrity rejections: code 57014: canceling statement/,
    )
    expect(started).toBeGreaterThanOrEqual(6)
  }, 120_000)

  it('refuses the callback form of query and connect, which would bypass the ledger', async () => {
    await writeExpectation()
    type Callback = (error: unknown, value?: unknown) => void
    const missing = 'SELECT * FROM missing_relation'
    const uses: [name: string, use: (pool: pg.Pool) => Promise<unknown>][] = [
      [
        'pool.query(sql, callback)',
        (pool) =>
          new Promise((resolve) => {
            ;(pool.query as unknown as (text: string, callback: Callback) => void)(
              missing,
              (error) => resolve((error as { code?: string } | null)?.code),
            )
          }),
      ],
      [
        'client.query(sql, callback)',
        async (pool) => {
          const client = await pool.connect()
          try {
            return await new Promise((resolve) => {
              ;(client.query as unknown as (text: string, callback: Callback) => void)(
                missing,
                (error) => resolve((error as { code?: string } | null)?.code),
              )
            })
          } finally {
            client.release()
          }
        },
      ],
      [
        'pool.connect(callback)',
        (pool) =>
          new Promise((resolve) => {
            ;(pool.connect as unknown as (callback: Callback) => void)((error) => resolve(error))
          }),
      ],
    ]
    for (const [name, use] of uses) {
      let calls = 0
      await expect(
        coverage({
          concurrency: 1,
          assertions: async (pool) => {
            calls += 1
            if (calls > 2) expect(await use(pool)).toBe('23514')
            await fullSuite(pool)
          },
        }),
        name,
      ).rejects.toThrow(
        /could not evaluate constraint public\.child\.child_amount_check: .*got TypeError: .*promise form of (query|connect)/,
      )
    }
  }, 240_000)
})
