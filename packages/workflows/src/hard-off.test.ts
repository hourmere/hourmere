// The hard-off switch: the constant is false, every guarded entry point refuses, and nothing a
// production process can do (an import, the environment, the configuration) turns it on.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { describe, expect, it } from 'vitest'
import { hardOffWorkflowAuditPort } from './audit.ts'
import * as hardOff from './hard-off.ts'
import * as workflows from './index.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))

async function disabled(run: () => Promise<unknown>) {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(DomainError)
  expect(error).toMatchObject({ kind: 'not_found', code: 'workflows_disabled' })
}

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
      let operation = 'ran'
      try { await workflows.workflowOperation(async () => undefined)() } catch (error) { operation = error.code }
      let ran = false
      await workflows.workflowCapture(async () => { ran = true })()
      await workflows.workflowExecution(async () => { ran = true })()
      console.log(JSON.stringify({ attempts, value: workflows.WORKFLOWS_IMPLEMENTED, operation, ran }))
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
    expect(JSON.parse(child.stdout)).toEqual({
      attempts: { assign: 'TypeError', define: 'TypeError', remove: 'TypeError', reflect: false },
      value: false,
      operation: 'workflows_disabled',
      ran: false,
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

    // The package reads no environment, configuration or global state.
    for (const file of sources.filter((path) => path.startsWith('packages/workflows/src/'))) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source, file).not.toMatch(
        /\bprocess\.|\bglobalThis\b|\bloadConfig\b|\bexport (?:let|var)\b|\bimport\.meta\.env\b/,
      )
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
