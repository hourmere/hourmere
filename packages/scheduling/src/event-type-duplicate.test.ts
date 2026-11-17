import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import {
  activateRoundRobin,
  createEventType,
  duplicateEventType,
  getEventType,
  updateEventType,
} from './event-types.ts'
import { createOneTimeBookingLink } from './one-time-links.ts'
import { createFixtures, createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL

type Duplicate = { duplicateEventType: typeof duplicateEventType }
async function sourceCopy(change?: readonly [string, string]): Promise<Duplicate> {
  const moduleUrl = new URL('event-types.ts', import.meta.url)
  let source = readFileSync(moduleUrl, 'utf8')
  if (change) {
    expect(source.includes(change[0]), 'mutation must match').toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source)
  const dependencies: Record<string, unknown> = {}
  for (const item of [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]) {
    const specifier = item[2] as string
    const imported = await import(
      specifier.startsWith('.') ? new URL(specifier, moduleUrl).href : specifier
    )
    for (const binding of (item[1] as string)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const [name, local] = binding.split(/\s+as\s+/)
      dependencies[local ?? (name as string)] = imported[name as string]
    }
    source = source.replace(item[0], '')
  }
  return guardCopy(
    new Function(
      ...Object.keys(dependencies),
      `${source.replace(/\bexport /g, '')}; return {duplicateEventType}`,
    )(...Object.values(dependencies)) as Duplicate,
  )
}

describe.skipIf(!serverUrl)('duplicate event type', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('copies all editable settings but no bookings, history, statistics or one-time links', async () => {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    const fixtures = createFixtures(db)
    const scheduleId = await fixtures.schedule(user.id)
    const source = await createEventType(ctx, {
      slug: 'configured',
      title: 'Configured',
      description: 'A description',
      durationMinutes: 30,
      allowedDurationsMinutes: [15, 30, 60],
      slotStepMinutes: 15,
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 10,
      minimumNoticeMinutes: 120,
      bookingWindowDays: 21,
      maxBookingsPerDay: 2,
      maxBookingsPerWeek: 4,
      maxBookingsPerMonth: 8,
      rescheduleCutoffMinutes: 60,
      cancelCutoffMinutes: 30,
      locations: [
        { id: 'office', kind: 'in_person', address: 'Office', label: 'Office', isDefault: true },
        { id: 'phone', kind: 'phone', askInvitee: true },
      ],
      questions: [{ id: 'topic', type: 'short_text', label: 'Topic', required: true }],
      notifications: { reminders: [], followUps: [] },
      waitlist: { enabled: true },
      successRedirect: { url: 'https://example.com/thanks', parameters: ['eventTypeSlug'] },
      isHidden: true,
      allowGuests: true,
      smsRemindersEnabled: true,
      position: 7,
      scheduleId,
    })
    await createOneTimeBookingLink(
      {
        ...ctx,
        principal: {
          kind: 'session',
          sessionId: randomUUID(),
          user: user.principal.user,
          organization: user.principal.organization,
        },
      },
      { eventTypeId: source.id, idempotencyKey: randomUUID() },
    )
    await fixtures.booking(
      user.principal.organization.id,
      [user.id],
      '2036-01-01T10:00Z',
      '2036-01-01T10:30Z',
      { eventTypeId: source.id },
    )
    const disabled = await updateEventType(ctx, source.id, { isActive: false })
    const copy = await duplicateEventType(ctx, source.id)
    expect(copy.id).not.toBe(source.id)
    const { id: _id, slug: _slug, createdAt: _created, updatedAt: _updated, ...settings } = disabled
    expect(copy).toMatchObject({ ...settings, slug: 'configured-copy' })
    expect(await getEventType(ctx, source.id)).toEqual(disabled)
    for (const table of ['bookings', 'one_time_booking_links'] as const) {
      expect(
        await db.selectFrom(table).select('id').where('event_type_id', '=', copy.id).execute(),
      ).toEqual([])
      expect(
        await db.selectFrom(table).select('id').where('event_type_id', '=', source.id).execute(),
      ).toHaveLength(1)
    }
    expect(
      await db
        .selectFrom('audit_events')
        .select('action')
        .where('target_id', '=', copy.id)
        .execute(),
    ).toEqual([{ action: 'event_type.created' }])
  })

  it('serializes concurrent copies and skips occupied slugs, including maximum-length names', async () => {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    const slug = 'x'.repeat(64)
    const source = await createEventType(ctx, { slug, title: 'Long', durationMinutes: 30 })
    await createEventType(ctx, {
      slug: `${'x'.repeat(59)}-copy`,
      title: 'Occupied',
      durationMinutes: 30,
    })
    const copies = await Promise.all([
      duplicateEventType(ctx, source.id),
      duplicateEventType(ctx, source.id),
    ])
    expect(copies.map((copy) => copy.slug).sort()).toEqual([
      `${'x'.repeat(57)}-copy-2`,
      `${'x'.repeat(57)}-copy-3`,
    ])
    expect(new Set(copies.map((copy) => copy.id)).size).toBe(2)
  })

  it('requires current create permission and isolates other organizations', async () => {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const outsider = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const source = await createEventType(testContext(db, team.as(owner)), {
      slug: 'team',
      title: 'Team',
      durationMinutes: 30,
    })
    await expect(
      duplicateEventType(testContext(db, team.as(member)), source.id),
    ).rejects.toMatchObject({ code: 'insufficient_role' })
    await expect(
      duplicateEventType(testContext(db, outsider.principal), source.id),
    ).rejects.toMatchObject({ code: 'event_type_not_found' })
    const copy = await duplicateEventType(testContext(db, team.as(admin)), source.id)
    expect(copy).toMatchObject({ organizationId: team.id, ownerUserId: null, hosts: source.hosts })
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    await expect(
      duplicateEventType(testContext(db, team.as(admin)), source.id),
    ).rejects.toMatchObject({ code: 'insufficient_role' })
    const personal = await createEventType(testContext(db, owner.principal), {
      slug: 'private',
      title: 'Private',
      durationMinutes: 30,
    })
    const forged = { ...owner.principal, user: outsider.principal.user }
    await expect(duplicateEventType(testContext(db, forged), personal.id)).rejects.toMatchObject({
      code: 'insufficient_role',
    })
  })

  it('copies a round-robin pool without activation or its fairness history', async () => {
    const owner = await createTestUser(db)
    const member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const ctx = testContext(db, team.as(owner))
    const source = await createEventType(ctx, {
      slug: 'pool',
      title: 'Pool',
      durationMinutes: 30,
      schedulingType: 'round_robin',
      hosts: [{ userId: owner.id }, { userId: member.id }],
    })
    await activateRoundRobin(ctx, source.id)
    const copy = await duplicateEventType(ctx, source.id)
    expect(copy).toMatchObject({
      schedulingType: 'round_robin',
      hosts: source.hosts,
      roundRobinActive: false,
    })
    expect(
      await db
        .selectFrom('round_robin_state')
        .selectAll()
        .where('event_type_id', '=', copy.id)
        .execute(),
    ).toEqual([])
    expect(await getEventType(ctx, source.id)).toMatchObject({ roundRobinActive: true })
  })

  it('rechecks the session organization context before copying', async () => {
    const user = await createTestUser(db)
    const ctx = testContext(db, user.principal)
    const source = await createEventType(ctx, {
      slug: 'session',
      title: 'Session',
      durationMinutes: 30,
    })
    await expect(
      duplicateEventType(
        {
          ...ctx,
          authorizeOrganizationWrite: async () => {
            throw new Error('organization_context_changed')
          },
        },
        source.id,
      ),
    ).rejects.toThrow('organization_context_changed')
    expect(
      await db
        .selectFrom('event_types')
        .select('id')
        .where('organization_id', '=', user.principal.organization.id)
        .execute(),
    ).toHaveLength(1)
  })
  async function assertCreateAuthorization(api: Duplicate) {
    const owner = await createTestUser(db)
    const member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: member, role: 'member' },
    ])
    const source = await createEventType(testContext(db, team.as(owner)), {
      slug: 'guard',
      title: 'Guard',
      durationMinutes: 30,
    })
    await expect(
      api.duplicateEventType(testContext(db, team.as(member)), source.id),
    ).rejects.toMatchObject({ code: 'insufficient_role' })
  }
  async function assertOrganizationIsolation(api: Duplicate) {
    const owner = await createTestUser(db)
    const first = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const second = await createTestTeam(db, [{ user: owner, role: 'owner' }])
    const source = await createEventType(testContext(db, first.as(owner)), {
      slug: 'isolated',
      title: 'Isolated',
      durationMinutes: 30,
    })
    await expect(
      api.duplicateEventType(testContext(db, second.as(owner)), source.id),
    ).rejects.toMatchObject({ code: 'event_type_not_found' })
  }
  it('validates the unmutated source copy before authorization negative controls', async () => {
    const copy = await sourceCopy()
    await assertCreateAuthorization(copy)
    await assertOrganizationIsolation(copy)
  })
  it('detects removal of create authorization in a source copy', async () => {
    const copy = await sourceCopy([
      'if (personalOwnerId !== null ? personalOwnerId !== ctx.principal.user.id : !canManageTeam) {\n        throw insufficientRole()\n      }',
      '',
    ])
    await expectKilled(copy, assertCreateAuthorization)
  })
  it('detects removal of source organization isolation in a source copy', async () => {
    const copy = await sourceCopy(['await visibleRow(trx, ctx, sourceId, { lock: true })', ''])
    await expectKilled(copy, assertOrganizationIsolation)
  })
})
