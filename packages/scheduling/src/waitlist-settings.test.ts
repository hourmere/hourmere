import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectKilled, guardCopy } from '../../../scripts/source-copy-guard.ts'
import * as events from './event-types.ts'
import { createTestTeam, createTestUser, testContext } from './testing.ts'

const serverUrl = process.env.DATABASE_URL
type Settings = Pick<
  typeof events,
  | 'getEventTypeWaitlist'
  | 'setEventTypeWaitlist'
  | 'getEventTypeWaitlistSummary'
  | 'listEventTypeWaitlistEntries'
  | 'removeEventTypeWaitlistEntry'
  | 'createEventType'
  | 'updateEventType'
  | 'getEventType'
>

/** Execute mutated source with the real dependencies and the same Postgres fixture. */
async function sourceCopy(replacement: readonly [string, string]): Promise<Settings> {
  const moduleUrl = new URL('event-types.ts', import.meta.url)
  let source = readFileSync(moduleUrl, 'utf8')
  expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
  source = stripTypeScriptTypes(source.replace(...replacement))
  const dependencies: Record<string, unknown> = {}
  const imports = [...source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from '([^']+)'\n/gm)]
  for (const item of imports) {
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
  source = source.replace(/\bexport /g, '')
  const settings = new Function(
    ...Object.keys(dependencies),
    `${source}; return {getEventTypeWaitlist,setEventTypeWaitlist,getEventTypeWaitlistSummary,listEventTypeWaitlistEntries,removeEventTypeWaitlistEntry,createEventType,updateEventType,getEventType}`,
  )(...Object.values(dependencies)) as Settings
  return guardCopy(settings)
}

