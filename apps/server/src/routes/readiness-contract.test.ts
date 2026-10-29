import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createRoute, z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import {
  getSelfReadiness,
  getTeamReadiness,
  SelfReadinessPageSchema,
  TeamReadinessPageSchema,
} from '@hourmere/scheduling'
import { DomainError } from '@hourmere/scheduling/errors'
import { createFixtures, createTestTeam, createTestUser } from '@hourmere/scheduling/testing'
import { createMiddleware } from 'hono/factory'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ErrorBody, errorResponses, json, serviceContext } from '../openapi.ts'
import { teamManagementAccess } from '../team-management.ts'
import { readinessRoutes } from './readiness.ts'
import {
  createTestApp,
  openApiDocument,
  productApp,
  resolve,
  responseAndRequestStrictness,
  syntheticSessionCookie,
  type TestApp,
} from './test-app.ts'

// Deliberately independent of the published, additive response schemas. Every object
// boundary is closed here so a new private field cannot silently pass a leak test.
const summary = z.enum([
  'disabled',
  'needs_activation',
  'configuration_blocked',
  'dependency_unavailable',
  'check_failed',
  'not_checked',
  'checks_passed',
  'partial_pool',
])
const completeness = z.enum(['complete', 'partial'])
const enablement = z.enum(['enabled', 'disabled', 'not_applicable', 'not_checked', 'check_failed'])
const activation = z.enum(['active', 'inactive', 'not_applicable', 'not_checked', 'check_failed'])
const states = [
  'satisfied',
  'not_applicable',
  'configuration_blocker',
  'dependency_unavailable',
  'not_checked',
  'check_failed',
] as const
const signal = z.strictObject({
  id: z.enum([
    'default_schedule',
    'effective_event_schedule',
    'host_eligibility',
    'round_robin_activation',
    'conflict_calendar_selection',
    'selected_calendar_sync',
    'optional_conference_dependency',
    'slot_observation',
  ]),
  state: z.enum(states),
  reasonCode: z.string().nullable(),
  checkedAt: z.iso.datetime().nullable(),
  ownerKind: z.enum([
    'member_self',
    'event_owner',
    'team_admin',
    'calendar_worker',
    'shared_evaluator',
    'operator',
  ]),
  fixKind: z
    .enum([
      'event_editor',
      'self_availability',
      'self_schedule',
      'self_calendars',
      'self_identity',
      'self_profile',
      'self_conferences',
      'ask_member',
      'retry_summary',
    ])
    .nullable(),
})
const detail = z.strictObject({
  subject: z.strictObject({
    kind: z.enum(['member', 'event_type']),
    id: z.uuid(),
    organizationId: z.uuid(),
  }),
  audience: z.literal('self_detail'),
  enablement,
  activation,
  evaluatedAt: z.iso.datetime(),
  scope: z.literal('configuration_and_cached_sync'),
  signals: z.array(signal),
  summary,
  availability: z.literal('not_checked'),
  completeness,
  details: z.strictObject({
    schedules: z.array(
      z.strictObject({
        id: z.uuid(),
        name: z.string(),
        timeZone: z.string(),
        isDefault: z.boolean(),
      }),
    ),
    calendars: z.array(
      z.strictObject({
        id: z.uuid(),
        name: z.string(),
        accountEmail: z.string().nullable(),
        provider: z.string(),
        checkConflicts: z.boolean(),
        lastSyncedAt: z.iso.datetime().nullable(),
        syncError: z
          .enum(['provider_unavailable', 'needs_reauth', 'permissions_missing'])
          .nullable(),
        status: z.string(),
      }),
    ),
  }),
})
const page = <T extends z.ZodType>(item: T) =>
  z.strictObject({ data: z.array(item), nextCursor: z.uuid().nullable() })
const selfContract = z.strictObject({ member: detail, eventTypes: page(detail) })
const admin = {
  summary,
  completeness,
  evaluatedAt: z.iso.datetime(),
  reasonCodes: z.array(
    z.enum([
      'default_schedule_required',
      'host_configuration_required',
      'activation_required',
      'calendar_attention_required',
      'check_not_performed',
      'check_failed',
      'optional_feature_attention_required',
    ]),
  ),
  fixKinds: z.array(z.enum(['edit_event', 'ask_member', 'retry_summary'])),
}
const teamContract = z.strictObject({
  organizationId: z.uuid(),
  members: page(z.strictObject({ memberId: z.uuid(), displayName: z.string(), ...admin })),
  eventTypes: page(z.strictObject({ eventTypeId: z.uuid(), enablement, activation, ...admin })),
})
const selfPath = '/api/v1/readiness/self'
const teamTemplate = '/api/v1/teams/{teamId}/readiness'

