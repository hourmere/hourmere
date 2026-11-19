import '@hono/zod-openapi'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { optOutOfMeetingPollReminders } from '../packages/scheduling/src/meeting-poll-ballots.ts'
import { readMeetingPoll } from '../packages/scheduling/src/meeting-poll-public.ts'
import { createFixtures } from '../packages/scheduling/src/testing.ts'
import { seedPollAuditData } from '../tools/e2e/meeting-poll-audit-data.ts'

let owned: TestDatabase
let db: Db
beforeAll(async () => {
  owned = await createTestDatabase(process.env.DATABASE_URL as string)
  db = createDb(owned.pool)
})
afterAll(async () => {
  await owned?.drop()
})
it('prepares real public audit states without creation transports or mail providers', async () => {
  const fixtures = createFixtures(db)
  const host = await fixtures.host()
  const eventId = await fixtures.eventType(host.organizationId, host.userId)
  const secret = 'synthetic-poll-audit-fixture-secret'
  const context = { db, meetingPollSecret: secret }
  for (const state of ['enroll', 'verify', 'vote', 'saved', 'withdrawn', 'closed'] as const) {
    const tokens = await seedPollAuditData(db, host, eventId, secret, state)
    const publicRead = await readMeetingPoll(context, { token: tokens.publicToken })
    expect(publicRead.ownBallot).toBeNull()
    expect(publicRead.counts).toBeNull()
    const own = await readMeetingPoll(context, { token: tokens.voterToken })
    expect(own.readOnly).toBe(state === 'closed')
    if (state === 'verify') expect(own.ownBallot).toBeNull()
    else expect(own.ownBallot?.voter.status).toBe(state === 'withdrawn' ? 'withdrawn' : 'verified')
    expect(own.ownBallot?.votes.length ?? 0).toBe(state === 'saved' || state === 'closed' ? 2 : 0)
    expect(
      (await optOutOfMeetingPollReminders(context, { token: tokens.optOutToken })).pollId,
    ).toBe(tokens.pollId)
  }
})
