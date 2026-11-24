import { randomUUID } from 'node:crypto'
import type { WeeklyHours } from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findOneTimeEventType } from './availability.ts'
import { resolveBookingOrganization } from './booking-organization.ts'
import type { ServiceContext } from './context.ts'
import { activateRoundRobin, createEventType } from './event-types.ts'
import { assertHosts, readEligibleHostIds } from './hosts.ts'
import { checkRecurringAvailability } from './recurring-availability.ts'
import { readBookingRoutingSnapshot } from './routing-booking.ts'
import {
  createFixtures,
  createTestTeam,
  createTestUser,
  type TestUser,
  testContext,
  weekdays,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const instant = Temporal.Instant.from
const NOW = instant('2026-11-01T00:00Z')
const everyDay: WeeklyHours = {
  ...weekdays({ start: '00:00', end: '24:00' }),
  saturday: [{ start: '00:00', end: '24:00' }],
  sunday: [{ start: '00:00', end: '24:00' }],
}

// The capability is the caller's: absent or false must read exactly as before.
describe.skipIf(!serverUrl)('directory-managed child suspension in scheduling', () => {
  let owned: TestDatabase
  let db: Db
  let active: TestUser
  let suspended: TestUser
  let teamId: string
  let eventTypeId: string
  let bookingId: string
  let member: ServiceContext
  let session: ServiceContext

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'scim_child_susp' })
    db = createDb(owned.pool)
    const f = createFixtures(db)
    active = await createTestUser(db, 'Active host')
    suspended = await createTestUser(db, 'Suspended host')
    const team = await createTestTeam(db, [
      { user: active, role: 'owner' },
      { user: suspended, role: 'member' },
    ])
    teamId = team.id
    for (const host of [active, suspended])
      await f.schedule(host.id, { timeZone: 'UTC', weeklyHours: everyDay })
    const owner = testContext(db, team.as(active), () => NOW)
    const event = await createEventType(owner, {
      slug: 'managed-rotation',
      title: 'Rotating hosts',
      schedulingType: 'round_robin',
      durationMinutes: 30,
      hosts: [{ userId: active.id }, { userId: suspended.id }],
    })
    await activateRoundRobin(owner, event.id)
    eventTypeId = event.id
    bookingId = await f.booking(teamId, [suspended.id], '2026-12-01T12:00Z', '2026-12-01T12:30Z', {
      eventTypeId,
    })
    member = testContext(db, team.as(suspended), () => NOW)
    const { id: sessionId } = await db
      .insertInto('auth.session')
      .values({
        userId: suspended.id,
        token: randomUUID(),
        expiresAt: new Date('2040-01-01'),
        updatedAt: new Date(),
        activeOrganizationId: teamId,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const { id, name, email } = suspended
    session = testContext(
      db,
      {
        kind: 'session',
        sessionId,
        user: { id, name, email },
        organization: member.principal.organization,
      },
      () => NOW,
    )

    // A Group-sourced membership of the child team, suspended with its source User.
    const parent = await f.organization()
    const connection = randomUUID()
    const mapping = randomUUID()
    await owned.pool.query('INSERT INTO scim_connections (id, organization_id) VALUES ($1,$2)', [
      connection,
      parent,
    ])
    await owned.pool.query(
      `INSERT INTO scim_team_mappings (id, parent_organization_id, child_organization_id,
       connection_id, external_id) VALUES ($1,$2,$3,$4,'roster')`,
      [mapping, parent, teamId, connection],
    )
    await owned.pool.query(
      `INSERT INTO scim_team_managed_memberships
       (member_id, mapping_id, child_organization_id, user_id, suspended_at)
       SELECT id, $1, "organizationId", "userId", clock_timestamp() FROM auth.member
       WHERE "organizationId" = $2 AND "userId" = $3`,
      [mapping, teamId, suspended.id],
    )
  })

  afterAll(async () => {
    await owned?.drop()
  })

  it('keeps the host eligible unless the caller holds the capability', async () => {
    const both = [active.id, suspended.id].sort()
    await expect(readEligibleHostIds(db, teamId, both)).resolves.toEqual(both)
    await expect(readEligibleHostIds(db, teamId, both, false, false)).resolves.toEqual(both)
    await expect(readEligibleHostIds(db, teamId, both, false, true)).resolves.toEqual([active.id])
    await expect(assertHosts(db, teamId, [suspended.id])).resolves.toBeUndefined()
    await expect(assertHosts(db, teamId, [suspended.id], false, true)).rejects.toMatchObject({
      code: 'invalid_hosts',
    })

    // The event lookup options carry the same capability to the host read.
    for (const options of [undefined, {}, { scimResourcesEnabled: false }])
      expect((await findOneTimeEventType(db, eventTypeId, options))?.eligibleHostUserIds).toEqual(
        both,
      )
    expect(
      (await findOneTimeEventType(db, eventTypeId, { scimResourcesEnabled: true }))
        ?.eligibleHostUserIds,
    ).toEqual([active.id])
  })

  it('reads the routing snapshot for the member unless the capability is held', async () => {
    await expect(readBookingRoutingSnapshot(member, bookingId)).resolves.toBeNull()
    await expect(
      readBookingRoutingSnapshot({ ...member, scimResourcesEnabled: false }, bookingId),
    ).resolves.toBeNull()
    await expect(
      readBookingRoutingSnapshot({ ...member, scimResourcesEnabled: true }, bookingId),
    ).resolves.toBeUndefined()
  })

  it('keeps the recurring candidate unless the capability is held', async () => {
    const request = {
      eventTypeId,
      organizationId: teamId,
      now: NOW,
      occurrences: ['2026-11-03T12:00Z', '2026-11-10T12:00Z'].map((value, index) => {
        const start = instant(value)
        return {
          ordinal: index + 1,
          start,
          end: start.add({ minutes: 30 }),
          localStart: start.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
          offset: '+00:00',
        }
      }),
    }
    const hosts = async (...capability: boolean[]) =>
      [...(await checkRecurringAvailability(db, request, ...capability)).hostUserIds].sort()
    const both = [active.id, suspended.id].sort()
    expect(await hosts()).toEqual(both)
    expect(await hosts(false)).toEqual(both)
    expect(await hosts(true)).toEqual([active.id])
  })

  it('resolves the booking team for the host unless the capability is held', async () => {
    await expect(resolveBookingOrganization(session, bookingId)).resolves.toEqual({
      organizationId: teamId,
      access: 'host',
    })
    await expect(
      resolveBookingOrganization({ ...session, scimResourcesEnabled: true }, bookingId),
    ).rejects.toMatchObject({ code: 'booking_not_found' })
  })
})
