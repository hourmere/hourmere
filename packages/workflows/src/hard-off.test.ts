// The source implementation flag is separate from the runtime operator switch.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import type { Db } from '@hourmere/db'
// The specifier production imports, not ./index.ts: what it resolves to is what runs.
import * as workflows from '@hourmere/workflows'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CreateWorkflowInputSchema, createWorkflow } from './creates.ts'
import { DeleteWorkflowInputSchema, deleteWorkflow } from './deletes.ts'
import * as hardOff from './hard-off.ts'
import * as operatorSettings from './operator-settings.ts'
import { PreviewWorkflowInputSchema, previewWorkflow, WorkflowPreviewSchema } from './preview.ts'
import { UpdateWorkflowInputSchema, updateWorkflow } from './updates.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Every runtime export of `@hourmere/workflows`, sorted. An allow-list: a new export (which
 * could wrap a guard and run its operation while off) must be added here, and so reviewed.
 */
const PACKAGE_EXPORTS = [
  'CreateWorkflowInputSchema',
  'DeleteWorkflowInputSchema',
  'PERSONAL_ONLY_CONDITION_FIELDS',
  'PreviewWorkflowInputSchema',
  'UpdateWorkflowInputSchema',
  'WORKFLOWS_IMPLEMENTED',
  'WORKFLOW_ANSWER_CONDITION_QUESTION_TYPES',
  'WORKFLOW_ANSWER_VARIABLE_PREFIX',
  'WORKFLOW_AUDIT_EVENTS',
  'WORKFLOW_BODY_MAX_BYTES',
  'WORKFLOW_BOOKING_SOURCES',
  'WORKFLOW_CONTENT_LOCALES',
  'WORKFLOW_HISTORY_DAYS',
  'WORKFLOW_INSTANCE_MAIL_CAP_DIVISOR',
  'WORKFLOW_LIMITS',
  'WORKFLOW_MAIL_MAX_PER_HOUR',
  'WORKFLOW_MAX_ACTIONS',
  'WORKFLOW_MAX_CONDITIONS',
  'WORKFLOW_MAX_DEFINITIONS_PER_OWNER',
  'WORKFLOW_MAX_ENABLED_PER_EVENT',
  'WORKFLOW_MAX_LATE_MINUTES',
  'WORKFLOW_MAX_OFFSET_MINUTES',
  'WORKFLOW_MIN_TIMER_OFFSET_MINUTES',
  'WORKFLOW_NAME_MAX_BYTES',
  'WORKFLOW_OWNER_MAIL_MAX_PER_HOUR',
  'WORKFLOW_PAGE',
  'WORKFLOW_RECIPIENT_CLASSES',
  'WORKFLOW_RECIPIENT_EMAILS_PER_DAY',
  'WORKFLOW_RECIPIENT_EMAILS_PER_HOUR',
  'WORKFLOW_RENDERED_MAX_BYTES',
  'WORKFLOW_RUN_PAGE',
  'WORKFLOW_SCALAR_QUESTION_TYPES',
  'WORKFLOW_SKIP_REASONS',
  'WORKFLOW_SUBJECT_MAX_BYTES',
  'WORKFLOW_TEMPLATE_VARIABLES',
  'WorkflowActionSchema',
  'WorkflowConditionSchema',
  'WorkflowConditionsSchema',
  'WorkflowDefinitionSchema',
  'WorkflowOwnerSelectorSchema',
  'WorkflowPreviewSchema',
  'WorkflowRunHistoryEntrySchema',
  'WorkflowScopeSchema',
  'WorkflowTriggerSchema',
  'captureWorkflowBooking',
  'captureWorkflowCreation',
  'createWorkflow',
  'deleteWorkflow',
  'dispatchWorkflowRuns',
  'evaluateConditions',
  'executeWorkflowClaim',
  // The definition reads (reads.ts): workflowOperation-wrapped, so off while hard-off.
  'getWorkflow',
  'isWorkflowBooking',
  'isWorkflowEventType',
  // Definition and history reads are workflowOperation-wrapped.
  'listWorkflowRuns',
  'listWorkflows',
  // Read-only helper for the shared webhook worker, whose workflow branch is guarded.
  'lockWorkflowWebhookRun',
  'ownsEventType',
  'ownsWebhook',
  'parseWorkflowDefinition',
  'previewWorkflow',
  // Pure rendering has no delivery or other side effects.
  'renderWorkflowEmail',
  'repairWorkflowWakes',
  'requireWorkflowUpdateAllowed',
  'requireWorkflowsEnabled',
  'requireWorkflowsImplemented',
  'scopeSelectsEventType',
  'shouldRunWorkflowJobs',
  'templatePlaceholders',
  'templateVariableProblem',
  'updateWorkflow',
  'validateWorkflowDefinition',
  'workflowAuditPort',
  'workflowCapture',
  'workflowDispatchWindow',
  'workflowExecution',
  'workflowJobs',
  'workflowMatches',
  'workflowOperation',
  'workflowOwnerSelector',
  'workflowRecipientHash',
  'workflowReferences',
  'workflowRunTiming',
  'workflowTimerDueAt',
  // Read-only identity lookup for the shared webhook repair job's workflow rows.
  'workflowWebhookAuditIdentities',
  'workflowsEnabled',
]

