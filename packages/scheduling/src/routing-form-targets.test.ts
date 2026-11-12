import { randomUUID } from 'node:crypto'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Question } from './questions.ts'
import {
  type RoutingFormConfig,
  RoutingValidationError,
  validateRoutingFormConfig,
} from './routing-form-config.ts'
import {
  checkRoutingTargets,
  loadRoutingTargetEvents,
  type RoutingTargetEvent,
  routingMappingProblem,
  routingTargetProblem,
  validateRoutingTargets,
} from './routing-form-targets.ts'
import { createFixtures } from './testing.ts'

const uuid = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`
const Q = { company: uuid(1), email: uuid(2), size: uuid(3) }
const O = { small: uuid(11), large: uuid(12) }
const ORG = uuid(100)
const OTHER_ORG = uuid(101)
const USER = uuid(102)
const OTHER_USER = uuid(103)
const EVENT = uuid(104)

const routingQuestions = [
  { id: Q.company, type: 'short_text', label: 'Company' },
  { id: Q.email, type: 'email', label: 'Work email' },
  {
    id: Q.size,
    type: 'select',
    label: 'Company size',
    options: [
      { id: O.small, label: '1–10' },
      { id: O.large, label: '200+' },
    ],
  },
]
const bookingQuestions: Question[] = [
  { id: 'company', label: 'Company', type: 'short_text', required: false },
  { id: 'notes', label: 'Notes', type: 'long_text', required: false },
  { id: 'phone', label: 'Phone', type: 'phone', required: false },
  { id: 'size', label: 'Size', type: 'select', required: true, options: ['Small', 'Large'] },
  { id: 'topics', label: 'Topics', type: 'multi_select', required: false, options: ['Small'] },
  { id: 'consent', label: 'Consent', type: 'checkbox', required: false },
]
const crosswalk = { [O.small]: 'Small', [O.large]: 'Large' }

/** A validated version whose first rule and fallback both route to `eventTypeId`. */
function version(eventTypeId: string, mappings: unknown[] = []): RoutingFormConfig {
  return validateRoutingFormConfig({
    questions: routingQuestions,
    rules: [
      {
        id: uuid(21),
        conditions: [{ questionId: Q.size, operator: 'equals', value: O.large }],
        target: { kind: 'event', eventTypeId, mappings },
      },
    ],
    fallback: { kind: 'message', message: 'Thank you' },
  })
}
const sources = version(EVENT).questions
const source = (id: string) => sources.find((q) => q.id === id) as (typeof sources)[number]

function personalEvent(overrides: Partial<RoutingTargetEvent> = {}): RoutingTargetEvent {
  return {
    id: EVENT,
    organizationId: ORG,
    ownerUserId: USER,
    personalUserId: USER,
    active: true,
    deleted: false,
    bookingMode: 'individual',
    schedulingType: 'individual',
    payment: 'none',
    questions: bookingQuestions,
    ...overrides,
  }
}
const teamEvent = (overrides: Partial<RoutingTargetEvent> = {}) =>
  personalEvent({ ownerUserId: null, personalUserId: null, ...overrides })

function rejectsTarget(fn: () => unknown, field: string, reason: string) {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(RoutingValidationError)
  expect(thrown).toMatchObject({ kind: 'invalid', code: 'invalid_routing_target', field, reason })
}

describe('routing target eligibility allowlist', () => {
  it('accepts per-member personal and single-host team events in the same organization', () => {
    expect(routingTargetProblem(ORG, personalEvent())).toBeUndefined()
    expect(routingTargetProblem(ORG, teamEvent())).toBeUndefined()
  })

  it('keeps the team host modes routing targets as a whole', () => {
    for (const schedulingType of ['round_robin', 'collective'])
      expect(routingTargetProblem(ORG, teamEvent({ schedulingType }))).toBeUndefined()
  })

  it('reports another organization’s event exactly like a missing one', () => {
    expect(routingTargetProblem(ORG, undefined)).toBe('not_found')
    expect(routingTargetProblem(ORG, personalEvent({ organizationId: OTHER_ORG }))).toBe(
      'not_found',
    )
    expect(routingTargetProblem(ORG, teamEvent({ organizationId: OTHER_ORG }))).toBe('not_found')
    expect(routingTargetProblem(OTHER_ORG, personalEvent())).toBe('not_found')
    // No state of a foreign event shows through: an ineligible one reports what a missing one does.
    const missing = routingTargetProblem(ORG, undefined)
    for (const state of [
      { deleted: true },
      { active: false },
      { bookingMode: 'group' },
      { bookingMode: 'auction' },
      { schedulingType: 'managed' },
      { payment: 'required' },
      { deleted: true, active: false, bookingMode: 'group', payment: 'required' },
    ])
      for (const event of [personalEvent(state), teamEvent(state)])
        expect(routingTargetProblem(ORG, { ...event, organizationId: OTHER_ORG })).toBe(missing)
  })

  it('requires the ownership an organization’s pages have', () => {
    for (const event of [
      personalEvent({ ownerUserId: OTHER_USER }),
      personalEvent({ ownerUserId: null }),
      teamEvent({ ownerUserId: USER }),
    ])
      expect(routingTargetProblem(ORG, event)).toBe('not_found')
  })

  it('rejects deleted and disabled events', () => {
    expect(routingTargetProblem(ORG, personalEvent({ deleted: true }))).toBe('deleted')
    expect(routingTargetProblem(ORG, personalEvent({ active: false }))).toBe('disabled')
  })

  it('rejects group-mode events', () => {
    expect(routingTargetProblem(ORG, personalEvent({ bookingMode: 'group' }))).toBe('group_booking')
    expect(routingTargetProblem(ORG, teamEvent({ bookingMode: 'group' }))).toBe('group_booking')
  })

  it.each(['auction', 'seated', '', 'Individual', 'INDIVIDUAL', 'individual ', 'group '])(
    'fails closed on the unknown booking mode %j',
    (bookingMode) => {
      expect(routingTargetProblem(ORG, personalEvent({ bookingMode }))).toBe('unsupported_mode')
    },
  )

  it.each(['pool', 'round-robin', 'managed', '', 'Individual'])(
    'fails closed on the unknown host mode %j',
    (schedulingType) => {
      expect(routingTargetProblem(ORG, teamEvent({ schedulingType }))).toBe('unsupported_mode')
    },
  )

  it.each(['required', 'deposit', 'per_duration', '', 'None'])(
    'rejects the synthetic payment requirement %j',
    (payment) => {
      expect(routingTargetProblem(ORG, personalEvent({ payment }))).toBe('payment_required')
      expect(routingTargetProblem(ORG, teamEvent({ payment }))).toBe('payment_required')
    },
  )
})

describe('routing target validation', () => {
  const events = (event: RoutingTargetEvent) => new Map([[event.id, event]])

  it('accepts eligible targets and skips message targets', () => {
    expect(() => validateRoutingTargets(ORG, version(EVENT), events(personalEvent()))).not.toThrow()
    expect(() => validateRoutingTargets(ORG, version(EVENT), events(teamEvent()))).not.toThrow()
    const messagesOnly = validateRoutingFormConfig({
      questions: [],
      rules: [],
      fallback: { kind: 'message', message: 'Thanks' },
    })
    expect(() => validateRoutingTargets(ORG, messagesOnly, new Map())).not.toThrow()
  })

  it.each([
    ['cross-organization', personalEvent({ organizationId: OTHER_ORG }), 'not_found'],
    ['deleted', personalEvent({ deleted: true }), 'deleted'],
    ['disabled', personalEvent({ active: false }), 'disabled'],
    ['group-mode', teamEvent({ bookingMode: 'group' }), 'group_booking'],
    ['unknown-mode', teamEvent({ bookingMode: 'auction' }), 'unsupported_mode'],
    ['payment-requiring', personalEvent({ payment: 'required' }), 'payment_required'],
  ])('rejects a %s target with invalid_routing_target', (_, event, reason) => {
    rejectsTarget(
      () => validateRoutingTargets(ORG, version(EVENT), events(event)),
      'rules.0.target',
      reason,
    )
  })

  it('checks the fallback target too', () => {
    const config = validateRoutingFormConfig({
      questions: [],
      rules: [],
      fallback: { kind: 'event', eventTypeId: EVENT },
    })
    rejectsTarget(
      () => validateRoutingTargets(ORG, config, events(teamEvent({ bookingMode: 'group' }))),
      'fallback',
      'group_booking',
    )
    rejectsTarget(
      () => validateRoutingTargets(ORG, config, events(personalEvent({ payment: 'required' }))),
      'fallback',
      'payment_required',
    )
    rejectsTarget(() => validateRoutingTargets(ORG, config, new Map()), 'fallback', 'not_found')
  })

  it('rejects a cross-organization target even when its mappings would fit', () => {
    const config = version(EVENT, [
      { questionId: Q.company, destination: { kind: 'question', questionId: 'company' } },
    ])
    expect(() => validateRoutingTargets(ORG, config, events(personalEvent()))).not.toThrow()
    rejectsTarget(
      () => validateRoutingTargets(OTHER_ORG, config, events(personalEvent())),
      'rules.0.target',
      'not_found',
    )
  })
})

describe('routing answer mapping compatibility', () => {
  const destinations = [
    { kind: 'inviteeName' },
    { kind: 'inviteeEmail' },
    ...bookingQuestions.map((q) => ({ kind: 'question' as const, questionId: q.id })),
  ] as const
  // Each source's compatible destinations; every other pairing is refused.
  const compatible: Record<string, string[]> = {
    [Q.company]: ['inviteeName', 'company', 'notes'],
    [Q.email]: ['inviteeEmail', 'company', 'notes'],
    [Q.size]: ['size'],
  }
  const pairs = Object.entries(compatible).flatMap(([questionId, allowed]) =>
    destinations.map((destination) => {
      const name = destination.kind === 'question' ? destination.questionId : destination.kind
      return [
        source(questionId).type,
        name,
        questionId,
        destination,
        allowed.includes(name),
      ] as const
    }),
  )

  it.each(pairs)('maps %s to %s only when compatible', (_, __, questionId, destination, ok) => {
    const mapping = {
      questionId,
      destination,
      ...(questionId === Q.size && { options: crosswalk }),
    }
    const problem = routingMappingProblem(source(questionId), mapping, bookingQuestions)
    expect(problem).toBe(ok ? undefined : 'incompatible_mapping')
    const check = () =>
      validateRoutingTargets(ORG, version(EVENT, [mapping]), new Map([[EVENT, personalEvent()]]))
    if (ok) expect(check).not.toThrow()
    else rejectsTarget(check, 'rules.0.target.mappings.0', 'incompatible_mapping')
  })

  it('rejects a destination question the event does not ask', () => {
    for (const questionId of ['missing', 'Company'])
      rejectsTarget(
        () =>
          validateRoutingTargets(
            ORG,
            version(EVENT, [
              { questionId: Q.company, destination: { kind: 'question', questionId } },
            ]),
            new Map([[EVENT, personalEvent()]]),
          ),
        'rules.0.target.mappings.0',
        'unknown_destination',
      )
  })

  it('rejects a crosswalk value that is not a current option of the destination', () => {
    const mapping = {
      questionId: Q.size,
      destination: { kind: 'question', questionId: 'size' },
      options: crosswalk,
    }
    const check = (options: string[]) => () =>
      validateRoutingTargets(
        ORG,
        version(EVENT, [mapping]),
        new Map([
          [
            EVENT,
            personalEvent({
              questions: bookingQuestions.map((q) => (q.id === 'size' ? { ...q, options } : q)),
            }),
          ],
        ]),
      )
    expect(check(['Small', 'Large', 'Medium'])).not.toThrow()
    rejectsTarget(check(['Small', 'Medium']), 'rules.0.target.mappings.0', 'incompatible_options')
    rejectsTarget(check(['small', 'large']), 'rules.0.target.mappings.0', 'incompatible_options')
  })
})

const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('routing targets in stored event types', () => {
  let owned: TestDatabase
  let db: Db
  let f: ReturnType<typeof createFixtures>
  let alice: { userId: string; organizationId: string }
  let bob: { userId: string; organizationId: string }
  let team: string
  let otherTeam: string
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    f = createFixtures(db)
    alice = await f.host()
    bob = await f.host()
    team = await f.organization()
    otherTeam = await f.organization()
    await f.member(alice.userId, team, 'owner')
    await f.member(bob.userId, team, 'member')
    await f.member(bob.userId, otherTeam, 'owner')
  })
  afterAll(async () => {
    await owned?.drop()
  })

  const set = (id: string, change: Record<string, unknown>) =>
    db.updateTable('event_types').set(change).where('id', '=', id).execute()
  async function reason(organizationId: string, eventTypeId: string, mappings: unknown[] = []) {
    try {
      await checkRoutingTargets(db, organizationId, version(eventTypeId, mappings))
      return undefined
    } catch (error) {
      expect(error).toBeInstanceOf(RoutingValidationError)
      const { code, field, reason } = error as RoutingValidationError
      expect(code).toBe('invalid_routing_target')
      expect(field).toBe(mappings.length ? 'rules.0.target.mappings.0' : 'rules.0.target')
      return reason
    }
  }

  it('projects a stored personal event for eligibility and mappings', async () => {
    const event = await f.eventType(alice.organizationId, alice.userId, {
      questions: bookingQuestions,
    })
    const loaded = await loadRoutingTargetEvents(db, [event, event, 'not-a-uuid', uuid(999)])
    expect([...loaded.keys()]).toEqual([event])
    expect(loaded.get(event)).toEqual({
      id: event,
      organizationId: alice.organizationId,
      ownerUserId: alice.userId,
      personalUserId: alice.userId,
      active: true,
      deleted: false,
      bookingMode: 'individual',
      schedulingType: 'individual',
      payment: 'none',
      questions: bookingQuestions,
    })
    expect(await loadRoutingTargetEvents(db, [])).toEqual(new Map())
  })

  it('accepts listed and hidden per-member personal events in their personal organization', async () => {
    const listed = await f.eventType(alice.organizationId, alice.userId)
    const hidden = await f.eventType(alice.organizationId, alice.userId)
    await set(hidden, { is_hidden: true })
    expect(await reason(alice.organizationId, listed)).toBeUndefined()
    expect(await reason(alice.organizationId, hidden)).toBeUndefined()
  })

  it('accepts single-host, round-robin and collective team events in their team', async () => {
    const single = await f.eventType(team, null, { hosts: [{ userId: bob.userId }] })
    const hidden = await f.eventType(team, null, { hosts: [{ userId: alice.userId }] })
    await set(hidden, { is_hidden: true })
    const pool = await f.eventType(team, null, {
      hosts: [{ userId: alice.userId }, { userId: bob.userId }],
    })
    await set(pool, { scheduling_type: 'round_robin' })
    const collective = await f.eventType(team, null, {
      hosts: [{ userId: alice.userId }, { userId: bob.userId }],
    })
    await set(collective, { scheduling_type: 'collective' })
    for (const event of [single, hidden, pool, collective])
      expect(await reason(team, event)).toBeUndefined()
  })

  it('rejects other organizations’ events, even of the same member, like missing ones', async () => {
    const bobs = await f.eventType(bob.organizationId, bob.userId)
    const teams = await f.eventType(team, null, { hosts: [{ userId: alice.userId }] })
    const others = await f.eventType(otherTeam, null, { hosts: [{ userId: bob.userId }] })
    const alices = await f.eventType(alice.organizationId, alice.userId)
    expect(await reason(alice.organizationId, bobs)).toBe('not_found')
    expect(await reason(alice.organizationId, teams)).toBe('not_found')
    expect(await reason(team, others)).toBe('not_found')
    expect(await reason(team, alices)).toBe('not_found')
    expect(await reason(team, randomUUID())).toBe('not_found')
    // Rows no service writes: a personal organization's event owned by someone else, and a
    // team event with an owner.
    const misowned = await f.eventType(alice.organizationId, bob.userId)
    const ownedTeamEvent = await f.eventType(team, alice.userId)
    expect(await reason(alice.organizationId, misowned)).toBe('not_found')
    expect(await reason(team, ownedTeamEvent)).toBe('not_found')
  })

  it('rejects deleted, disabled and group-mode events', async () => {
    const deleted = await f.eventType(alice.organizationId, alice.userId, {
      deletedAt: '2026-11-01T00:00:00Z',
    })
    const disabled = await f.eventType(alice.organizationId, alice.userId, { isActive: false })
    const personalGroup = await f.eventType(alice.organizationId, alice.userId)
    await set(personalGroup, { booking_mode: 'group', group_capacity: 5 })
    const teamGroup = await f.eventType(team, null, { hosts: [{ userId: bob.userId }] })
    await set(teamGroup, { booking_mode: 'group', group_capacity: 2 })
    expect(await reason(alice.organizationId, deleted)).toBe('deleted')
    expect(await reason(alice.organizationId, disabled)).toBe('disabled')
    expect(await reason(alice.organizationId, personalGroup)).toBe('group_booking')
    expect(await reason(team, teamGroup)).toBe('group_booking')
    // From another organization each of them reports exactly like a missing event.
    for (const event of [deleted, disabled, personalGroup])
      expect(await reason(team, event)).toBe('not_found')
    expect(await reason(alice.organizationId, teamGroup)).toBe('not_found')
  })

  it('fails closed on modes the schema does not allow today', async () => {
    const event = await f.eventType(team, null, { hosts: [{ userId: bob.userId }] })
    class Rollback extends Error {}
    // Only inside this rolled-back transaction of a throwaway database: drop the mode checks
    // a later migration might widen, and store modes routing has never seen.
    await expect(
      db.transaction().execute(async (trx) => {
        await sql`ALTER TABLE event_types
          DROP CONSTRAINT event_types_booking_mode,
          DROP CONSTRAINT event_types_group_capacity,
          DROP CONSTRAINT event_types_scheduling_type_check`.execute(trx)
        await trx
          .updateTable('event_types')
          .set({ booking_mode: 'auction' })
          .where('id', '=', event)
          .execute()
        const config = version(event)
        const check = () => checkRoutingTargets(trx, team, config)
        await expect(check()).rejects.toMatchObject({ reason: 'unsupported_mode' })
        await trx
          .updateTable('event_types')
          .set({ booking_mode: 'individual', scheduling_type: 'managed' })
          .where('id', '=', event)
          .execute()
        await expect(check()).rejects.toMatchObject({ reason: 'unsupported_mode' })
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)
    expect(await reason(team, event)).toBeUndefined()
  })

  it('validates mappings against the event’s current stored booking form', async () => {
    const event = await f.eventType(alice.organizationId, alice.userId, {
      questions: bookingQuestions,
    })
    const mappings = [
      { questionId: Q.company, destination: { kind: 'inviteeName' } },
      { questionId: Q.email, destination: { kind: 'inviteeEmail' } },
      { questionId: Q.company, destination: { kind: 'question', questionId: 'company' } },
      { questionId: Q.email, destination: { kind: 'question', questionId: 'notes' } },
      {
        questionId: Q.size,
        destination: { kind: 'question', questionId: 'size' },
        options: crosswalk,
      },
    ]
    expect(await reason(alice.organizationId, event, mappings)).toBeUndefined()
    const store = (questions: Question[]) => set(event, { questions: JSON.stringify(questions) })
    const mapped = (mapping: unknown) => reason(alice.organizationId, event, [mapping])
    const size = mappings[4]
    await store(bookingQuestions.filter((q) => q.id !== 'size'))
    expect(await mapped(size)).toBe('unknown_destination')
    await store(
      bookingQuestions.map((q) => (q.id === 'size' ? { ...q, options: ['Small', 'Medium'] } : q)),
    )
    expect(await mapped(size)).toBe('incompatible_options')
    await store(
      bookingQuestions.map((q) =>
        q.id === 'company'
          ? { id: 'company', label: 'Company', type: 'phone', required: false }
          : q,
      ),
    )
    expect(await mapped(mappings[2])).toBe('incompatible_mapping')
  })
})
