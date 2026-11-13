import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { groupFixture, occupiedSlot } from '../../db/src/group-seats-fixtures.ts'
import { toIso } from './availability.ts'
import { resolveBookingOrganization } from './booking-organization.ts'
import { bookingPageQuery, encodeBookingCursor } from './booking-page.ts'
import { getManagedBooking, managedLinkRescheduleRequest } from './bookings.ts'
import { checkedCatalogPage } from './catalog-page.ts'
import { changeDeadline } from './change-deadlines.ts'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'
import { resolvedBookingHosts } from './hosts.ts'
import { isUuid } from './internal.ts'
import { getManagedBookingDetails } from './manage.ts'
import { getTeamMemberDepartureImpact } from './member-departure-impact.ts'
import { TeamAdminBookingSchema, toTeamAdminBooking } from './team-admin-booking.ts'
import { readTeamBookingPage } from './team-bookings.ts'
import { testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
const now = () => Temporal.Instant.from('2031-01-01T00:00Z')

function copy<T>(
  file: string,
  exported: string,
  bindings: Record<string, unknown>,
  mutate = false,
): T {
  let source = readFileSync(`packages/scheduling/src/${file}.ts`, 'utf8')
  if (mutate) {
    expect(source).toContain('resolvedBookingHosts(')
    source = source.replaceAll(
      /resolvedBookingHosts\((?:ctx\.)?db\)\.as\('([^']+)'\)/g,
      "'booking_hosts as $1'",
    )
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  return new Function(...Object.keys(bindings), `${source}; return ${exported}`)(
    ...Object.values(bindings),
  ) as T
}

describe.skipIf(!serverUrl)('group seat read models', () => {
  let owned: TestDatabase
  let db: Db
  let ctx: ServiceContext
  let ids: string[]
  let token: string
  let siblingEmail: string
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    const f = await groupFixture(owned.pool)
    const occupied = await occupiedSlot(f, 2)
    ids = occupied.bookings
    await db
      .insertInto('auth.member')
      .values({
        organizationId: f.organization,
        userId: f.host,
        role: 'member',
        createdAt: new Date(),
      })
      .execute()
    const session = await db
      .insertInto('auth.session')
      .values({
        userId: f.host,
        token: randomUUID(),
        expiresAt: new Date('2040-01-01'),
        updatedAt: new Date(),
        activeOrganizationId: f.organization,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    ctx = testContext(
      db,
      {
        kind: 'session',
        sessionId: session.id,
        user: { id: f.host, name: 'Group host', email: 'host@example.test' },
        organization: { id: f.organization, name: 'Group team', slug: 'group', personal: false },
      },
      now,
    )
    token = randomBytes(32).toString('base64url')
    await db
      .updateTable('bookings')
      .set({ manage_token_hash: createHash('sha256').update(token).digest() })
      .where('id', '=', ids[0] as string)
      .execute()
    await db
      .updateTable('booking_attendees')
      .set({ name: 'Private sibling' })
      .where('booking_id', '=', ids[1] as string)
      .execute()
    siblingEmail = (
      await db
        .selectFrom('booking_attendees')
        .select('email')
        .where('booking_id', '=', ids[1] as string)
        .executeTakeFirstOrThrow()
    ).email
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function verifyOrganization(read: typeof resolveBookingOrganization) {
    for (const id of ids)
      expect(
        await read(ctx, id).catch((error: unknown) => {
          if (error instanceof DomainError && error.code === 'booking_not_found') return undefined
          throw error
        }),
      ).toEqual({
        organizationId: ctx.principal.organization.id,
        access: 'host',
      })
  }
  async function verifyTeam(read: typeof readTeamBookingPage) {
    const page = await read(ctx, ctx.principal.organization.id, {}, ctx.principal.user.id)
    expect(page.data.map((seat) => seat.id).sort()).toEqual([...ids].sort())
    for (const seat of page.data)
      expect(seat.hosts).toEqual([
        expect.objectContaining({ userId: ctx.principal.user.id, name: 'Group host' }),
      ])
    expect(page.data.flatMap((seat) => seat.attendees).map((a) => a.email)).toContain(siblingEmail)
  }
  async function verifyManage(read: typeof getManagedBookingDetails) {
    const seat = await read(ctx, token)
    expect(seat.hosts).toEqual([{ name: 'Group host' }])
    expect(JSON.stringify(seat)).not.toContain('Private sibling')
    expect(JSON.stringify(seat)).not.toContain(siblingEmail)
  }
  async function verifyImpact(read: typeof getTeamMemberDepartureImpact) {
    const result = await read(ctx, {
      teamId: ctx.principal.organization.id,
      memberUserId: ctx.principal.user.id,
    })
    expect(result.bookings.totalCount).toBe(2)
    expect(result.bookings.data.map((seat) => seat.id).sort()).toEqual([...ids].sort())
  }
  it('counts all seats in member departure impact', () =>
    verifyImpact(getTeamMemberDepartureImpact))
  it('kills direct-host impact count regression with a real assertion', async () => {
    const read = copy<typeof getTeamMemberDepartureImpact>(
      'member-departure-impact',
      'getTeamMemberDepartureImpact',
      {
        sql,
        z,
        DomainError,
        isUuid,
        resolvedBookingHosts,
        checkedCatalogPage,
        TeamAdminBookingSchema,
        readTeamBookingPage,
      },
      true,
    )
    await expect(verifyImpact(read)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('resolves host organization for every seat without direct seat host rows', () =>
    verifyOrganization(resolveBookingOrganization))
  it('shows every seat and shared host to the host through team reads', () =>
    verifyTeam(readTeamBookingPage))
  it('shows only the managed seat and shared host to the attendee', () =>
    verifyManage(getManagedBookingDetails))
  it('kills direct-host organization regression', async () => {
    const read = copy<typeof resolveBookingOrganization>(
      'booking-organization',
      'resolveBookingOrganization',
      { sql, DomainError, isUuid, resolvedBookingHosts },
      true,
    )
    await expect(verifyOrganization(read)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('kills direct-host team filter regression with a real assertion', async () => {
    const read = copy<typeof readTeamBookingPage>(
      'team-bookings',
      'readTeamBookingPage',
      {
        sql,
        DomainError,
        isUuid,
        resolvedBookingHosts,
        bookingPageQuery,
        encodeBookingCursor,
        toTeamAdminBooking,
      },
      true,
    )
    await expect(verifyTeam(read)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('kills direct-host manage projection regression with a real assertion', async () => {
    const read = copy<typeof getManagedBookingDetails>(
      'manage',
      'getManagedBookingDetails',
      {
        getManagedBooking,
        managedLinkRescheduleRequest,
        resolvedBookingHosts,
        changeDeadline,
        toIso,
      },
      true,
    )
    await expect(verifyManage(read)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
