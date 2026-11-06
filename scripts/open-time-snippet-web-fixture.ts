// Runs in native Node because the browser project rewrites import.meta URLs.
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { generateOpenTimeSnippet, listPublicSlots } from '@hourmere/scheduling'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'

const bootstrap = process.env.DATABASE_URL
if (!bootstrap) throw Error('Missing test database bootstrap')
const database = await createTestDatabase(bootstrap, undefined, {
  tag: 'snippet_link',
})
try {
  const db = createDb(database.pool)
  const user = await createTestUser(db)
  await db
    .insertInto('profiles')
    .values({ user_id: user.id, handle: 'ada', time_zone: 'UTC', locale: 'en' })
    .execute()
  const fixtures = createFixtures(db)
  await fixtures.schedule(user.id, { timeZone: 'UTC' })
  const eventTypeId = await fixtures.eventType(user.principal.organization.id, user.id, {
    slug: 'intro',
  })
  const ctx = testContext(db, user.principal, () => Temporal.Instant.from('2030-03-01T00:00:00Z'))
  const snippet = await generateOpenTimeSnippet(
    ctx,
    { eventTypeId, from: '2030-03-04T00:00:00Z', to: '2030-03-05T00:00:00Z' },
    { publicUrl: 'https://example.test', slotSnippetsEnabled: true },
  )
  const suggested = snippet.slots[0]
  if (!suggested) throw Error('Expected an available snippet slot')
  let mutatedUrl: string
  {
    const location = new URL('../packages/core/src/slot-snippet.ts', import.meta.url)
    const original = readFileSync(location, 'utf8')
    const guard = "url.searchParams.set('start', iso(parsed))"
    if (!original.includes(guard)) throw Error('Mutation must match')
    const changed = stripTypeScriptTypes(original.replace(guard, '')).replace(
      /from '([^']+)'/g,
      (_, specifier: string) =>
        `from '${specifier.startsWith('.') ? new URL(specifier, location).href : pathToFileURL(createRequire(location).resolve(specifier)).href}'`,
    )
    const mutant = await import(
      `data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`
    )
    mutatedUrl = mutant.buildSlotSnippetLink(
      'https://example.test',
      { kind: 'personal', handle: 'ada', slug: 'intro' },
      suggested.start,
      snippet.durationMinutes,
    )
  }
  await fixtures.booking(
    user.principal.organization.id,
    [user.id],
    suggested.start,
    suggested.end,
    { eventTypeId },
  )

  const available = await listPublicSlots(ctx, {
    handle: 'ada',
    slug: 'intro',
    start: Temporal.Instant.from('2030-03-01T00:00:00Z'),
    end: Temporal.Instant.from('2030-03-08T00:00:00Z'),
  })
  process.stdout.write(JSON.stringify({ suggested, available, mutatedUrl }))
} finally {
  await database.drop()
}