describe.skipIf(!serverUrl)('internal waitlist settings', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'waitlist_config' })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture() {
    const owner = await createTestUser(db)
    const admin = await createTestUser(db)
    const member = await createTestUser(db)
    const outsider = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const personal = testContext(db, owner.principal)
    const teamOwner = testContext(db, team.as(owner))
    const teamAdmin = testContext(db, team.as(admin))
    const teamMember = testContext(db, team.as(member))
    const foreign = testContext(db, outsider.principal)
    const personalEvent = await events.createEventType(personal, {
      slug: 'waitlist',
      title: 'Waitlist',
      durationMinutes: 30,
    })
    const teamEvent = await events.createEventType(teamOwner, {
      slug: 'team-waitlist',
      title: 'Team waitlist',
      durationMinutes: 30,
      hosts: [{ userId: owner.id }],
    })
    return {
      owner,
      admin,
      member,
      outsider,
      team,
      personal,
      teamOwner,
      teamAdmin,
      teamMember,
      foreign,
      personalEvent,
      teamEvent,
    }
  }

  async function assertRoles(api: Settings) {
    const f = await fixture()
    for (const ctx of [f.teamMember, f.foreign]) {
      for (const method of [
        () => api.getEventTypeWaitlist(ctx, f.teamEvent.id),
        () => api.getEventTypeWaitlistSummary(ctx, f.teamEvent.id),
        () => api.setEventTypeWaitlist(ctx, f.teamEvent.id, { enabled: true }),
      ])
        await expect(method()).rejects.toMatchObject({
          code: expect.stringMatching(/insufficient_role|not_found/),
        })
    }
    await expect(api.getEventTypeWaitlist(f.foreign, f.personalEvent.id)).rejects.toMatchObject({
      code: 'event_type_not_found',
    })
    for (const ctx of [f.teamOwner, f.teamAdmin]) {
      expect(await api.setEventTypeWaitlist(ctx, f.teamEvent.id, { enabled: true })).toEqual({
        enabled: true,
      })
      expect(await api.getEventTypeWaitlist(ctx, f.teamEvent.id)).toEqual({ enabled: true })
      expect(await api.getEventTypeWaitlistSummary(ctx, f.teamEvent.id)).toEqual({
        pending: 0,
        active: 0,
        notified: 0,
        suppressed: 0,
        failed: 0,
      })
    }
  }

  async function assertStrict(api: Settings) {
    const f = await fixture()
    for (const input of [
      null,
      {},
      { enabled: 'false' },
      { enabled: true, extra: true },
      { enabled: null },
    ])
      await expect(
        api.setEventTypeWaitlist(f.personal, f.personalEvent.id, input),
      ).rejects.toMatchObject({ name: 'ZodError' })
    expect(await api.getEventTypeWaitlist(f.personal, f.personalEvent.id)).toEqual({
      enabled: false,
    })
  }

  async function assertUnsupported(api: Settings) {
    const f = await fixture()
    const collective = await events.createEventType(f.teamOwner, {
      slug: 'collective',
      title: 'Collective',
      durationMinutes: 30,
      schedulingType: 'collective',
      hosts: [{ userId: f.owner.id }, { userId: f.admin.id }],
    })
    const robin = await events.createEventType(f.teamOwner, {
      slug: 'robin',
      title: 'Robin',
      durationMinutes: 30,
      schedulingType: 'round_robin',
      hosts: [{ userId: f.owner.id }],
    })
    for (const event of [collective, robin])
      await expect(
        api.setEventTypeWaitlist(f.teamOwner, event.id, { enabled: true }),
      ).rejects.toMatchObject({ code: 'waitlist_unsupported' })
    await db.deleteFrom('event_type_hosts').where('event_type_id', '=', f.teamEvent.id).execute()
    await expect(
      api.setEventTypeWaitlist(f.teamOwner, f.teamEvent.id, { enabled: true }),
    ).rejects.toMatchObject({ code: 'waitlist_unsupported' })
    const unavailable = await events.createEventType(f.teamOwner, {
      slug: 'unverified-host',
      title: 'Unverified host',
      durationMinutes: 30,
      hosts: [{ userId: f.member.id }],
    })
    await db
      .updateTable('auth.user')
      .set({ emailVerified: false })
      .where('id', '=', f.member.id)
      .execute()
    await expect(
      api.setEventTypeWaitlist(f.teamOwner, unavailable.id, { enabled: true }),
    ).rejects.toMatchObject({ code: 'waitlist_unsupported' })
  }

  it('restricts settings and summaries to the personal owner or team owner/admin', async () => {
    await assertRoles(events)
  })
  it('accepts only an exact boolean settings object', async () => {
    await assertStrict(events)
  })
  it('rejects collective, round-robin and missing hosts', async () => {
    await assertUnsupported(events)
  })

  it('keeps ordinary edits enabled and exposes contact-free aggregates; disable atomically erases and revokes without resurrection', async () => {
    const f = await fixture()
    expect(await events.getEventTypeWaitlist(f.personal, f.personalEvent.id)).toEqual({
      enabled: false,
    })
    await events.setEventTypeWaitlist(f.personal, f.personalEvent.id, { enabled: true })
    await events.updateEventType(f.personal, f.personalEvent.id, {
      title: 'Changed title',
      durationMinutes: 45,
    })
    expect(await events.getEventTypeWaitlist(f.personal, f.personalEvent.id)).toEqual({
      enabled: true,
    })
    const entry = (
      await owned.pool.query<{ id: string }>(
        `INSERT INTO waitlist_entries(organization_id,event_type_id,recipient_hash,email,name,window_start,window_end,time_zone,locale,consent_version,consented_at,expires_at,pending_expires_at)
      VALUES($1,$2,decode(repeat('11',32),'hex'),'private@example.test','Private name',now()+interval '1 day',now()+interval '5 days','Europe/Berlin','de','1',now(),now()+interval '5 days',now()+interval '24 hours') RETURNING id`,
        [f.owner.principal.organization.id, f.personalEvent.id],
      )
    ).rows[0]?.id as string
    await owned.pool.query(
      `INSERT INTO waitlist_capabilities(entry_id,purpose,token_hash,expires_at) SELECT id,'management',decode(repeat('22',32),'hex'),expires_at FROM waitlist_entries WHERE id=$1`,
      [entry],
    )
    expect(await events.getEventTypeWaitlistSummary(f.personal, f.personalEvent.id)).toEqual({
      pending: 1,
      active: 0,
      notified: 0,
      suppressed: 0,
      failed: 0,
    })
    await events.setEventTypeWaitlist(f.personal, f.personalEvent.id, { enabled: false })
    expect(
      (
        await owned.pool.query(
          'SELECT status,email,name,window_start,window_end,time_zone,locale FROM waitlist_entries WHERE id=$1',
          [entry],
        )
      ).rows,
    ).toEqual([
      {
        status: 'removed',
        email: null,
        name: null,
        window_start: null,
        window_end: null,
        time_zone: null,
        locale: null,
      },
    ])
    expect(
      (
        await owned.pool.query(
          'SELECT revoked_at IS NOT NULL AS revoked FROM waitlist_capabilities WHERE entry_id=$1',
          [entry],
        )
      ).rows,
    ).toEqual([{ revoked: true }])
    await events.setEventTypeWaitlist(f.personal, f.personalEvent.id, { enabled: true })
    expect(await events.getEventTypeWaitlistSummary(f.personal, f.personalEvent.id)).toEqual({
      pending: 0,
      active: 0,
      notified: 0,
      suppressed: 0,
      failed: 0,
    })
    expect(
      (await owned.pool.query('SELECT status FROM waitlist_entries WHERE id=$1', [entry])).rows,
    ).toEqual([{ status: 'removed' }])
  })

  it('retires entries when the actual host or scheduling mode changes', async () => {
    const f = await fixture()
    const insert = async (hash: string) =>
      (
        await owned.pool.query<{ id: string }>(
          `
      INSERT INTO waitlist_entries(organization_id,event_type_id,recipient_hash,email,window_start,window_end,
        time_zone,locale,consent_version,consented_at,expires_at,pending_expires_at)
      VALUES($1,$2,decode(repeat($3,32),'hex'),'invitee@example.test',now()+interval '1 day',now()+interval '5 days',
        'Europe/Berlin','de','1',now(),now()+interval '5 days',now()+interval '24 hours') RETURNING id`,
          [f.team.id, f.teamEvent.id, hash],
        )
      ).rows[0]?.id as string
    await events.setEventTypeWaitlist(f.teamOwner, f.teamEvent.id, { enabled: true })
    const first = await insert('aa')
    await events.updateEventType(f.teamOwner, f.teamEvent.id, { hosts: [{ userId: f.admin.id }] })
    expect(
      (
        await owned.pool.query(
          'SELECT status,email,terminal_reason FROM waitlist_entries WHERE id=$1',
          [first],
        )
      ).rows,
    ).toEqual([{ status: 'removed', email: null, terminal_reason: 'configuration_changed' }])
    expect(await events.getEventTypeWaitlist(f.teamOwner, f.teamEvent.id)).toEqual({
      enabled: true,
    })
    await events.setEventTypeWaitlist(f.teamOwner, f.teamEvent.id, { enabled: true })
    const second = await insert('bb')
    await events.updateEventType(f.teamOwner, f.teamEvent.id, {
      schedulingType: 'round_robin',
      hosts: [{ userId: f.admin.id }],
    })
    expect(
      (
        await owned.pool.query(
          'SELECT status,email,terminal_reason FROM waitlist_entries WHERE id=$1',
          [second],
        )
      ).rows,
    ).toEqual([{ status: 'removed', email: null, terminal_reason: 'configuration_changed' }])
    expect(await events.getEventTypeWaitlist(f.teamOwner, f.teamEvent.id)).toEqual({
      enabled: false,
    })
  })

  async function assertRoundTrip(api: Settings) {
    const f = await fixture()
    const enabled = await api.createEventType(f.personal, {
      slug: 'enabled',
      title: 'Enabled',
      durationMinutes: 30,
      waitlist: { enabled: true },
    })
    expect(enabled.waitlist).toEqual({ enabled: true })
    expect(
      (await api.updateEventType(f.personal, enabled.id, { title: 'Rename' })).waitlist,
    ).toEqual({ enabled: true })
    expect(
      (await api.updateEventType(f.personal, enabled.id, { waitlist: { enabled: false } }))
        .waitlist,
    ).toEqual({ enabled: false })
    expect(
      (await api.updateEventType(f.personal, enabled.id, { waitlist: { enabled: true } })).waitlist,
    ).toEqual({ enabled: true })
    await expect(
      events.updateEventType(f.teamOwner, f.teamEvent.id, {
        schedulingType: 'round_robin',
        hosts: [{ userId: f.owner.id }],
        waitlist: { enabled: true },
      }),
    ).rejects.toMatchObject({ code: 'waitlist_unsupported' })
    expect((await api.getEventType(f.teamOwner, f.teamEvent.id)).schedulingType).toBe('individual')
  }
  it('round-trips creation and baseline-only PATCH without replacing saved waitlist settings', async () => {
    await assertRoundTrip(events)
  })
  it.each([
    [
      'create',
      'if (waitlist) await writeWaitlistSettings(trx, await loadEventType(trx, id), waitlist)',
    ],
    [
      'PATCH',
      'if (waitlist) await writeWaitlistSettings(trx, await loadEventType(trx, row.id), waitlist)',
    ],
  ])('detects source-copy omission of %s waitlist settings', async (_name, anchor) => {
    const copy = await sourceCopy([anchor as string, ''])
    await expectKilled(copy, assertRoundTrip)
  })

  async function assertEntries(api: Settings) {
    const f = await fixture()
    const createdAt = new Date()
    const windowEnd = new Date(createdAt.getTime() + 5 * 86400000)
    const entry = (
      await db
        .insertInto('waitlist_entries')
        .values({
          organization_id: f.team.id,
          event_type_id: f.teamEvent.id,
          recipient_hash: Buffer.alloc(32, 7),
          email: 'private-list@example.test',
          name: 'Private list',
          window_start: new Date(Date.now() + 86400000),
          window_end: windowEnd,
          created_at: createdAt,
          time_zone: 'Europe/Berlin',
          locale: 'de',
          consent_version: 'waitlist-v1',
          consented_at: new Date(),
          expires_at: windowEnd,
          pending_expires_at: new Date(createdAt.getTime() + 86400000),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id
    for (const ctx of [f.teamMember, f.foreign]) {
      await expect(api.listEventTypeWaitlistEntries(ctx, f.teamEvent.id)).rejects.toMatchObject({
        code: expect.stringMatching(/insufficient_role|not_found/),
      })
      await expect(
        api.removeEventTypeWaitlistEntry(ctx, f.teamEvent.id, entry),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/insufficient_role|not_found/),
      })
    }
    for (const ctx of [f.teamOwner, f.teamAdmin]) {
      const page = await api.listEventTypeWaitlistEntries(ctx, f.teamEvent.id, { limit: 1 })
      expect(page.data).toHaveLength(1)
      expect(page.data[0]).toMatchObject({
        id: entry,
        state: 'pending_verification',
        email: 'private-list@example.test',
        name: 'Private list',
        preferredWindow: { timeZone: 'Europe/Berlin' },
        lastNotifiedAt: null,
      })
      expect(Object.keys(page.data[0] ?? {}).sort()).toEqual([
        'createdAt',
        'email',
        'id',
        'lastNotifiedAt',
        'name',
        'preferredWindow',
        'state',
      ])
    }
    await expect(
      api.removeEventTypeWaitlistEntry(f.personal, f.personalEvent.id, entry),
    ).rejects.toMatchObject({ code: 'waitlist_entry_not_found' })
    for (let i = 0; i < 2; i++)
      expect(await api.removeEventTypeWaitlistEntry(f.teamAdmin, f.teamEvent.id, entry)).toEqual({
        removed: true,
      })
    expect(
      (await api.listEventTypeWaitlistEntries(f.teamOwner, f.teamEvent.id)).data[0],
    ).toMatchObject({
      id: entry,
      state: 'removed',
      email: null,
      name: null,
      preferredWindow: null,
    })
    expect(
      await db
        .selectFrom('waitlist_verification_outbox')
        .select('id')
        .where('entry_id', '=', entry)
        .execute(),
    ).toEqual([])
  }
  it('restricts entry contacts and removal to managers, erases contacts and removes idempotently without mail', async () => {
    await assertEntries(events)
  })
  it('pages all lifecycle states with preserved windows and the latest accepted notification time', async () => {
    const f = await fixture()
    const createdAt = new Date()
    const windowEnd = new Date(createdAt.getTime() + 5 * 86400000)
    const states = [
      'pending_verification',
      'active',
      'notified',
      'booked',
      'removed',
      'expired',
    ] as const
    const entries = await db
      .insertInto('waitlist_entries')
      .values(
        states.map((status, index) => ({
          organization_id: f.team.id,
          event_type_id: f.teamEvent.id,
          recipient_hash: Buffer.alloc(32, index + 40),
          email: status === 'removed' ? null : `state-${index}@example.test`,
          name: null,
          window_start: status === 'removed' ? null : new Date(createdAt.getTime() + 86400000),
          window_end: status === 'removed' ? null : windowEnd,
          time_zone: status === 'removed' ? null : 'UTC',
          locale: status === 'removed' ? null : 'en',
          consent_version: 'waitlist-v1',
          consented_at: createdAt,
          created_at: createdAt,
          expires_at: windowEnd,
          pending_expires_at: new Date(createdAt.getTime() + 86400000),
          status,
          verified_at: ['active', 'notified', 'booked'].includes(status) ? createdAt : null,
          terminal_at: ['booked', 'removed', 'expired'].includes(status) ? createdAt : null,
        })),
      )
      .returning(['id', 'status'])
      .execute()
    const notified = entries.find((entry) => entry.status === 'notified')
    if (!notified) throw new Error('Expected notified entry')
    const cohort = await db
      .insertInto('waitlist_cohorts')
      .values({ event_type_id: f.teamEvent.id })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('waitlist_candidates')
      .values({
        cohort_id: cohort.id,
        entry_id: notified.id,
        event_type_id: f.teamEvent.id,
        slots: JSON.stringify([
          {
            start: new Date(createdAt.getTime() + 86400000).toISOString(),
            end: new Date(createdAt.getTime() + 88200000).toISOString(),
          },
        ]),
        due_at: createdAt,
        expires_at: new Date(createdAt.getTime() + 3600000),
        state: 'accepted',
        accepted_at: createdAt,
      })
      .execute()
    let after: string | undefined
    const listed = []
    do {
      const page = await events.listEventTypeWaitlistEntries(f.teamOwner, f.teamEvent.id, {
        limit: 2,
        after,
      })
      expect(page.data).toHaveLength(2)
      listed.push(...page.data)
      after = page.nextAfter ?? undefined
    } while (after)
    expect(listed.map((entry) => entry.state).sort()).toEqual([...states].sort())
    expect(new Set(listed.map((entry) => entry.id)).size).toBe(6)
    expect(listed.find((entry) => entry.id === notified.id)?.lastNotifiedAt).toBe(
      createdAt.toISOString(),
    )
    expect(listed.find((entry) => entry.state === 'removed')).toMatchObject({
      email: null,
      preferredWindow: null,
    })
  })

  it('detects source-copy bypass of manager entry access', async () => {
    const copy = await sourceCopy([
      'else if (!current.canManageTeam) throw insufficientRole()',
      'else if (false) throw insufficientRole()',
    ])
    await expectKilled(copy, assertEntries)
  })
  it('detects source-copy omission of host removal', async () => {
    const copy = await sourceCopy([
      "if (['pending_verification', 'active', 'notified'].includes(entry.status))",
      'if (false)',
    ])
    await expectKilled(copy, assertEntries)
  })

  it.each([
    [
      'team permission',
      'else if (!current.canManageTeam) throw insufficientRole()',
      'else if (false) throw insufficientRole()',
      assertRoles,
    ],
    [
      'strict shape',
      'WaitlistSettingsSchema = z.strictObject(',
      'WaitlistSettingsSchema = z.object(',
      assertStrict,
    ],
    ['supported mode', "row.scheduling_type !== 'individual' ||", 'false ||', assertUnsupported],
  ] as const)('detects source-copy removal of %s', async (_name, before, after, assertion) => {
    const copy = await sourceCopy([before, after])
    await expectKilled(copy, assertion)
  })
})
