import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import {
  cancelManagedBooking,
  createPublicBooking,
  createPublicTeamBooking,
  getHostBooking,
  getManagedBooking,
  listHostBookings,
  lockHosts,
} from './bookings.ts'
import { DomainError } from './errors.ts'
import { createEventType, getEventType, updateEventType } from './event-types.ts'
import { cancelGroupOccurrence, getGroupOccurrenceAttendees } from './group-occurrences.ts'
import { lockOrganization } from './hosts.ts'
import { isUuid } from './internal.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const NOW = Temporal.Instant.from('2027-11-01T00:00:00Z')
const START = Temporal.Instant.from('2027-11-02T09:00:00Z')
describe.skipIf(!process.env.DATABASE_URL)(
  'group configuration and private occurrence surfaces',
  () => {
    let t: TestDatabase
    let db: Db
    beforeAll(async () => {
      t = await createTestDatabase(process.env.DATABASE_URL as string)
      db = createDb(t.pool)
    })
    afterAll(async () => {
      await t?.drop()
    })
    async function setup(team = false) {
      const f = createFixtures(db)
      const user = await createTestUser(db)
      await db
        .insertInto('profiles')
        .values({ user_id: user.id, handle: `group-${randomUUID().slice(0, 8)}`, time_zone: 'UTC' })
        .execute()
      await f.schedule(user.id)
      const owner = await createTestUser(db),
        admin = await createTestUser(db),
        member = await createTestUser(db),
        outsider = await createTestUser(db)
      const organization = team
        ? await createTestTeam(db, [
            { user, role: 'member' },
            { user: owner, role: 'owner' },
            { user: admin, role: 'admin' },
            { user: member, role: 'member' },
          ])
        : undefined
      const principal = organization?.as(user) ?? user.principal
      const manager = organization?.as(owner) ?? principal
      const ctx = testContext(db, principal, () => NOW)
      const managerCtx = testContext(db, manager, () => NOW)
      const event = await createEventType(managerCtx, {
        slug: `class-${randomUUID()}`,
        title: 'Class',
        durationMinutes: 30,
        bookingMode: 'group',
        groupCapacity: 2,
        hosts: [{ userId: user.id }],
        questions: [{ id: 'topic', label: 'Topic', type: 'short_text', required: false }],
      })
      const profile = await db
        .selectFrom('profiles')
        .select('handle')
        .where('user_id', '=', user.id)
        .executeTakeFirstOrThrow()
      const book = (email: string) =>
        (team ? createPublicTeamBooking : createPublicBooking)(
          { db, now: () => NOW },
          {
            handle: organization ? principal.organization.slug! : profile.handle,
            slug: event.slug,
            start: START,
            invitee: { name: email, email, timeZone: 'UTC' },
            responses: { topic: 'Private answer' },
            idempotencyKey: randomUUID(),
          },
        )
      return { f, user, owner, admin, member, outsider, organization, ctx, managerCtx, event, book }
    }
    it('creates, reads and updates capacity with explicit configuration constraints', async () => {
      const s = await setup()
      expect(await getEventType(s.ctx, s.event.id)).toMatchObject({
        bookingMode: 'group',
        groupCapacity: 2,
      })
      expect(await updateEventType(s.ctx, s.event.id, { groupCapacity: 3 })).toMatchObject({
        groupCapacity: 3,
      })
      for (const change of [
        { groupCapacity: 1 },
        { groupCapacity: 101 },
        { groupCapacity: 2.5 },
        { groupCapacity: null },
        { allowGuests: true },
        { bookingMode: 'individual' as const },
        {
          locations: [
            {
              id: 'phone',
              kind: 'phone' as const,
              askInvitee: true as const,
              isDefault: true as const,
            },
          ],
        },
      ]) {
        await expect(updateEventType(s.ctx, s.event.id, change)).rejects.toMatchObject({
          code: 'invalid_group_configuration',
        })
      }
      for (const schedulingType of ['collective', 'round_robin'] as const) {
        const other = await createTestUser(db)
        const team = await createTestTeam(db, [
          { user: s.user, role: 'owner' },
          { user: other, role: 'member' },
        ])
        await expect(
          createEventType(testContext(db, team.as(s.user)), {
            slug: `bad-${randomUUID()}`,
            title: 'Bad',
            durationMinutes: 30,
            bookingMode: 'group',
            groupCapacity: 2,
            schedulingType,
            hosts: [{ userId: s.user.id }, { userId: other.id }],
          }),
        ).rejects.toMatchObject({ code: 'invalid_group_configuration' })
      }
      expect(
        await updateEventType(s.ctx, s.event.id, { waitlist: { enabled: true } }),
      ).toMatchObject({ waitlist: { enabled: true } })
      await s.book('first@example.test')
      await expect(
        updateEventType(s.ctx, s.event.id, { bookingMode: 'individual', groupCapacity: null }),
      ).rejects.toMatchObject({ code: 'group_mode_has_bookings' })
    })
    it('shows full and cancelled seats only to the host, while manage links reveal only their own seat', async () => {
      const s = await setup()
      const a = await s.book('a@example.test'),
        b = await s.book('b@example.test')
      const hostBooking = await getHostBooking(s.ctx, a.booking.id)
      const id = hostBooking.groupSlotId!
      expect((await listHostBookings(s.ctx)).data.every((seat) => seat.groupSlotId === id)).toBe(
        true,
      )
      await db
        .updateTable('booking_attendees')
        .set({ no_show_marked_at: NOW.toString(), no_show_marked_by: s.user.id })
        .where('booking_id', '=', a.booking.id)
        .execute()
      const full = await getGroupOccurrenceAttendees(s.ctx, id)
      expect(full).toMatchObject({ capacity: 2, activeSeats: 2 })
      expect(full.attendees).toHaveLength(2)
      expect(full.attendees[0]).toMatchObject({
        responses: { topic: 'Private answer' },
        noShowMarkedAt: NOW.toString().replace('Z', '.000Z'),
        noShowMarkedBy: s.user.id,
      })
      const managed = await getManagedBooking({ db, now: () => NOW }, a.manageToken!)
      expect(JSON.stringify(managed)).not.toContain('b@example.test')
      expect(managed).not.toHaveProperty('groupSlotId')
      await cancelManagedBooking({ db, now: () => NOW }, b.manageToken!)
      const partial = await getGroupOccurrenceAttendees(s.ctx, id)
      expect(partial.activeSeats).toBe(1)
      expect(partial.attendees.map((seat) => seat.status)).toEqual(['confirmed', 'cancelled'])
      await expect(
        getGroupOccurrenceAttendees(testContext(db, s.outsider.principal), id),
      ).rejects.toMatchObject({ code: 'group_occurrence_not_found' })
      expect(await cancelGroupOccurrence(s.ctx, id)).toEqual({ id, cancelledSeatCount: 1 })
      expect(await cancelGroupOccurrence(s.ctx, id)).toEqual({ id, cancelledSeatCount: 0 })
      expect((await getGroupOccurrenceAttendees(s.ctx, id)).state).toBe('host_cancelled')
      await expect(s.book('new@example.test')).rejects.toMatchObject({ code: 'slot_unavailable' })
    })
    it('enforces the host/team-session authorization matrix and rechecks cancellation retries', async () => {
      const s = await setup(true)
      const a = await s.book('team-a@example.test')
      await s.book('team-b@example.test')
      const id = (await getHostBooking(s.ctx, a.booking.id)).groupSlotId!
      const session = (user: typeof s.user) => ({
        ...s.organization!.as(user),
        kind: 'session' as const,
        sessionId: randomUUID(),
      })
      for (const user of [s.owner, s.admin]) {
        expect(
          (await getGroupOccurrenceAttendees(testContext(db, session(user)), id)).attendees,
        ).toHaveLength(2)
        await expect(
          getGroupOccurrenceAttendees(testContext(db, s.organization!.as(user)), id),
        ).rejects.toMatchObject({ code: 'group_occurrence_not_found' })
      }
      for (const principal of [
        session(s.member),
        s.organization!.as(s.member),
        s.outsider.principal,
        {
          ...s.organization!.as(s.owner),
          kind: 'oauth' as const,
          oauthConsentId: randomUUID(),
          clientId: randomUUID(),
          scopes: ['mcp:tools'],
        },
      ]) {
        await expect(
          getGroupOccurrenceAttendees(testContext(db, principal), id),
        ).rejects.toMatchObject({ code: 'group_occurrence_not_found' })
        await expect(cancelGroupOccurrence(testContext(db, principal), id)).rejects.toMatchObject({
          code: 'group_occurrence_not_found',
        })
      }
      expect(
        (
          await getGroupOccurrenceAttendees(
            {
              ...s.ctx,
              principal: {
                ...s.ctx.principal,
                kind: 'oauth',
                oauthConsentId: randomUUID(),
                clientId: randomUUID(),
                scopes: ['mcp:tools'],
              },
            },
            id,
          )
        ).attendees,
      ).toHaveLength(2)
      expect(await cancelGroupOccurrence({ ...s.ctx, principal: session(s.admin) }, id)).toEqual({
        id,
        cancelledSeatCount: 2,
      })
      await db
        .deleteFrom('auth.member')
        .where('organizationId', '=', s.organization!.id)
        .where('userId', '=', s.admin.id)
        .execute()
      await expect(
        cancelGroupOccurrence({ ...s.ctx, principal: session(s.admin) }, id),
      ).rejects.toMatchObject({ code: 'group_occurrence_not_found' })
    })
    it('kills occurrence authorization and organization-isolation source-copy mutations', async () => {
      const s = await setup(true)
      const booking = await s.book('mutation@example.test')
      const id = (await getHostBooking(s.ctx, booking.booking.id)).groupSlotId as string
      const original = readFileSync(new URL('./group-occurrences.ts', import.meta.url), 'utf8')
      const source = original
        .slice(original.indexOf('const missing ='))
        .split('/** Repeated cancellation')[0] as string
      const copy = (from: string, to: string) => {
        expect(source).toContain(from)
        const code = stripTypeScriptTypes(source.replace(from, to)).replace(/\bexport /g, '')
        const bindings = { DomainError, lockOrganization, lockHosts, isUuid }
        return guardCopy<typeof getGroupOccurrenceAttendees>(
          new Function(...Object.keys(bindings), `${code};return getGroupOccurrenceAttendees`)(
            ...Object.values(bindings),
          ),
        )
      }
      for (const [from, to, principal] of [
        ['if (!host && !manager) throw missing()', '', s.organization!.as(s.member)],
        [".where('organization_id', '=', ctx.principal.organization.id)", '', s.user.principal],
      ] as const) {
        const verify = async (fn: typeof getGroupOccurrenceAttendees) => {
          await expect(fn(testContext(db, principal), id)).rejects.toMatchObject({
            code: 'group_occurrence_not_found',
          })
        }
        await verify(getGroupOccurrenceAttendees)
        await verify(copy(from, from))
        await expectKilled(copy(from, to), verify)
        await verify(getGroupOccurrenceAttendees)
      }
    })
  },
)
