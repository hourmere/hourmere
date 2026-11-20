// Scope decisions over the actual HTTP/JSON-RPC/CLI adapters. Probe handlers make every
// allowed dispatch observable and prove forbidden calls never enter a resource service.
import { randomUUID } from 'node:crypto'
import { z } from '@hono/zod-openapi'
import type { ApiKeyScope, CallerResolver, Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../../tools/cli/src/cli.ts'
import { createApp } from '../app.ts'
import { productTools } from '../server.ts'
import { mcpEndpoint } from './endpoint.ts'
import { type McpCaller, runTool, type Tool } from './tools.ts'

const URL = 'http://localhost:4186'
const scopes = ['full', 'read', 'bookings'] as const
const all = [
  'whoami',
  'find_available_slots',
  'create_booking',
  'reschedule_booking',
  'request_reschedule',
  'cancel_booking',
  'list_bookings',
  'export_bookings',
  'retry_conference',
  'retry_calendar_copy',
  'set_attendee_no_show',
  'get_booking_attendees',
  'get_group_occurrence_attendees',
  'cancel_group_occurrence',
  'get_booking_activity',
  'get_profile',
  'list_event_types',
  'get_event_type',
  'set_event_type_notifications',
  'list_schedules',
  'get_schedule_availability',
  'save_schedule_availability',
  'get_schedule',
  'get_branding',
  'set_branding',
  'list_audit_events',
  'get_audit_log_settings',
  'set_audit_log_settings',
  'duplicate_event_type',
  'create_event_type',
  'update_event_type',
  'create_one_time_link',
  'list_one_time_links',
  'revoke_one_time_link',
  'list_slack_destinations',
  'create_slack_destination',
  'update_slack_destination',
  'delete_slack_destination',
  'test_slack_destination',
  'list_webhooks',
  'create_webhook',
  'update_webhook',
  'delete_webhook',
  'rotate_webhook_secret',
  'list_webhook_deliveries',
  'generate_open_time_snippet',
  'troubleshoot_availability',
  'list_calendar_connections',
  'list_conference_connections',
  'read_meeting_poll',
  'enroll_meeting_poll_voter',
  'recover_meeting_poll_voter',
  'verify_meeting_poll_voter',
  'submit_meeting_poll_vote',
  'withdraw_meeting_poll_vote',
  'opt_out_meeting_poll_reminder',
  'list_meeting_polls',
  'get_meeting_poll',
  'get_meeting_poll_results',
  'close_meeting_poll',
  'cancel_meeting_poll',
  'delete_meeting_poll',
  'finalize_meeting_poll',
  'create_meeting_poll',
  'invite_meeting_poll_voters',
  'resend_meeting_poll_invitation',
  'remove_meeting_poll_voter',
  'remove_unverified_meeting_poll_voters',
  'rotate_meeting_poll_link',
  'get_event_type_waitlist',
  'set_event_type_waitlist',
  'list_waitlist_entries',
  'remove_waitlist_entry',
  'join_waitlist',
  'resend_waitlist_verification',
  'create_workflow',
  'update_workflow',
  'delete_workflow',
  'preview_workflow',
  'list_workflows',
  'get_workflow',
  'list_workflow_runs',
  'list_sso_providers',
  'get_sso_policy',
  'list_routing_forms',
  'get_routing_form',
  'create_routing_form',
  'update_routing_form',
  'archive_routing_form',
  'publish_routing_form',
  'preview_routing_form',
  'get_public_routing_form',
  'route_lead',
  'resolve_routing_continuation',
  'find_routed_slots',
]
// Hidden catalog entries never reach handlers. Workflows check scope first; SSO
// answers sso_disabled before scope or arguments while both protocols are hard-off.
const ssoUnavailable = new Set(['list_sso_providers', 'get_sso_policy'])
const unavailable = new Set([
  'create_workflow',
  'update_workflow',
  'delete_workflow',
  'preview_workflow',
  'list_workflows',
  'get_workflow',
  'list_workflow_runs',
  ...ssoUnavailable,
])
const disabled = (name: string) => ({
  error: ssoUnavailable.has(name) ? 'sso_disabled' : 'workflows_disabled',
})
// Full scope only: audit reads reveal who did what (see api-key-operations.ts).
const auditReads = new Set(['list_audit_events', 'get_audit_log_settings'])
const configurationWrites = new Set([
  'create_routing_form',
  'update_routing_form',
  'archive_routing_form',
  'publish_routing_form',
  'create_workflow',
  'update_workflow',
  'delete_workflow',
  'set_audit_log_settings',
  'set_branding',
  'save_schedule_availability',
  'create_slack_destination',
  'update_slack_destination',
  'delete_slack_destination',
  'test_slack_destination',
  'create_webhook',
  'update_webhook',
  'delete_webhook',
  'rotate_webhook_secret',
  'duplicate_event_type',
  'create_event_type',
  'update_event_type',
  'set_event_type_notifications',
  'set_event_type_waitlist',
  'remove_waitlist_entry',
])
const writes = new Set([
  'enroll_meeting_poll_voter',
  'recover_meeting_poll_voter',
  'verify_meeting_poll_voter',
  'submit_meeting_poll_vote',
  'withdraw_meeting_poll_vote',
  'opt_out_meeting_poll_reminder',
  'close_meeting_poll',
  'cancel_meeting_poll',
  'delete_meeting_poll',
  'finalize_meeting_poll',
  'create_meeting_poll',
  'invite_meeting_poll_voters',
  'resend_meeting_poll_invitation',
  'remove_meeting_poll_voter',
  'remove_unverified_meeting_poll_voters',
  'rotate_meeting_poll_link',
  ...configurationWrites,
  'route_lead',
  'resolve_routing_continuation',
  'find_routed_slots',
  'create_booking',
  'reschedule_booking',
  'request_reschedule',
  'cancel_booking',
  'cancel_group_occurrence',
  'retry_conference',
  'retry_calendar_copy',
  'set_attendee_no_show',
  'create_one_time_link',
  'revoke_one_time_link',
  'set_event_type_notifications',
  'join_waitlist',
  'resend_waitlist_verification',
])
const otherReads = new Set([
  'list_routing_forms',
  'get_routing_form',
  'get_branding',
  'export_bookings',
  'get_booking_activity',
  'list_slack_destinations',
  'list_webhooks',
  'list_webhook_deliveries',
  'list_schedules',
  'get_schedule',
  'get_schedule_availability',
  'list_calendar_connections',
  'list_conference_connections',
  'get_event_type_waitlist',
  'list_waitlist_entries',
  'list_one_time_links',
  'list_workflows',
  'get_workflow',
  'list_workflow_runs',
  'list_sso_providers',
  'get_sso_policy',
])
// Read-only diagnostics and configuration previews require full keys.
const fullOnlyReads = new Set([
  'troubleshoot_availability',
  'preview_routing_form',
  'preview_workflow',
])
const expected = (scope: ApiKeyScope) =>
  all.filter((name) =>
    scope === 'full'
      ? true
      : fullOnlyReads.has(name) || auditReads.has(name)
        ? false
        : scope === 'read'
          ? !writes.has(name)
          : !otherReads.has(name) && !configurationWrites.has(name),
  )
const denial = {
  error: 'insufficient_scope',
  message: 'This API key does not allow this operation.',
}
const catalog = productTools({ db: {} as Db, slotSnippetsEnabled: true, routingFormsEnabled: true })
function principal(scope: ApiKeyScope): McpCaller {
  return {
    kind: 'api_key',
    apiKeyScope: scope,
    apiKeyId: randomUUID(),
    user: { id: randomUUID(), name: 'Scope test', email: 'scope@example.test' },
    organization: { id: randomUUID(), name: 'Personal', slug: 'scope', personal: true },
  }
}
const principals = Object.fromEntries(scopes.map((scope) => [scope, principal(scope)])) as Record<
  ApiKeyScope,
  McpCaller
>
const resolver: CallerResolver = async (headers) => {
  const scope = headers.get('authorization')?.replace('Bearer hm_', '') as ApiKeyScope
  return Object.hasOwn(principals, scope)
    ? { ok: true, principal: principals[scope], setCookie: [] }
    : { ok: false, error: 'unauthorized', setCookie: [] }
}
function appWith(tools: readonly Tool[] = catalog, resolveCaller = resolver) {
  return createApp({
    publicUrl: URL,
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller,
    mcp: mcpEndpoint({ tools }),
  })
}
const app = appWith()
function headers(scope: ApiKeyScope, era: 'legacy' | 'modern', name?: string) {
  return {
    authorization: `Bearer hm_${scope}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(era === 'modern' && {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': name ? 'tools/call' : 'tools/list',
      ...(name && { 'mcp-name': name }),
    }),
  }
}
async function rpc(
  name: string,
  scope: ApiKeyScope,
  era: 'legacy' | 'modern',
  args: unknown = {},
  target = app,
) {
  const res = await target.request('/mcp', {
    method: 'POST',
    headers: headers(scope, era, name),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        ...(era === 'modern' && {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        }),
      },
    }),
  })
  const text = await res.text()
  const data = text.split('\n').find((line) => line.startsWith('data: '))
  return { res, message: JSON.parse(data ? data.slice(6) : text) }
}
const textOf = (result: { content: { text: string }[] }) =>
  JSON.parse(result.content[0]?.text ?? '')
const probe = (tool: Tool) => ({
  ...tool,
  input: z.object({ idempotencyKey: z.string().optional() }),
  output: z.object({ dispatched: z.string() }),
  run: vi.fn(async () => ({ dispatched: tool.name })),
})

describe('MCP scoped discovery and dispatch', () => {
  it.each(['legacy', 'modern'] as const)(
    '%s lists exact production catalogs per key without cross-key reuse',
    async (era) => {
      expect(catalog.map((tool) => tool.name)).toEqual(all)
      for (const scope of ['full', 'read', 'bookings', 'full', 'read'] as const) {
        const client = new Client(
          { name: 'scope-discovery', version: '1' },
          era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
        )
        const responses: Response[] = []
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new globalThis.URL(`${URL}/mcp`), {
              fetch: async (input, init) => {
                const res = await app.request(input, init)
                responses.push(res)
                return res
              },
              requestInit: { headers: { authorization: `Bearer hm_${scope}` } },
            }),
          )
          const { tools } = await client.listTools()
          expect(tools.map((tool) => tool.name)).toEqual(
            expected(scope).filter((name) => !unavailable.has(name)),
          )
          for (const tool of tools) {
            expect(tool.inputSchema.additionalProperties).toBe(false)
            expect(tool.outputSchema).toBeDefined()
            expect(tool.annotations).toMatchObject(
              catalog.find((original) => original.name === tool.name)?.annotations ?? {},
            )
          }
          expect(responses.every((res) => res.headers.get('cache-control') === 'no-store')).toBe(
            true,
          )
          const identity = await client.callTool({ name: 'whoami', arguments: {} })
          expect(identity.structuredContent).toMatchObject({ principal: { apiKeyScope: scope } })
          if (era === 'legacy') {
            const instructions = client.getInstructions() ?? ''
            expect(instructions).toContain('refresh tool discovery')
            if (scope === 'read') {
              for (const write of writes) expect(instructions).not.toContain(write)
              expect(instructions).toContain('discovery and inspection only')
            }
          }
        } finally {
          await client.close()
        }
      }
    },
  )

  it.each(scopes)(
    '%s enforces all tools over both protocol eras before handlers',
    async (scope) => {
      const tools = catalog.map(probe)
      const target = appWith(tools)
      for (const era of ['legacy', 'modern'] as const) {
        for (const tool of tools) {
          tool.run.mockClear()
          const { res, message } = await rpc(tool.name, scope, era, {}, target)
          expect(res.status, `${scope}/${era}/${tool.name}`).toBe(200)
          if (
            (expected(scope).includes(tool.name) && unavailable.has(tool.name)) ||
            ssoUnavailable.has(tool.name)
          ) {
            expect(message.result.isError, `${scope}/${tool.name}`).toBe(true)
            expect(textOf(message.result)).toEqual(disabled(tool.name))
            expect(tool.run).not.toHaveBeenCalled()
          } else if (expected(scope).includes(tool.name)) {
            expect(message.result.isError, `${scope}/${tool.name}`).toBeFalsy()
            expect(tool.run).toHaveBeenCalledTimes(1)
          } else {
            expect(message.result.isError).toBe(true)
            expect(textOf(message.result)).toEqual(denial)
            expect(tool.run).not.toHaveBeenCalled()
            expect(res.headers.get('cache-control')).toBe('no-store')
          }
        }
      }
    },
  )

  it('checks hidden known names before argument/resource validation but preserves protocol errors', async () => {
    for (const era of ['legacy', 'modern'] as const) {
      for (const args of [{}, { bookingId: randomUUID() }, { manageToken: 'invalid' }]) {
        const { message } = await rpc('cancel_booking', 'read', era, args)
        expect(message).toHaveProperty('result')
        expect(message.result.isError).toBe(true)
        expect(textOf(message.result)).toEqual(denial)
      }
      const unknown = await rpc('unknown_tool', 'read', era)
      expect(unknown.message.error).toMatchObject({ code: -32602 })
      expect(unknown.message.result).toBeUndefined()
      const malformed = await rpc('cancel_booking', 'read', era, 'not-an-object')
      expect(malformed.message.error).toMatchObject({ code: -32602 })
      expect(malformed.message.result).toBeUndefined()
    }
    const mismatch = await app.request('/mcp', {
      method: 'POST',
      headers: { ...headers('read', 'modern', 'cancel_booking'), 'mcp-name': 'whoami' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'cancel_booking',
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    })
    expect(mismatch.status).toBe(400)
  })

  it.each(scopes)(
    '%s protects direct runTool calls for every tool and explicit dispatch mode',
    async (scope) => {
      for (const original of catalog) {
        for (const args of [{}, { teamSlug: 'team' }, { bookingId: randomUUID() }]) {
          const tool = probe(original)
          const result = await runTool(
            tool,
            args,
            { caller: principals[scope], rateLimit: () => {} },
            () => {
              throw Error('Unexpected tool error')
            },
          )
          if (
            (expected(scope).includes(tool.name) && unavailable.has(tool.name)) ||
            ssoUnavailable.has(tool.name)
          ) {
            expect(textOf(result as { content: { text: string }[] })).toEqual(disabled(tool.name))
            expect(tool.run).not.toHaveBeenCalled()
          } else if (expected(scope).includes(tool.name)) expect(tool.run).toHaveBeenCalledTimes(1)
          else {
            expect(result.isError).toBe(true)
            expect(textOf(result as { content: { text: string }[] })).toEqual(denial)
            expect(tool.run).not.toHaveBeenCalled()
          }
        }
      }
    },
  )

  it('denies unmapped tools and modes for limited scopes, including read-only annotated tools', async () => {
    const unknownTool = { ...probe(catalog[0] as Tool), name: 'new_unmapped_read' }
    const unknownMode = {
      ...probe(catalog[0] as Tool),
      scopeModes: ['new_mode'],
      scopeMode: () => 'new_mode',
    }
    for (const tool of [unknownTool, unknownMode]) {
      for (const scope of scopes) {
        tool.run.mockClear()
        const result = await runTool(
          tool,
          {},
          { caller: principals[scope], rateLimit: () => {} },
          () => {},
        )
        expect(tool.run).toHaveBeenCalledTimes(scope === 'full' ? 1 : 0)
        if (scope !== 'full') {
          expect(textOf(result as { content: { text: string }[] })).toEqual(denial)
          const direct = await rpc(tool.name, scope, 'modern', {}, appWith([tool]))
          expect(textOf(direct.message.result)).toEqual(denial)
        }
      }
    }
  })

  it('keeps OAuth discovery under its existing grant without inventing an API key scope', async () => {
    const { user, organization } = principal('full')
    const oauth: Principal = {
      kind: 'oauth',
      user,
      organization,
      oauthConsentId: randomUUID(),
      clientId: 'scope-oauth-test',
      scopes: ['mcp:tools'],
    }
    const target = createApp({
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: resolver,
      publicUrl: URL,
      mcp: mcpEndpoint({
        tools: catalog,
        oauth: {
          resolve: async () => ({ ok: true, principal: oauth }),
          handler: async () => new Response(null, { status: 404 }),
        },
      }),
    })
    const client = new Client({ name: 'scope-oauth', version: '1' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new globalThis.URL(`${URL}/mcp`), {
          fetch: async (input, init) => target.request(input, init),
          requestInit: { headers: { authorization: 'Bearer oauth-test-token' } },
        }),
      )
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        all.filter((name) => !unavailable.has(name)),
      )
      const identity = await client.callTool({ name: 'whoami', arguments: {} })
      expect(identity.structuredContent).toHaveProperty('principal')
      expect((identity.structuredContent as { principal: object }).principal).not.toHaveProperty(
        'apiKeyScope',
      )
    } finally {
      await client.close()
    }
  })
})

describe('CLI scope parity', () => {
  const commands = [
    ['audit-log list', 'list_audit_events'],
    ['audit-log settings', 'get_audit_log_settings'],
    ['audit-log set-retention', 'set_audit_log_settings'],
    ['branding get', 'get_branding'],
    ['branding set', 'set_branding'],
    ['whoami', 'whoami'],
    ['profile', 'get_profile'],
    ['catalog', 'list_event_types'],
    ['event', 'get_event_type'],
    ['create-event', 'create_event_type'],
    ['duplicate-event', 'duplicate_event_type'],
    ['update-event', 'update_event_type'],
    ['set-event-notifications', 'set_event_type_notifications'],
    ['schedules', 'list_schedules'],
    ['schedule', 'get_schedule'],
    ['schedule-availability', 'get_schedule_availability'],
    ['save-availability', 'save_schedule_availability'],
    ['slots', 'find_available_slots'],
    ['book', 'create_booking'],
    ['list', 'list_bookings'],
    ['reschedule', 'reschedule_booking'],
    ['request-reschedule', 'request_reschedule'],
    ['cancel', 'cancel_booking'],
    ['retry-meeting', 'retry_conference'],
    ['retry-calendar-copy', 'retry_calendar_copy'],
    ['set-no-show', 'set_attendee_no_show'],
    ['booking-activity', 'get_booking_activity'],
    ['polls view', 'read_meeting_poll'],
    ['polls join', 'enroll_meeting_poll_voter'],
    ['polls recover', 'recover_meeting_poll_voter'],
    ['polls verify', 'verify_meeting_poll_voter'],
    ['polls vote', 'submit_meeting_poll_vote'],
    ['polls withdraw', 'withdraw_meeting_poll_vote'],
    ['polls reminder-opt-out', 'opt_out_meeting_poll_reminder'],
    ['polls list', 'list_meeting_polls'],
    ['polls get', 'get_meeting_poll'],
    ['polls results', 'get_meeting_poll_results'],
    ['polls close', 'close_meeting_poll'],
    ['polls cancel', 'cancel_meeting_poll'],
    ['polls delete', 'delete_meeting_poll'],
    ['polls finalize', 'finalize_meeting_poll'],
    ['polls create', 'create_meeting_poll'],
    ['polls invite', 'invite_meeting_poll_voters'],
    ['polls resend-invitation', 'resend_meeting_poll_invitation'],
    ['polls remove-voter', 'remove_meeting_poll_voter'],
    ['polls remove-unverified', 'remove_unverified_meeting_poll_voters'],
    ['polls rotate-link', 'rotate_meeting_poll_link'],
    ['event-waitlist', 'get_event_type_waitlist'],
    ['set-event-waitlist', 'set_event_type_waitlist'],
    ['waitlist-entries', 'list_waitlist_entries'],
    ['remove-waitlist-entry', 'remove_waitlist_entry'],
    ['join-waitlist', 'join_waitlist'],
    ['resend-waitlist-verification', 'resend_waitlist_verification'],
    ['one-time-links create', 'create_one_time_link'],
    ['one-time-links list', 'list_one_time_links'],
    ['one-time-links revoke', 'revoke_one_time_link'],
    ['webhooks list', 'list_webhooks'],
    ['webhooks create', 'create_webhook'],
    ['webhooks update', 'update_webhook'],
    ['webhooks delete', 'delete_webhook'],
    ['webhooks rotate-secret', 'rotate_webhook_secret'],
    ['webhooks deliveries', 'list_webhook_deliveries'],
    ['workflows update', 'update_workflow'],
    ['workflows delete', 'delete_workflow'],
    ['workflows preview', 'preview_workflow'],
    ['workflows create', 'create_workflow'],
    ['workflows list', 'list_workflows'],
    ['workflows get', 'get_workflow'],
    ['workflows runs', 'list_workflow_runs'],
    ['sso providers list', 'list_sso_providers'],
    ['sso policy', 'get_sso_policy'],
    ['routing-forms list', 'list_routing_forms'],
    ['routing-forms get', 'get_routing_form'],
    ['routing-forms create', 'create_routing_form'],
    ['routing-forms update', 'update_routing_form'],
    ['routing-forms archive', 'archive_routing_form'],
    ['routing-forms publish', 'publish_routing_form'],
    ['routing-forms preview', 'preview_routing_form'],
    ['routing-forms public', 'get_public_routing_form'],
    ['routing-forms route', 'route_lead'],
    ['routing-forms resolve', 'resolve_routing_continuation'],
    ['routing-forms slots', 'find_routed_slots'],
  ] as const
  it.each(scopes)(
    '%s follows every network alias and never retries a scope denial',
    async (scope) => {
      const target = appWith(catalog.map(probe))
      for (const [command, name] of commands) {
        let stdout = ''
        let stderr = ''
        const fetcher = vi.fn<typeof fetch>(async (input, init) => target.request(input, init))
        const key = `hm_${scope}`
        const code = await runCli({
          argv: [
            ...command.split(' '),
            '--input',
            '-',
            ...(name === 'create_webhook' || name === 'rotate_webhook_secret' ? ['--json'] : []),
            ...(name === 'delete_webhook' ? ['--yes'] : []),
          ],
          env: { HOURMERE_URL: URL, HOURMERE_API_KEY: key },
          stdin: (async function* () {
            yield JSON.stringify({ idempotencyKey: 'scope-matrix-test' })
          })(),
          stdout: (text) => {
            stdout += text
          },
          stderr: (text) => {
            stderr += text
          },
          fetch: fetcher,
        })
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect((stdout + stderr).includes(key)).toBe(false)
        if ((expected(scope).includes(name) && unavailable.has(name)) || ssoUnavailable.has(name)) {
          expect(code, `${scope}/${command}`).toBe(1)
          expect(stdout).toBe('')
          expect(JSON.parse(stderr)).toMatchObject(disabled(name))
        } else if (expected(scope).includes(name)) {
          expect(code, `${scope}/${command}`).toBe(0)
          expect(JSON.parse(stdout)).toEqual({ dispatched: name })
        } else {
          expect(code, `${scope}/${command}`).toBe(1)
          expect(stdout).toBe('')
          expect(JSON.parse(stderr)).toMatchObject({ error: 'insufficient_scope' })
          expect(stderr).not.toContain(denial.message)
        }
      }
    },
  )
})
