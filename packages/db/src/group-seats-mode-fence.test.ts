import { describe, it } from 'vitest'
import { groupFixture } from './group-seats-fixtures.ts'
import { assertGroupModeFence } from './group-seats-mode-fence.ts'
import { createTestDatabase } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

describe.skipIf(!serverUrl)('group event mode fence', () => {
  it('serializes ordinary booking admission against mode conversion on distinct bounded connections in 20 rounds', async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'group_mode' })
    try {
      await assertGroupModeFence(await groupFixture(owned.pool), 20)
    } finally {
      await owned.drop()
    }
  }, 60_000)
})
