import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { requiresUpgradeNote, undocumentedMigrations } from './migration-policy.ts'

const migrations =
  process.env.HOURMERE_MIGRATIONS_DIR ??
  fileURLToPath(new URL('../packages/db/migrations/', import.meta.url))

const directories: string[] = []

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function fixture(sql: string, note?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-migration-policy-'))
  directories.push(directory)
  writeFileSync(join(directory, '9999_example.sql'), sql)
  if (note !== undefined) writeFileSync(join(directory, '9999_example.md'), note)
  return directory
}

it('requires an upgrade note beside every migration with a schema compatibility break', () => {
  expect(
    undocumentedMigrations(migrations),
    'Add a matching .md sidecar with a nonempty Schema-break upgrade: note',
  ).toEqual([])
})

const breaking = [
  'ALTER TABLE t DROP COLUMN x;',
  'alter table t drop x;',
  'ALTER TABLE IF EXISTS ONLY public.t * DROP IF EXISTS x CASCADE;',
  'ALTER TABLE "public"."a table" DROP "a column";',
  'ALTER TABLE t ADD COLUMN y numeric(10, 2), DROP x;',
  'ALTER TABLE t DROP CONSTRAINT old_check, DROP COLUMN x;',
  "ALTER TABLE t ADD x text DEFAULT concat('a', 'b'), DROP y;",
  'ALTER /* reason */ TABLE t DROP /* retired */ COLUMN x;',
  'ALTER TABLE t DROP/* nested /* reason */ comment */x;',
  'DROP TABLE t;',
  'drop table if exists public.t, "other table" cascade;',
  'DROP/* reason */TABLE t;',
  'DROP-- reason\nTABLE t;',
  'ALTER TABLE t RENAME COLUMN x TO y;',
  'alter table t rename x to y;',
  'ALTER TABLE IF EXISTS ONLY public.t * RENAME "old x" TO "new x";',
  'ALTER TABLE t RENAME/* reason */COLUMN x TO y;',
  'ALTER TABLE t RENAME TO new_t;',
  'alter table public.t rename to new_t;',
  'ALTER TABLE IF EXISTS ONLY "public"."old table" * RENAME TO "new table";',
  'ALTER TABLE t RENAME/* reason */TO new_t;',
  'ALTER TABLE t SET SCHEMA archive;',
  'alter table if exists only public.t * set schema archive;',
  'ALTER TABLE "public"."a table" SET/* reason */SCHEMA "new schema";',
  'ALTER VIEW v RENAME TO new_v;',
  'alter view if exists public.v rename to new_v;',
  'ALTER VIEW "public"."old view" RENAME TO "new view";',
  'ALTER VIEW v RENAME COLUMN x TO y;',
  'ALTER VIEW IF EXISTS public.v RENAME x TO y;',
  'ALTER/* reason */VIEW "a view" RENAME/* reason */COLUMN "old x" TO "new x";',
  'ALTER TABLE t ALTER COLUMN x TYPE bigint;',
  'alter table t alter x type text using x::text;',
  'ALTER TABLE IF EXISTS ONLY public.t * ALTER COLUMN x TYPE numeric(10, 2);',
  'ALTER TABLE "public"."a table" ALTER "a column" TYPE "a type";',
  'ALTER TABLE t ALTER COLUMN x SET DATA TYPE bigint;',
  'ALTER TABLE t ALTER x SET DATA TYPE text USING x::text;',
  'ALTER TABLE t ALTER/* reason */COLUMN x SET/* reason */DATA TYPE text;',
  'ALTER TABLE t ALTER COLUMN "TYPE" TYPE text;',
  'ALTER TABLE t ADD COLUMN y numeric(10, 2), ALTER COLUMN x TYPE numeric(12, 3);',
  'ALTER TABLE t ALTER COLUMN x DROP DEFAULT, ALTER y SET DATA TYPE text;',
  "SELECT 'not a change'; ALTER TABLE t DROP x;",
  "SELECT '-- not a comment'; DROP TABLE t;",
  "SELECT '/* not a comment */'; ALTER TABLE t RENAME x TO y;",
  "SELECT 'a doubled '' quote'; ALTER TABLE t DROP x;",
  "SELECT E'an escaped \\' quote'; DROP TABLE t;",
  'SELECT $tag$other $$ delimiter$tag$; ALTER TABLE t DROP x;',
]

describe('schema compatibility changes', () => {
  it.each(breaking)('requires a sidecar for %s', (sql) => {
    expect(requiresUpgradeNote(sql)).toBe(true)
    expect(undocumentedMigrations(fixture(sql))).toEqual(['9999_example.sql'])
    expect(
      undocumentedMigrations(
        fixture(sql, 'Schema-break upgrade: Stop every old app and worker.\n'),
      ),
    ).toEqual([])
  })

  it.each([
    '',
    'Upgrade: Stop old processes.\n',
    'Schema-break upgrade:\n',
    'Schema-break upgrade: \t\r\n',
    'Schema-break upgrade:\nDetails on the next line are insufficient.\n',
  ])('rejects empty or unrecognized notes (%j)', (note) => {
    expect(undocumentedMigrations(fixture('ALTER TABLE t DROP x;', note))).toEqual([
      '9999_example.sql',
    ])
  })

  it('keeps published column-drop sidecars valid', () => {
    expect(
      undocumentedMigrations(
        fixture(
          'ALTER TABLE t DROP COLUMN x;',
          '# Upgrade\n\nColumn-drop upgrade: Stop all old roles.\n',
        ),
      ),
    ).toEqual([])
  })

  it('requires the sidecar to match the SQL basename', () => {
    const directory = fixture('DROP TABLE t;')
    writeFileSync(join(directory, '9998_other.md'), 'Schema-break upgrade: Stop old roles.\n')
    expect(undocumentedMigrations(directory)).toEqual(['9999_example.sql'])
  })
})

