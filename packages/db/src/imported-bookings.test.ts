import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { importedBookingIds, isImportedBooking } from './imported-bookings.ts'
import { createDb, type Db } from './index.ts'
import { createTestDatabase, type TestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
type Helpers = {
  importedBookingIds: typeof importedBookingIds
  isImportedBooking: typeof isImportedBooking
}

function helpers(source: string): Helpers {
  const executable = stripTypeScriptTypes(
    source
      .replace("import { sql } from 'kysely'", '')
      .replaceAll('export async function', 'async function'),
  )
  return new Function('sql', `${executable}\nreturn {importedBookingIds,isImportedBooking}`)(sql)
}

describe.skipIf(!serverUrl)('import booking policy chain', () => {
  let owned: TestDatabase
  let db: Db
  let root: string
  let imported: string
  let successor: string
  let sibling: string
  let ordinary: string

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    const organization = (
      await owned.pool.query<{ id: string }>(`
      INSERT INTO auth.organization (name,slug,"createdAt")
      VALUES ('Synthetic policy chain','import-policy-chain',now()) RETURNING id`)
    ).rows[0]?.id as string
    const insert = async (source: string, predecessor?: string) =>
      (
        await owned.pool.query<{ id: string }>(
          `INSERT INTO bookings
        (organization_id,start_at,end_at,title,source,rescheduled_from_id,import_questions)
        VALUES ($1,'2040-01-02T09:00Z','2040-01-02T09:30Z','Synthetic chain',$2,$3,$4) RETURNING id`,
          [organization, source, predecessor ?? null, source === 'import' ? '[]' : null],
        )
      ).rows[0]?.id as string
    root = await insert('web')
    imported = await insert('import', root)
    successor = await insert('web', imported)
    sibling = await insert('web', root)
    ordinary = await insert('api')
  })

  afterAll(async () => {
    await owned?.drop()
  })

  const assertPolicy = async (functions: Helpers) => {
    const missing = randomUUID()
    expect(
      await functions.importedBookingIds(db, [
        root,
        imported,
        successor,
        sibling,
        ordinary,
        missing,
      ]),
    ).toEqual(new Set([root, imported, successor, sibling]))
    for (const id of [root, imported, successor, sibling])
      expect(await functions.isImportedBooking(db, id)).toBe(true)
    expect(await functions.isImportedBooking(db, ordinary)).toBe(false)
    expect(await functions.isImportedBooking(db, missing)).toBe(false)
    expect(await functions.importedBookingIds(db, [])).toEqual(new Set())
  }

  it('keeps ancestors, successors and siblings local while ignoring unrelated and missing IDs', async () => {
    await assertPolicy({ importedBookingIds, isImportedBooking })
    expect(owned.pool.totalCount).toBeLessThanOrEqual(1)
  })

  it('terminates on a corrupt reschedule cycle without losing imported policy', async () => {
    await owned.pool.query('UPDATE bookings SET rescheduled_from_id=$1 WHERE id=$2', [
      successor,
      root,
    ])
    try {
      await assertPolicy({ importedBookingIds, isImportedBooking })
    } finally {
      await owned.pool.query('UPDATE bookings SET rescheduled_from_id=NULL WHERE id=$1', [root])
    }
  })

  it.each([
    [
      'import source check',
      (source: string) => source.replace("b.source = 'import'", "b.source = 'never'"),
    ],
    [
      'ancestor traversal',
      (source: string) => source.replace('WHERE id = b.rescheduled_from_id', 'WHERE false'),
    ],
    [
      'successor traversal',
      (source: string) => source.replace('WHERE rescheduled_from_id = b.id', 'WHERE false'),
    ],
  ] as const)(
    'detects source-copy mutation of %s and restores the helper',
    async (_name, mutate) => {
      const source = await readFile(new URL('./imported-bookings.ts', import.meta.url), 'utf8')
      await assertPolicy(helpers(source))
      const mutant = mutate(source)
      expect(mutant).not.toBe(source)
      await expect(assertPolicy(helpers(mutant))).rejects.toMatchObject({ name: 'AssertionError' })
      await assertPolicy(helpers(source))
    },
  )
})
