import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { importedBookingCondition } from './imported-booking-condition.ts'
import { createDb, type Db } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

function condition(source: string): typeof importedBookingCondition {
  const executable = stripTypeScriptTypes(
    source.replace(/^import .* from 'kysely'\n/, '').replaceAll('export function', 'function'),
  )
  return new Function('sql', `${executable}\nreturn importedBookingCondition`)(sql)
}

describe.skipIf(!process.env.DATABASE_URL)('import-connected worker scan SQL', () => {
  let database: TestDatabase
  let db: Db
  let imported: string
  let root: string
  let successor: string
  let ordinary: string
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'import_scan',
    })
    db = createDb(database.pool)
    const organization = await db
      .insertInto('auth.organization')
      .values({
        name: 'Synthetic scan policy',
        slug: 'synthetic-scan-policy',
        createdAt: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const insert = async (source: 'api' | 'import', predecessor?: string) =>
      (
        await db
          .insertInto('bookings')
          .values({
            organization_id: organization.id,
            title: 'Synthetic scan',
            source,
            import_questions: source === 'import' ? '[]' : null,
            start_at: '2040-01-02T09:00Z',
            end_at: '2040-01-02T09:30Z',
            rescheduled_from_id: predecessor ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id
    root = await insert('api')
    imported = await insert('import', root)
    successor = await insert('api', imported)
    await insert('api', root)
    ordinary = await insert('api')
  })
  afterAll(async () => database?.drop())
  const assertPolicy = async (predicate = importedBookingCondition) => {
    const rows = await db
      .selectFrom('bookings')
      .select('id')
      .where((eb) => eb.not(predicate(eb.ref('id'))))
      .execute()
    expect(rows).toEqual([{ id: ordinary }])
  }
  it('filters the entire connected import policy before a worker limit', async () => {
    await assertPolicy()
    expect(
      await db
        .selectFrom('bookings')
        .select('id')
        .where((eb) => eb.not(importedBookingCondition(eb.ref('id'))))
        .limit(1)
        .execute(),
    ).toEqual([{ id: ordinary }])
  })
  it('terminates on a corrupt cycle without accepting connected records', async () => {
    await db
      .updateTable('bookings')
      .set({ rescheduled_from_id: successor })
      .where('id', '=', root)
      .execute()
    try {
      await assertPolicy()
    } finally {
      await db
        .updateTable('bookings')
        .set({ rescheduled_from_id: null })
        .where('id', '=', root)
        .execute()
    }
  })
  it.each([
    ['source', (source: string) => source.replace("source = 'import'", "source = 'never'")],
    [
      'ancestor',
      (source: string) => source.replace('WHERE id = current.rescheduled_from_id', 'WHERE false'),
    ],
    [
      'descendant',
      (source: string) => source.replace('WHERE rescheduled_from_id = current.id', 'WHERE false'),
    ],
  ] as const)('detects source-copy mutation of the SQL %s protection', async (_name, mutate) => {
    const source = await readFile(
      new URL('./imported-booking-condition.ts', import.meta.url),
      'utf8',
    )
    await assertPolicy(condition(source))
    const mutant = mutate(source)
    expect(mutant).not.toBe(source)
    await expect(assertPolicy(condition(mutant))).rejects.toMatchObject({ name: 'AssertionError' })
    await assertPolicy(condition(source))
  })
})