describe('nonbreaking SQL and quoted examples', () => {
  it.each([
    '-- ALTER TABLE t DROP COLUMN x;\nSELECT 1;',
    '/* DROP TABLE t; ALTER TABLE t RENAME COLUMN x TO y; */ SELECT 1;',
    '/* outer /* inner */ ALTER TABLE t DROP x; */ SELECT 1;',
    "SELECT 'ALTER TABLE t DROP COLUMN x; DROP TABLE t; ALTER TABLE t RENAME x TO y;';",
    "SELECT 'a doubled '' quote; DROP TABLE t;';",
    "SELECT E'an escaped \\' quote; ALTER TABLE t DROP x;';",
    "SELECT U&'DROP TABLE t;';",
    'SELECT $$DROP TABLE t; ALTER TABLE t DROP x;$$;',
    'SELECT $example$ALTER TABLE t RENAME COLUMN x TO y;$example$;',
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN RAISE NOTICE 'DROP TABLE t;'; END $body$;",
    'SELECT "DROP TABLE", "ALTER TABLE t DROP x", "RENAME COLUMN" FROM t;',
    'SELECT "example; DROP TABLE t;" FROM t;',
    'CREATE TABLE "DROP TABLE t;" ("DROP COLUMN" text);',
    'ALTER TABLE t ADD COLUMN "DROP COLUMN" text;',
    'ALTER TABLE t ALTER COLUMN x DROP DEFAULT;',
    'ALTER TABLE t ALTER x DROP NOT NULL;',
    'ALTER TABLE t ALTER COLUMN x DROP EXPRESSION IF EXISTS;',
    'ALTER TABLE t ALTER x DROP IDENTITY IF EXISTS;',
    'ALTER TABLE t DROP CONSTRAINT IF EXISTS old_check;',
    'ALTER TABLE t RENAME CONSTRAINT old_check TO new_check;',
    'ALTER TABLE t SET TABLESPACE archive;',
    'ALTER TABLE t SET LOGGED;',
    'ALTER TABLE t ALTER COLUMN x SET STORAGE EXTERNAL;',
    'ALTER TABLE t ALTER x SET COMPRESSION pglz;',
    'ALTER TABLE t ALTER COLUMN x SET STATISTICS 100;',
    "ALTER TABLE t ALTER COLUMN type SET DEFAULT 'text';",
    "ALTER TABLE t ALTER COLUMN data SET DEFAULT 'TYPE';",
    'ALTER TABLE "SET SCHEMA archive" ADD COLUMN "ALTER COLUMN x TYPE text" text;',
    'ALTER VIEW v ALTER COLUMN x SET DEFAULT 1;',
    'ALTER VIEW v ALTER x DROP DEFAULT;',
    'ALTER VIEW IF EXISTS public.v OWNER TO operator;',
    'ALTER VIEW "RENAME TO old_v" SET (security_barrier = true);',
    '-- ALTER TABLE t SET SCHEMA archive;\nSELECT 1;',
    '/* ALTER VIEW v RENAME COLUMN x TO y; */ SELECT 1;',
    '/* ALTER TABLE t ALTER COLUMN x TYPE text; */ SELECT 1;',
    "SELECT 'ALTER TABLE t SET SCHEMA archive; ALTER VIEW v RENAME TO new_v;';",
    'SELECT $$ALTER TABLE t ALTER x SET DATA TYPE text;$$;',
    'SELECT "ALTER VIEW v RENAME COLUMN x TO y;", "ALTER COLUMN x TYPE text" FROM t;',
    'DO $$ BEGIN ALTER TABLE t SET SCHEMA archive; END $$;',
    'DO $$ BEGIN ALTER VIEW v RENAME TO new_v; END $$;',
    'DO $$ BEGIN ALTER TABLE t ALTER x TYPE text; END $$;',
    'DO $$ BEGIN ALTER TABLE t RENAME TO new_t; END $$;',
    "DO $body$ BEGIN EXECUTE 'ALTER TABLE t RENAME TO new_t'; END $body$;",
    'ALTER TYPE t DROP ATTRIBUTE x;',
    'DROP INDEX old_index;',
    'CREATE TABLE t (x text) ON COMMIT DROP;',
    "ALTER TABLE t ADD x text DEFAULT 'DROP COLUMN y';",
    "ALTER TABLE t ADD x text DEFAULT concat('a,b', 'DROP TABLE');",
    "SELECT 'DROP' AS x, 'TABLE' AS y;",
    'SELECT "DROP" AS x, "TABLE" AS y;',
    'SELECT drop_table, rename_column FROM t;',
  ])('does not require a sidecar for %s', (sql) => {
    expect(requiresUpgradeNote(sql)).toBe(false)
    expect(undocumentedMigrations(fixture(sql))).toEqual([])
  })
})
