import { randomUUID } from 'node:crypto'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createEventType } from '@hourmere/scheduling'
import {
  createTestTeam,
  createTestUser,
  type TestUser,
  testContext,
} from '@hourmere/scheduling/testing'
import { Transaction } from 'kysely'
import nodemailer from 'nodemailer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { validateWorkflowDefinition } from './definition.ts'
import { renderWorkflowEmail } from './email.ts'
import {
  WORKFLOW_MAIL_MAX_PER_HOUR,
  WORKFLOW_OWNER_MAIL_MAX_PER_HOUR,
  WORKFLOW_RECIPIENT_EMAILS_PER_DAY,
  WORKFLOW_RECIPIENT_EMAILS_PER_HOUR,
} from './limits.ts'
import { previewWorkflowCandidate } from './preview.ts'
import {
  createRecordingWorkflowAudit,
  expectWorkflowAuditRedacted,
  insertWorkflowWebhook,
} from './testing.ts'

const serverUrl = process.env.DATABASE_URL

function request(user: TestUser, overrides: Record<string, unknown> = {}) {
  return {
    owner: { kind: 'personal', id: user.id },
    name: 'Preview consultation',
    scope: { type: 'all_event_types' },
    trigger: { type: 'booking.created' },
    actions: [{ type: 'email', recipients: ['booker'] }],
    ...overrides,
  }
}

