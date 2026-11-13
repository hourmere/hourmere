// The hard-off switch: the constant is false, every guarded entry point refuses, and nothing a
// production process can do (an import, the environment, the configuration) turns it on.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
// The specifier production imports, not ./index.ts: what it resolves to is what runs.
import * as workflows from '@hourmere/workflows'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { hardOffWorkflowAuditPort } from './audit.ts'
import * as hardOff from './hard-off.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * Every runtime export of `@hourmere/workflows`, sorted. An allow-list: a new export (which
 * could wrap a guard and run its operation while off) must be added here, and so reviewed.
 */
const PACKAGE_EXPORTS = [
  'PERSONAL_ONLY_CONDITION_FIELDS',
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
  'WORKFLOW_SCALAR_QUESTION_TYPES',
  'WORKFLOW_SKIP_REASONS',
  'WORKFLOW_SUBJECT_MAX_BYTES',
  'WORKFLOW_TEMPLATE_VARIABLES',
  'WorkflowActionSchema',
  'WorkflowConditionSchema',
  'WorkflowConditionsSchema',
  'WorkflowDefinitionSchema',
  'WorkflowOwnerSelectorSchema',
  'WorkflowScopeSchema',
  'WorkflowTriggerSchema',
  'evaluateConditions',
  // The definition reads (reads.ts): workflowOperation-wrapped, so off while hard-off.
  'getWorkflow',
  'hardOffWorkflowAuditPort',
  'isWorkflowBooking',
  'isWorkflowEventType',
  // The definition reads (reads.ts): workflowOperation-wrapped, so off while hard-off.
  'listWorkflows',
  'ownsEventType',
  'ownsWebhook',
  'parseWorkflowDefinition',
  'requireWorkflowsImplemented',
  'scopeSelectsEventType',
  'templatePlaceholders',
  'templateVariableProblem',
  'validateWorkflowDefinition',
  'workflowCapture',
  'workflowDispatchWindow',
  'workflowExecution',
  'workflowMatches',
  'workflowOperation',
  'workflowOwnerSelector',
  'workflowReferences',
  'workflowRunTiming',
  'workflowTimerDueAt',
]

async function disabled(run: () => Promise<unknown>) {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(DomainError)
  expect(error).toMatchObject({ kind: 'not_found', code: 'workflows_disabled' })
}

/**
 * The exact source of every statement in hard-off.ts: its import, the constant and the four
 * guards. Each guard decides from the constant alone and takes no option.
 */