/**
 * The exact source of every statement in hard-off.ts: its import, the constant and the four
 * guards. Each guard decides from the constant alone and takes no option.
 */
const FROZEN_HARD_OFF_STATEMENTS = [
  "import { DomainError } from '@hourmere/scheduling/errors'",
  'export const WORKFLOWS_IMPLEMENTED: boolean = true',
  `export function requireWorkflowsImplemented(): void {
  if (WORKFLOWS_IMPLEMENTED !== true) throw new DomainError('not_found', 'workflows_disabled')
}`,
  `export function workflowOperation<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    requireWorkflowsImplemented()
    return operation(...args)
  }
}`,
  `export function workflowCapture<Args extends unknown[]>(
  capture: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    if (WORKFLOWS_IMPLEMENTED !== true) return
    await capture(...args)
  }
}`,
  `export function workflowExecution<Args extends unknown[]>(
  execute: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    if (WORKFLOWS_IMPLEMENTED !== true) return
    await execute(...args)
  }
}`,
]

describe('workflow implementation flag', () => {
  it('uses the implemented build and still requires the operator setting for capture', () => {
    expect(hardOff.WORKFLOWS_IMPLEMENTED).toBe(true)
    expect(workflows.WORKFLOWS_IMPLEMENTED).toBe(true)
    expect(workflows.workflowsEnabled({ workflowsEnabled: true })).toBe(true)
    expect(workflows.workflowsEnabled({})).toBe(false)
    expect(() => workflows.requireWorkflowsEnabled({})).toThrow('workflows_disabled')
  })

  it('captures nothing through the production entry before touching the booking transaction', async () => {
    const trx = new Proxy({} as Db, {
      get: () => {
        throw new Error('operator-off capture touched the transaction')
      },
    })
    await expect(
      workflows.captureWorkflowCreation(
        trx,
        {
          type: 'created',
          bookingId: '10000000-0000-4000-8000-000000000001',
          start: Temporal.Instant.from('2026-11-16T12:00Z'),
        },
        Temporal.Instant.from('2026-11-16T00:00Z'),
        'synthetic-capture-secret',
        { workflowsEnabled: false },
      ),
    ).resolves.toBeUndefined()
    for (const type of [
      'created',
      'rescheduled',
      'cancelled',
      'reschedule_requested',
      'reschedule_request_expired',
    ] as const) {
      await expect(
        workflows.captureWorkflowBooking(
          trx,
          {
            type,
            requestId: '10000000-0000-4000-8000-000000000002',
            bookingId: '10000000-0000-4000-8000-000000000001',
            start: Temporal.Instant.from('2026-11-16T12:00Z'),
          },
          Temporal.Instant.from('2026-11-16T00:00Z'),
          'synthetic-capture-secret',
          { workflowsEnabled: false },
        ),
      ).resolves.toBeUndefined()
    }
  })

  it('exposes the same pinned guards at both package entry points', async () => {
    // The webhook package imports the guard directly to avoid loading workflow services.
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages/workflows/package.json'), 'utf8'),
    ) as { exports?: unknown }
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './hard-off': './src/hard-off.ts',
      './operator-settings': './src/operator-settings.ts',
    })
    expect(await import('@hourmere/workflows/hard-off')).toBe(hardOff)
    expect(await import('@hourmere/workflows/operator-settings')).toBe(operatorSettings)
    // The constant and every guard, as production imports them, are hard-off.ts's own.
    for (const [name, value] of Object.entries(hardOff))
      expect((workflows as Record<string, unknown>)[name], name).toBe(value)
    for (const [name, value] of Object.entries(operatorSettings))
      expect((workflows as Record<string, unknown>)[name], name).toBe(value)
    expect(Object.keys(workflows).sort()).toEqual(PACKAGE_EXPORTS)
    expect(workflows.createWorkflow).toBe(createWorkflow)
    expect(workflows.CreateWorkflowInputSchema).toBe(CreateWorkflowInputSchema)
    expect(workflows.updateWorkflow).toBe(updateWorkflow)
    expect(workflows.UpdateWorkflowInputSchema).toBe(UpdateWorkflowInputSchema)
    expect(workflows.deleteWorkflow).toBe(deleteWorkflow)
    expect(workflows.DeleteWorkflowInputSchema).toBe(DeleteWorkflowInputSchema)
    expect(workflows.previewWorkflow).toBe(previewWorkflow)
    expect(workflows.PreviewWorkflowInputSchema).toBe(PreviewWorkflowInputSchema)
    expect(workflows.WorkflowPreviewSchema).toBe(WorkflowPreviewSchema)
  })

  it('exports the constant and its guards only, with no way to change them', () => {
    expect(Object.keys(hardOff).sort()).toEqual([
      'WORKFLOWS_IMPLEMENTED',
      'requireWorkflowsImplemented',
      'workflowCapture',
      'workflowExecution',
      'workflowOperation',
    ])
    // The package entry exposes no setter, override or test switch for the constant.
    const override = /^(?:set|enable|disable|override|force|unsafe|toggle|configure)|implemented/i
    expect(
      Object.keys(workflows).filter((name) => override.test(name) && !Object.hasOwn(hardOff, name)),
    ).toEqual([])
    // Nor any mutable state: every exported value is a function, a schema, a primitive or a
    // deeply frozen list or map, so no import can change what the package reads.
    const frozen = (value: unknown): boolean =>
      typeof value !== 'object' ||
      value === null ||
      (Object.isFrozen(value) && Object.values(value).every(frozen))
    expect(
      Object.entries(workflows)
        .filter(
          ([, value]) =>
            typeof value !== 'function' && !(value instanceof z.ZodType) && !frozen(value),
        )
        .map(([name]) => name),
    ).toEqual([])
  })

  it('pins every statement of the module, each guard body included, to its frozen source', () => {
    const source = readFileSync(join(root, 'packages/workflows/src/hard-off.ts'), 'utf8')
    const program = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program
    // An allow-list, not a search for forbidden shapes: any change to the code of a guard (a
    // parameter, a default, a loop, a cast, a property read, a call-time argument, another
    // import or module state) fails here. Comments between statements may change. Only the
    // plan's opt-in step, which sets the constant true, updates this list.
    expect(program.interpreter ?? null).toBeNull()
    expect(program.directives).toEqual([])
    expect(
      program.body.map((statement) => source.slice(statement.start ?? 0, statement.end ?? 0)),
    ).toEqual(FROZEN_HARD_OFF_STATEMENTS)
  })

  it('cannot be changed by a production import or the environment', () => {
    // A real Node process with the production module semantics, not the test runner's.
    const script = `
      const workflows = await import('@hourmere/workflows')
      const attempts = {}
      for (const [name, attempt] of Object.entries({
        assign: () => { workflows.WORKFLOWS_IMPLEMENTED = false },
        define: () => Object.defineProperty(workflows, 'WORKFLOWS_IMPLEMENTED', { value: false }),
        remove: () => { delete workflows.WORKFLOWS_IMPLEMENTED },
      })) {
        try { attempt(); attempts[name] = 'allowed' } catch (error) { attempts[name] = error.name }
      }
      attempts.reflect = Reflect.set(workflows, 'WORKFLOWS_IMPLEMENTED', false)
      // Each wrapped function, called with no argument and with call-time arguments that a
      // switch could read: each executes the inner function in the implemented build.
      const calls = {}
      for (const [label, args] of Object.entries({ none: [], true: [true], whileOff: [{ whileOff: true }] }))
        for (const guard of ['workflowOperation', 'workflowCapture', 'workflowExecution']) {
          let ran = false
          const wrapped = workflows[guard](async () => { ran = true; return 'ran' })
          let outcome
          try { outcome = { resolved: (await wrapped(...args)) ?? null } } catch (error) { outcome = { refused: error.code ?? error.name } }
          calls[guard + ' ' + label] = { ...outcome, ran }
        }
      console.log(JSON.stringify({ attempts, value: workflows.WORKFLOWS_IMPLEMENTED, calls }))
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        WORKFLOWS_ENABLED: 'false',
        WORKFLOWS_IMPLEMENTED: 'false',
        HOURMERE_WORKFLOWS: 'false',
      },
      timeout: 60_000,
    })
    expect(child.stderr).toBe('')
    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({
      attempts: { assign: 'TypeError', define: 'TypeError', remove: 'TypeError', reflect: false },
      value: true,
      calls: Object.fromEntries(
        ['none', 'true', 'whileOff'].flatMap((label) => [
          [`workflowOperation ${label}`, { resolved: 'ran', ran: true }],
          [`workflowCapture ${label}`, { resolved: null, ran: true }],
          [`workflowExecution ${label}`, { resolved: null, ran: true }],
        ]),
      ),
    })
  }, 60_000)

  it('is declared once as a true literal and assigned nowhere in production code', () => {
    const sources: string[] = []
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        if (entry === 'node_modules' || entry === 'dist') continue
        const path = join(directory, entry)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(?:ts|tsx|js|mjs)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
          sources.push(relative(root, path))
      }
    }
    for (const group of ['apps', 'packages', 'tools'])
      for (const name of readdirSync(join(root, group))) {
        const source = join(root, group, name, 'src')
        try {
          if (statSync(source).isDirectory()) walk(source)
        } catch {
          // Not a workspace with sources.
        }
      }
    expect(sources).toContain('packages/workflows/src/hard-off.ts')
    expect(sources).toContain('apps/server/src/server.ts')

    const mentions = sources.filter((file) =>
      readFileSync(join(root, file), 'utf8').includes('WORKFLOWS_IMPLEMENTED'),
    )
    expect(mentions.every((file) => file.startsWith('packages/workflows/src/'))).toBe(true)
    const declarations: string[] = []
    const writes: string[] = []
    for (const file of mentions) {
      const program = parse(readFileSync(join(root, file), 'utf8'), {
        sourceType: 'module',
        plugins: ['typescript'],
      })
      const stack: unknown[] = [program]
      while (stack.length) {
        const node = stack.pop()
        if (Array.isArray(node)) {
          stack.push(...node)
          continue
        }
        if (typeof node !== 'object' || node === null) continue
        const value = node as Record<string, unknown> & { type?: string }
        const target = (value.left ?? value.argument) as
          | { type: string; name?: string; property?: { name?: string } }
          | undefined
        const named = (candidate: typeof target) =>
          candidate?.name === 'WORKFLOWS_IMPLEMENTED' ||
          candidate?.property?.name === 'WORKFLOWS_IMPLEMENTED'
        if (
          (value.type === 'AssignmentExpression' || value.type === 'UpdateExpression') &&
          named(target)
        )
          writes.push(file)
        if (
          value.type === 'VariableDeclarator' &&
          (value.id as { name?: string }).name === 'WORKFLOWS_IMPLEMENTED'
        )
          declarations.push(`${file}:${JSON.stringify((value.init as { value?: unknown })?.value)}`)
        for (const [key, child] of Object.entries(value))
          if (!['loc', 'start', 'end', 'extra'].includes(key) && typeof child === 'object')
            stack.push(child)
      }
    }
    expect(declarations).toEqual(['packages/workflows/src/hard-off.ts:true'])
    expect(writes).toEqual([])
    const declaration = readFileSync(join(root, 'packages/workflows/src/hard-off.ts'), 'utf8')
    expect(declaration).toMatch(/^export const WORKFLOWS_IMPLEMENTED: boolean = true$/m)

    // The package reads no environment, configuration or global state, and imports only the
    // pure modules it needs: no `node:process`, configuration or server module.
    const allowed = new Set([
      'zod',
      '@hourmere/core/language',
      '@hourmere/db',
      '@hourmere/scheduling',
      '@hourmere/scheduling/errors',
      '@hourmere/scheduling/text',
    ])
    const auditImports = new Set(['@hourmere/db/audit'])
    // Authoring uses scope enforcement, SQL and the shared committing transaction.
    // These imports stay confined to the writers; hard-off.ts keeps its existing pin.
    const writeImports = new Set(['@hourmere/auth', '@hourmere/db/team-write', 'kysely'])
    const creationImports = new Set(['node:crypto', ...writeImports])
    const previewImports = new Set(['@hourmere/auth', '@hourmere/core', '@hourmere/db/team-write'])
    const readImports = new Set(['@hourmere/scheduling/sealed-secret', 'kysely'])
    const dispatcherImports = new Set(['node:crypto', 'kysely', '@hourmere/jobs'])
    // The renderer reads static notification catalogues and text helpers without the mailer.
    const emailImports = new Set(['@hourmere/mail/catalogue', '@hourmere/mail/text'])
    const emailAttemptImports = new Set([
      '@hourmere/mail',
      '@hourmere/notifications',
      '@hourmere/notifications/workflow-mail',
      '@hourmere/scheduling/notification-settings',
    ])
    const executionImports = new Set(['@hourmere/mail', '@hourmere/notifications/workflow-mail'])
    const captureImports = new Set([
      'node:crypto',
      'kysely',
      '@hourmere/scheduling/notification-settings',
    ])
    const own = sources.filter(
      (path) => path.startsWith('packages/workflows/src/') && !path.endsWith('/testing.ts'),
    )
    expect(own).toContain('packages/workflows/src/definition.ts')
    for (const file of own) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source, file).not.toMatch(
        /\bprocess\b|\bglobalThis\b|\bloadConfig\b|\bexport (?:let|var)\b|\bimport\.meta\b|\brequire\(|\bimport\(/,
      )
      const specifiers = [...source.matchAll(/^(?:import|export)\b[^'"]*?from '([^']+)'/gm)].map(
        (match) => match[1] as string,
      )
      expect(
        specifiers.filter(
          (specifier) =>
            !specifier.startsWith('./') &&
            !allowed.has(specifier) &&
            !(file === 'packages/workflows/src/audit.ts' && auditImports.has(specifier)) &&
            !(file === 'packages/workflows/src/creates.ts' && creationImports.has(specifier)) &&
            !(file === 'packages/workflows/src/updates.ts' && writeImports.has(specifier)) &&
            !(file === 'packages/workflows/src/capture.ts' && captureImports.has(specifier)) &&
            !(
              file === 'packages/workflows/src/dispatcher.ts' && dispatcherImports.has(specifier)
            ) &&
            !(file === 'packages/workflows/src/deletes.ts' && writeImports.has(specifier)) &&
            !(file === 'packages/workflows/src/preview.ts' && previewImports.has(specifier)) &&
            !(file === 'packages/workflows/src/reads.ts' && readImports.has(specifier)) &&
            !(file === 'packages/workflows/src/retention.ts' && specifier === 'kysely') &&
            !(file === 'packages/workflows/src/execution.ts' && executionImports.has(specifier)) &&
            !(file === 'packages/workflows/src/email.ts' && emailImports.has(specifier)) &&
            !(
              file === 'packages/workflows/src/email-attempt.ts' &&
              emailAttemptImports.has(specifier)
            ),
        ),
        file,
      ).toEqual([])
    }
  })
})

describe('production workflow audit port', () => {
  it('requires a transaction for definition and execution records', async () => {
    const { workflowAuditPort } = workflows
    const record = {
      occurredAt: Temporal.Instant.from('2026-11-09T00:00:00Z'),
      owner: { kind: 'team', organizationId: '30000000-0000-4000-8000-000000000001' },
      workflowId: '60000000-0000-4000-8000-000000000001',
      revision: 1,
      trigger: 'booking.created',
    } as const
    const db = { isTransaction: false } as Db
    await expect(
      workflowAuditPort.record(db, {
        ...record,
        event: 'workflow.created',
        actor: {
          kind: 'session',
          user: { id: '10000000-0000-4000-8000-000000000001' },
          sessionId: '20000000-0000-4000-8000-000000000001',
        },
      }),
    ).rejects.toThrow('Audit writes require a transaction')
    await expect(
      workflowAuditPort.record(db, {
        ...record,
        event: 'workflow.run_scheduled',
        actor: { kind: 'background', job: 'capture' },
      }),
    ).rejects.toThrow('Audit writes require a transaction')
    expect(Object.isFrozen(workflowAuditPort)).toBe(true)
  })
})