describe.skipIf(!serverUrl)('synthetic workflow preview', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'workflow_preview' })
    db = createDb(owned.pool)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('audits only a successful authorized preview and omits synthetic content', async () => {
    const user = await createTestUser(db)
    const principal = user.principal
    if (principal.kind !== 'api_key') throw new Error('Expected a full-scope API key fixture')
    const audit = await createRecordingWorkflowAudit(db)
    const now = Temporal.Instant.from('2030-02-02T01:30:00Z')
    const ctx = { ...testContext(db, principal, () => now), audit: audit.port }
    const answer = 'Private synthetic response'
    const body = 'Private preview notes for {{recipient.name}}'
    const rawUrl = 'https://preview.example.test/private'
    const fakeSecret = 'synthetic-preview-query-credential'
    const address = 'preview.address@example.test'
    const example = {
      recipientName: address,
      publicPath: `${rawUrl}?key=${fakeSecret}`,
      answers: { notes: answer },
    }
    const candidate = request(user, {
      example,
      actions: [
        {
          type: 'email',
          recipients: ['booker'],
          content: { en: { subject: 'Private subject', body } },
        },
      ],
    })

    const unauthorized = await createTestUser(db)
    await expect(
      previewWorkflowCandidate({ ...ctx, principal: unauthorized.principal }, candidate),
    ).rejects.toMatchObject({ code: 'workflow_not_found' })
    await expect(
      previewWorkflowCandidate(ctx, {
        ...candidate,
        example: { ...example, start: '2030-02-02T02:00:00Z', end: '2030-02-02T01:00:00Z' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_workflow' })
    expect(await audit.read()).toEqual([])

    const preview = await previewWorkflowCandidate(ctx, candidate)
    expect(preview.emails[0]?.text).toContain(address)
    const records = await audit.read()
    expectWorkflowAuditRedacted(records, [
      answer,
      body,
      rawUrl,
      fakeSecret,
      address,
      'Private subject',
      'Private preview notes for',
    ])
    expect(records).toEqual([
      {
        event: 'workflow.previewed',
        occurredAt: now,
        owner: {
          kind: 'personal',
          userId: user.id,
          organizationId: user.principal.organization.id,
        },
        workflowId: null,
        revision: null,
        trigger: 'booking.created',
        actor: {
          kind: 'api_key',
          user: { id: user.id },
          apiKeyId: principal.apiKeyId,
          apiKeyScope: principal.apiKeyScope,
        },
      },
    ])
  })

  it('uses the execution renderer, including escaping and locale fallback, against example data', async () => {
    const user = await createTestUser(db)
    const { title, id } = await createEventType(testContext(db, user.principal), {
      title: 'Saved consultation title',
      slug: 'stored-consultation',
      durationMinutes: 30,
    })
    const context = { db, principal: user.principal }
    const candidate = request(user, {
      scope: { type: 'event_type', eventTypeId: id },
      actions: [
        {
          type: 'email',
          recipients: ['hosts', 'booker'],
          content: {
            en: {
              subject: ' {{event_type.title}} ',
              body: ' Hello {{recipient.name}}!\r\n{{booking.start}} ',
            },
          },
        },
      ],
    })
    const example = {
      recipientName: 'A <script>alert(1)</script> & B',
      eventTitle: 'Example subject',
      locale: 'en',
      timeZone: 'Asia/Shanghai',
      start: '2030-02-02T09:30:00+08:00',
      end: '2030-02-02T10:00:00+08:00',
    }
    const preview = await previewWorkflowCandidate(context, { ...candidate, example })
    const owner = {
      kind: 'personal' as const,
      userId: user.id,
      organizationId: user.principal.organization.id,
    }
    const eventType = {
      id,
      organizationId: owner.organizationId,
      ownerUserId: owner.userId,
      bookingMode: 'individual',
      deleted: false,
      questions: [],
    }
    const { owner: _selector, ...definition } = candidate
    const [action] = validateWorkflowDefinition(definition, {
      owner,
      eventTypes: new Map([[id, eventType]]),
      webhooks: new Map(),
    }).actions
    if (action?.type !== 'email') throw new Error('Expected email fixture')
    const rendered = renderWorkflowEmail({
      action,
      trigger: 'booking.created',
      context: { owner: owner.kind, eventType },
      recipient: {
        name: example.recipientName,
        timeZone: example.timeZone,
        locale: example.locale,
      },
      eventType: { title: example.eventTitle },
      booking: {
        start: Temporal.Instant.from(example.start),
        end: Temporal.Instant.from(example.end),
      },
    })
    expect(preview).toMatchObject({ synthetic: true, match: 'matched' })
    expect(preview.emails).toEqual([
      { recipientClass: 'booker', ...rendered },
      { recipientClass: 'hosts', ...rendered },
    ])
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; B')
    expect(JSON.stringify(preview)).not.toContain(title)
    const fallback = await previewWorkflowCandidate(context, {
      ...candidate,
      example: { ...example, locale: 'zh-CN' },
    })
    expect(fallback.emails[0]).toMatchObject({
      locale: 'zh-CN',
      templateLocale: 'zh-CN',
      contentSource: 'built_in',
      fallback: 'missing_translation',
    })
  })

  it('reads only authorization and candidate configuration and makes no outbound calls', async () => {
    const user = await createTestUser(db)
    const principal = user.principal
    const webhookId = await insertWorkflowWebhook(db, principal.organization.id)
    const event = await createEventType(testContext(db, principal), {
      title: 'A saved event',
      slug: 'saved-event',
      durationMinutes: 30,
    })
    const select = vi.spyOn(Transaction.prototype, 'selectFrom')
    const insert = vi.spyOn(Transaction.prototype, 'insertInto')
    const update = vi.spyOn(Transaction.prototype, 'updateTable')
    const remove = vi.spyOn(Transaction.prototype, 'deleteFrom')
    const blocked = () => {
      throw new Error('Preview reached an outbound dependency')
    }
    const smtp = vi.spyOn(nodemailer, 'createTransport')
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))
    const httpRequest = vi.spyOn(http, 'request').mockImplementation(blocked)
    const httpsRequest = vi.spyOn(https, 'request').mockImplementation(blocked)
    const dnsLookup = vi.spyOn(dns, 'lookup').mockImplementation(blocked)
    const dnsPromiseLookup = vi.spyOn(dnsPromises, 'lookup').mockImplementation(blocked)
    syncBuiltinESMExports()
    const context = { db, principal }
    const scoped = {
      scope: { type: 'event_type', eventTypeId: event.id },
      conditions: [{ field: 'guest_count', operator: 'at_least', value: 1 }],
    }
    const skipped = await previewWorkflowCandidate(context, request(user, scoped))
    const matched = await previewWorkflowCandidate(
      context,
      request(user, { ...scoped, example: { guestCount: 2 } }),
    )
    const outside = await previewWorkflowCandidate(
      context,
      request(user, { ...scoped, example: { eventTypeId: randomUUID(), guestCount: 2 } }),
    )
    const webhook = await previewWorkflowCandidate(
      context,
      request(user, { actions: [{ type: 'webhook', webhookId }] }),
    )
    expect([skipped.match, matched.match, outside.match]).toEqual([
      'condition_false',
      'matched',
      'scope_mismatch',
    ])
    expect(matched.emails[0]?.subject).toContain('Example Consultation')
    expect(JSON.stringify(matched)).not.toContain(event.title)
    expect(skipped.estimates).toEqual(matched.estimates)
    expect(matched.estimates).toEqual({
      emailRecipientClasses: 1,
      webhookDeliveriesPerMatch: 0,
      mailLimits: {
        defaultInstancePerHour: WORKFLOW_MAIL_MAX_PER_HOUR,
        defaultOwnerPerHour: WORKFLOW_OWNER_MAIL_MAX_PER_HOUR,
        recipientPerHour: WORKFLOW_RECIPIENT_EMAILS_PER_HOUR,
        recipientPerDay: WORKFLOW_RECIPIENT_EMAILS_PER_DAY,
      },
    })
    expect(webhook).toEqual({
      synthetic: true,
      match: 'matched',
      emails: [],
      estimates: { emailRecipientClasses: 0, webhookDeliveriesPerMatch: 1 },
    })
    expect(new Set(select.mock.calls.map(([table]) => String(table).split(' as ')[0]))).toEqual(
      new Set([
        'auth.user',
        'auth.organization',
        'personal_organizations',
        'auth.member',
        'event_types',
        'webhooks',
      ]),
    )
    expect({
      insert: insert.mock.calls.length,
      update: update.mock.calls.length,
      remove: remove.mock.calls.length,
      smtp: smtp.mock.calls.length,
      fetch: fetch.mock.calls.length,
      http: httpRequest.mock.calls.length,
      https: httpsRequest.mock.calls.length,
      dns: dnsLookup.mock.calls.length + dnsPromiseLookup.mock.calls.length,
    }).toEqual({ insert: 0, update: 0, remove: 0, smtp: 0, fetch: 0, http: 0, https: 0, dns: 0 })
  })

  it('rejects booking references, unauthorized variables and private conditions through the shared rules', async () => {
    const user = await createTestUser(db)
    const { id } = await createEventType(testContext(db, user.principal), {
      title: 'Saved event',
      slug: 'saved-event',
      durationMinutes: 30,
    })
    const team = await createTestTeam(db, [{ user, role: 'owner' }])
    const context = { db, principal: user.principal }
    const custom = {
      type: 'email',
      recipients: ['booker'],
      content: { en: { subject: 'Preview', body: '{{recipient.name}}' } },
    }
    const invalid = { code: 'invalid_workflow' }
    for (const overrides of [
      { bookingId: randomUUID() },
      { example: { bookingId: randomUUID() } },
      { example: { start: '2030-01-01T00:00:00.1234567891Z' } },
      { scope: { type: 'event_type', eventTypeId: randomUUID() } },
      {
        actions: [
          { ...custom, content: { en: { subject: 'Preview', body: '{{recipient.email}}' } } },
        ],
      },
    ])
      await expect(
        previewWorkflowCandidate(context, request(user, overrides)),
      ).rejects.toMatchObject(invalid)
    await expect(
      previewWorkflowCandidate(
        { ...context, followUpHostNotesEnabled: false },
        request(user, { actions: [custom] }),
      ),
    ).rejects.toMatchObject({
      ...invalid,
      message: expect.stringContaining('custom text is disabled'),
    })
    await db
      .updateTable('event_types')
      .set({ deleted_at: new Date() })
      .where('id', '=', id)
      .execute()
    await expect(
      previewWorkflowCandidate(
        context,
        request(user, { scope: { type: 'event_type', eventTypeId: id } }),
      ),
    ).rejects.toMatchObject({
      ...invalid,
      message: expect.stringContaining('workflows do not support'),
    })
    await expect(
      previewWorkflowCandidate(
        { db, principal: team.as(user) },
        request(user, {
          owner: { kind: 'team', id: team.id },
          conditions: [{ field: 'booking_source', operator: 'equals', value: 'web' }],
        }),
      ),
    ).rejects.toMatchObject({
      ...invalid,
      message: expect.stringContaining('not available to team'),
    })
  })
})