const FROZEN_HARD_OFF_STATEMENTS = [
  "import { DomainError } from '@hourmere/scheduling/errors'",
  'export const WORKFLOWS_IMPLEMENTED: boolean = false',
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

/** How each guarded entry point refuses while workflows are off; the inner call never runs. */
const refusals: Record<string, () => Promise<void>> = {
  requireWorkflowsImplemented: () => disabled(async () => hardOff.requireWorkflowsImplemented()),
  workflowOperation: async () => {
    let ran = false
    const operation = hardOff.workflowOperation(async (value: string) => {
      ran = true
      return value
    })
    await disabled(() => operation('read'))
    expect(ran).toBe(false)
  },
  workflowCapture: async () => {
    let ran = false
    const capture = hardOff.workflowCapture(async () => {
      ran = true
      throw new Error('capture must not run')
    })
    await expect(capture()).resolves.toBeUndefined()
    expect(ran).toBe(false)
  },
  workflowExecution: async () => {
    let ran = false
    const execute = hardOff.workflowExecution(async () => {
      ran = true
      throw new Error('execution must not run')
    })
    await expect(execute()).resolves.toBeUndefined()
    expect(ran).toBe(false)
  },
}

describe('workflow hard-off', () => {
  it('is off', () => {
    expect(hardOff.WORKFLOWS_IMPLEMENTED).toBe(false)
    expect(workflows.WORKFLOWS_IMPLEMENTED).toBe(false)
  })

  it('refuses at every guarded entry point', async () => {
    const guards = Object.entries(hardOff)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort()
    // A new guard must say here how it refuses.
    expect(guards).toEqual(Object.keys(refusals).sort())
    for (const [name, refuse] of Object.entries(refusals)) {
      await refuse()
      expect((workflows as Record<string, unknown>)[name], name).toBe(
        (hardOff as Record<string, unknown>)[name],
      )
    }
  })

  it('reaches production through one package entry that re-exports the guards unchanged', () => {
    // `@hourmere/workflows` has a single entry, this package's index. A new subpath or a
    // different entry module must update this pin.
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages/workflows/package.json'), 'utf8'),
    ) as { exports?: unknown }
    expect(manifest.exports).toEqual({ '.': './src/index.ts' })
    // The constant and every guard, as production imports them, are hard-off.ts's own.
    for (const [name, value] of Object.entries(hardOff))
      expect((workflows as Record<string, unknown>)[name], name).toBe(value)
    expect(Object.keys(workflows).sort()).toEqual(PACKAGE_EXPORTS)
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

  it('cannot be turned on by a production import or the environment', () => {
    // A real Node process with the production module semantics, not the test runner's.
    const script = `
      const workflows = await import('@hourmere/workflows')
      const attempts = {}
      for (const [name, attempt] of Object.entries({
        assign: () => { workflows.WORKFLOWS_IMPLEMENTED = true },
        define: () => Object.defineProperty(workflows, 'WORKFLOWS_IMPLEMENTED', { value: true }),
        remove: () => { delete workflows.WORKFLOWS_IMPLEMENTED },
      })) {
        try { attempt(); attempts[name] = 'allowed' } catch (error) { attempts[name] = error.name }
      }
      attempts.reflect = Reflect.set(workflows, 'WORKFLOWS_IMPLEMENTED', true)
      // Each wrapped function, called with no argument and with call-time arguments that a
      // switch could read: none of them runs the inner function.
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
        WORKFLOWS_ENABLED: 'true',
        WORKFLOWS_IMPLEMENTED: 'true',
        HOURMERE_WORKFLOWS: 'true',
      },
      timeout: 60_000,
    })
    expect(child.stderr).toBe('')
    expect(child.status).toBe(0)
    const refused = { refused: 'workflows_disabled', ran: false }
    const skipped = { resolved: null, ran: false }
    expect(JSON.parse(child.stdout)).toEqual({
      attempts: { assign: 'TypeError', define: 'TypeError', remove: 'TypeError', reflect: false },
      value: false,
      calls: Object.fromEntries(
        ['none', 'true', 'whileOff'].flatMap((label) => [
          [`workflowOperation ${label}`, refused],
          [`workflowCapture ${label}`, skipped],
          [`workflowExecution ${label}`, skipped],
        ]),
      ),
    })
  }, 60_000)

  it('is declared once as a false literal and assigned nowhere in production code', () => {
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
    // Only the workflow package reads the constant; nothing else can shadow or wrap it.
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
    expect(declarations).toEqual(['packages/workflows/src/hard-off.ts:false'])
    expect(writes).toEqual([])
    const declaration = readFileSync(join(root, 'packages/workflows/src/hard-off.ts'), 'utf8')
    expect(declaration).toMatch(/^export const WORKFLOWS_IMPLEMENTED: boolean = false$/m)

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
        specifiers.filter((specifier) => !specifier.startsWith('./') && !allowed.has(specifier)),
        file,
      ).toEqual([])
    }
  })
})

describe('workflow audit port while hard-off', () => {
  it('records nothing and touches no transaction', async () => {
    const port = hardOffWorkflowAuditPort()
    const trx = new Proxy(
      {},
      {
        get: () => {
          throw new Error('the hard-off audit port must not touch the transaction')
        },
      },
    ) as Db
    await expect(
      port.record(trx, {
        event: 'workflow.created',
        occurredAt: Temporal.Instant.from('2026-11-09T00:00:00Z'),
        actor: { kind: 'session', userId: '10000000-0000-4000-8000-000000000001' },
        owner: { kind: 'team', organizationId: '30000000-0000-4000-8000-000000000001' },
        workflowId: '60000000-0000-4000-8000-000000000001',
        revision: 1,
      }),
    ).resolves.toBeUndefined()
    expect(Object.isFrozen(port)).toBe(true)
    expect(hardOffWorkflowAuditPort()).toBe(port)
  })
})
