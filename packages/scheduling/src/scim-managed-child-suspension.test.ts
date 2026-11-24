import { randomUUID } from 'node:crypto'
import type { WeeklyHours } from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findOneTimeEventType, findPublicBookingPath } from './availability.ts'
import { resolveBookingOrganization } from './booking-organization.ts'
import type { ServiceContext } from './context.ts'
import {
  activateRoundRobin,
  createEventType,
  getEventTypeWaitlist,
  updateEventType,
} from './event-types.ts'
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

describe.skipIf(!serverUrl)('directory-managed child suspension in scheduling', () => {
  let owned: TestDatabase
  let db: Db
  let active: TestUser
  let suspended: TestUser
  let teamId: string
  let eventTypeId: string
  let individualEventId: string
  let bookingId: string
  let owner: ServiceContext
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
    owner = testContext(db, team.as(active), () => NOW)
    const event = await createEventType(owner, {
      slug: 'managed-rotation',
      title: 'Rotating hosts',
      schedulingType: 'round_robin',
      durationMinutes: 30,
      hosts: [{ userId: active.id }, { userId: suspended.id }],
    })
    await activateRoundRobin(owner, event.id)
    eventTypeId = event.id
    individualEventId = (
      await createEventType(owner, {
        slug: 'managed-host',
        title: 'Managed host',
        durationMinutes: 30,
        hosts: [{ userId: suspended.id }],
      })
    ).id
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

    await f.suspendManagedChildMembership(teamId, suspended.id)
  })

  afterAll(async () => {
    await owned?.drop()
  })

  it('excludes the suspended host with provisioning enabled or disabled', async () => {
    const both = [active.id, suspended.id].sort()
    await expect(readEligibleHostIds(db, teamId, both)).resolves.toEqual([active.id])
    await expect(readEligibleHostIds(db, teamId, both, false, false)).resolves.toEqual([active.id])
    await expect(readEligibleHostIds(db, teamId, both, false, true)).resolves.toEqual([active.id])
    await expect(assertHosts(db, teamId, [suspended.id])).rejects.toMatchObject({
      code: 'invalid_hosts',
    })
    await expect(assertHosts(db, teamId, [suspended.id], false, true)).rejects.toMatchObject({
      code: 'invalid_hosts',
    })

    for (const options of [undefined, {}, { scimResourcesEnabled: false }])
      expect((await findOneTimeEventType(db, eventTypeId, options))?.eligibleHostUserIds).toEqual([
        active.id,
      ])
    expect(
      (await findOneTimeEventType(db, eventTypeId, { scimResourcesEnabled: true }))
        ?.eligibleHostUserIds,
    ).toEqual([active.id])
  })

  it('withholds a reusable booking path for a directory-suspended sole host', async () => {
    await expect(findPublicBookingPath(db, individualEventId, false)).resolves.toBeUndefined()
    await expect(findPublicBookingPath(db, individualEventId, true)).resolves.toBeUndefined()
  })

  it('checks the current host when an update enables a waitlist without changing hosts', async () => {
    const patch = { waitlist: { enabled: true } }
    await expect(
      updateEventType({ ...owner, scimResourcesEnabled: true }, individualEventId, patch),
    ).rejects.toMatchObject({ code: 'waitlist_unsupported' })
    await expect(getEventTypeWaitlist(owner, individualEventId)).resolves.toEqual({
      enabled: false,
    })
    await expect(updateEventType(owner, individualEventId, patch)).rejects.toMatchObject({
      code: 'waitlist_unsupported',
    })
  })

  it('withholds the routing snapshot with provisioning enabled or disabled', async () => {
    await expect(readBookingRoutingSnapshot(member, bookingId)).resolves.toBeUndefined()
    await expect(
      readBookingRoutingSnapshot({ ...member, scimResourcesEnabled: false }, bookingId),
    ).resolves.toBeUndefined()
    await expect(
      readBookingRoutingSnapshot({ ...member, scimResourcesEnabled: true }, bookingId),
    ).resolves.toBeUndefined()
  })

  it('excludes the suspended recurring candidate with provisioning enabled or disabled', async () => {
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
    expect(await hosts()).toEqual([active.id])
    expect(await hosts(false)).toEqual([active.id])
    expect(await hosts(true)).toEqual([active.id])
  })

  it('refuses to resolve the booking team with provisioning enabled or disabled', async () => {
    await expect(resolveBookingOrganization(session, bookingId)).rejects.toMatchObject({
      code: 'booking_not_found',
    })
    await expect(
      resolveBookingOrganization({ ...session, scimResourcesEnabled: true }, bookingId),
    ).rejects.toMatchObject({ code: 'booking_not_found' })
  })
})
