import { createDb } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { putProfile } from '@hourmere/scheduling'
import { createFixtures, createTestUser, testContext } from '@hourmere/scheduling/testing'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { parseRoutingFormsEnabled, resolveRoutingFormsEnabled } from './routing-form-setting.ts'

describe('ROUTING_FORMS_ENABLED', () => {
  it.each([
    ['true', true],
    ['false', false],
    ['', false],
    [undefined, false],
  ])('parses %j as %s', (value, enabled) => {
    expect(parseRoutingFormsEnabled(value)).toBe(enabled)
  })

  it.each(['TRUE', 'False', 'yes', '0', '1', ' true', 'false ', ' '])('rejects %j', (value) => {
    expect(() => parseRoutingFormsEnabled(value)).toThrow(
      'ROUTING_FORMS_ENABLED must be true or false',
    )
  })
})

const serverUrl = process.env.DATABASE_URL

it.skipIf(!serverUrl)(
  'keeps routing off for a legacy personal handle until its owner renames it',
  async () => {
    const owned = await createTestDatabase(serverUrl as string, undefined, {
      tag: 'routing_setting',
    })
    onTestFinished(() => owned.drop())
    const db = createDb(owned.pool)
    const warn = vi.fn()
    const effective = (value: string | undefined) =>
      resolveRoutingFormsEnabled({ db, routingFormsEnabled: parseRoutingFormsEnabled(value), warn })

    await createFixtures(db).organization('route')
    expect(await effective(undefined)).toBe(false)
    expect(await effective('true')).toBe(true)
    expect(warn).not.toHaveBeenCalled()

    const owner = await createTestUser(db)
    await db
      .insertInto('profiles')
      .values({ user_id: owner.id, handle: 'route', time_zone: 'UTC' })
      .execute()
    expect(await effective('true')).toBe(false)
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /legacy personal handle.*"route".*rename with the owner.*restart Hourmere/i,
      ),
    )
    const stored = await db
      .selectFrom('profiles')
      .select('handle')
      .where('user_id', '=', owner.id)
      .executeTakeFirstOrThrow()
    expect(stored.handle).toBe('route')

    await putProfile(testContext(db, owner.principal), {
      handle: 'renamed-owner',
      timeZone: 'UTC',
      locale: 'en',
    })
    warn.mockClear()
    expect(await effective('true')).toBe(true)
    expect(await effective('false')).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  },
  60_000,
)