function routeCopy(mutation: [string, string]) {
  const original = readFileSync('apps/server/src/routes/readiness.ts', 'utf8')
  expect(original.includes(mutation[0])).toBe(true)
  const script = stripTypeScriptTypes(
    original.replace(...mutation).replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, ''),
  ).replace(/\bexport /g, '')
  const bindings = {
    createRoute,
    z,
    getSelfReadiness,
    getTeamReadiness,
    SelfReadinessPageSchema,
    TeamReadinessPageSchema,
    DomainError,
    createMiddleware,
    ErrorBody,
    errorResponses,
    json,
    serviceContext,
    teamManagementAccess,
  }
  return new Function(...Object.keys(bindings), `${script}; return readinessRoutes`)(
    ...Object.values(bindings),
  ) as typeof readinessRoutes
}

describe('readiness published contract', () => {
  it('keeps every response object open and documents errors and unknown checks', async () => {
    const doc = await openApiDocument(productApp({} as Db))
    expect(responseAndRequestStrictness(doc, [selfPath, teamTemplate]).closedResponses).toEqual([])
    for (const path of [selfPath, teamTemplate]) {
      const operation = doc.paths[path]?.get
      expect(operation?.security).toEqual([{ session: [] }])
      const errorStatuses =
        path === selfPath ? ['400', '401', '403', '429', '500'] : ['400', '403', '500']
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(['200', ...errorStatuses])
      for (const status of errorStatuses) {
        const schema = operation?.responses[status]?.content?.['application/json']?.schema
        expect(schema && resolve(doc, schema)).toEqual(doc.components.schemas.Error)
      }
      if (path === teamTemplate)
        expect(operation?.responses['403']).toMatchObject({
          description: expect.stringContaining(
            'team_management_access_denied: requires the current team owner/admin web session without Authorization',
          ),
        })
      const schema = operation?.responses['200']?.content?.['application/json']?.schema
      const published = schema && resolve(doc, schema)
      expect(published?.description).toContain('not_checked')
      expect(published?.description).toContain('check_failed')
    }
    const published = JSON.stringify(doc.components.schemas.SelfReadinessPage)
    for (const state of states) expect(published).toContain(`"${state}"`)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('readiness strict wire projection', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp(process.env.DATABASE_URL as string)
  })
  afterAll(async () => {
    await t?.drop()
  })

  async function fixture() {
    const user = await createTestUser(t.db)
    const team = await createTestTeam(t.db, [{ user, role: 'owner' }])
    const fx = createFixtures(t.db)
    await fx.schedule(user.id)
    const connection = await t.db
      .insertInto('calendar_connections')
      .values({
        user_id: user.id,
        provider: 'google',
        external_account_id: randomUUID(),
        account_email: 'private-contract-account@example.com',
        credentials: Buffer.from('synthetic-unused-contract-credential'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    const calendar = await t.db
      .insertInto('calendars')
      .values({
        connection_id: connection.id,
        external_id: randomUUID(),
        name: 'Private contract calendar',
        check_conflicts: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await fx.eventType(user.principal.organization.id, user.id)
    await fx.eventType(team.id, null, { hosts: [{ userId: user.id }] })
    const makePrincipal = async (organization: typeof user.principal.organization) => {
      const session = await t.db
        .insertInto('auth.session')
        .values({
          userId: user.id,
          token: randomUUID(),
          updatedAt: new Date(),
          expiresAt: new Date(Date.now() + 3_600_000),
          activeOrganizationId: organization.id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      return {
        kind: 'session',
        sessionId: session.id,
        user: user.principal.user,
        organization,
      } as const
    }
    return {
      calendarId: calendar.id,
      connectionId: connection.id,
      own: await makePrincipal(user.principal.organization),
      manager: await makePrincipal(team.as(user).organization),
      teamPath: `/api/v1/teams/${team.id}/readiness`,
    }
  }

  it('validates all nested self and team fields with strict privacy schemas', async () => {
    const f = await fixture()
    const own = await t.as(f.own).get(selfPath)
    const team = await t.as(f.manager).get(f.teamPath)
    expect(own.status).toBe(200)
    expect(team.status).toBe(200)
    expect(selfContract.safeParse(own.body).success).toBe(true)
    expect(teamContract.safeParse(team.body).success).toBe(true)
    const parsed = selfContract.parse(own.body)
    expect(parsed.member.details.schedules).toHaveLength(1)
    expect(parsed.member.details.calendars).toHaveLength(1)
    expect(parsed.eventTypes.data).toHaveLength(1)
    expect(parsed.eventTypes.data[0]?.details).toEqual({ schedules: [], calendars: [] })
  })

  it.each(['not_checked', 'check_failed'] as const)(
    'preserves required %s checks and partial completeness over HTTP',
    async (state) => {
      const f = await fixture()
      if (state === 'not_checked')
        await t.db
          .updateTable('calendar_connections')
          .set({ provider: 'microsoft' })
          .where('id', '=', f.connectionId)
          .execute()
      else
        await t.db
          .updateTable('calendars')
          .set({ check_conflicts: false })
          .where('id', '=', f.calendarId)
          .execute()
      const db =
        state === 'check_failed'
          ? t.db.withPlugin({
              transformQuery({ node }) {
                if (JSON.stringify(node).includes('schedules'))
                  throw new Error('synthetic failed read')
                return node
              },
              async transformResult({ result }) {
                return result
              },
            })
          : t.db
      const app = productApp(db, new Map([['hm_unknown_contract', f.own]]))
      const response = await app.request(selfPath, {
        headers: { cookie: syntheticSessionCookie('hm_unknown_contract') },
      })
      expect(response.status).toBe(200)
      const body = selfContract.parse(await response.json())
      expect(body.member.summary).toBe(state)
      expect(body.member.completeness).toBe('partial')
      const check = body.member.signals.find(
        (item) =>
          item.id === (state === 'not_checked' ? 'selected_calendar_sync' : 'default_schedule'),
      )
      expect(check?.state).toBe(state)
      if (state === 'not_checked') expect(check?.checkedAt).toBeNull()
      else expect(check?.checkedAt).toEqual(expect.any(String))
    },
  )

  it.each(['self', 'self_calendar', 'team'] as const)(
    'detects an added private %s field in a source-copy response',
    async (audience) => {
      const f = await fixture()
      const principal = audience === 'team' ? f.manager : f.own
      const path = audience === 'team' ? f.teamPath : selfPath
      const contract = audience === 'team' ? teamContract : selfContract
      const mutation: [string, string] =
        audience === 'self'
          ? [
              "await getSelfReadiness(serviceContext(deps, c.var.principal), c.req.valid('query')),",
              "{ ...(await getSelfReadiness(serviceContext(deps, c.var.principal), c.req.valid('query'))), privateCalendarName: 'private-field-canary' },",
            ]
          : audience === 'self_calendar'
            ? [
                "await getSelfReadiness(serviceContext(deps, c.var.principal), c.req.valid('query')),",
                "((page) => ({ ...page, member: { ...page.member, details: { ...page.member.details, calendars: page.member.details.calendars.map(calendar => ({ ...calendar, syncToken: 'private-field-canary' })) } } }))(await getSelfReadiness(serviceContext(deps, c.var.principal), c.req.valid('query'))),",
              ]
            : [
                'return c.json(result, 200)',
                "return c.json({ ...result, members: { ...result.members, data: result.members.data.map(member => ({ ...member, accountEmail: 'private-field-canary' })) } }, 200)",
              ]
      const verify = async (routes: typeof readinessRoutes) => {
        const app = productApp(t.db, new Map([['hm_contract_copy', principal]]), [
          routes({ db: t.db }),
        ])
        const response = await app.request(path, {
          headers: { cookie: syntheticSessionCookie('hm_contract_copy') },
        })
        expect(response.status).toBe(200)
        expect(contract.safeParse(await response.json()).success).toBe(true)
      }
      await verify(readinessRoutes)
      await expect(verify(routeCopy(mutation))).rejects.toMatchObject({ name: 'AssertionError' })
      await verify(readinessRoutes)
    },
  )
})
