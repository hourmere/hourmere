import '@hono/zod-openapi'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { waitlistMaintenanceJobs } from '@hourmere/jobs/waitlist'
import { createWaitlistEmailWorker } from '@hourmere/notifications'
import { scanWaitlists } from '@hourmere/scheduling'
import { executeWorkflowClaim, workflowJobs } from '@hourmere/workflows'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RunningServer } from './server.ts'
import { mailboxProofJobs } from './sso-mailbox-proof.ts'
import { disableSsoEnforcement, ssoOperatorRecoveryEmailJob } from './sso-operator-recovery.ts'

const databaseUrl = process.env.DATABASE_URL
function observe<Arguments extends unknown[], Result>(call: (...args: Arguments) => Result) {
  const calls: { args: Arguments; result: Result }[] = []
  return Object.assign(
    (...args: Arguments): Result => {
      const result = call(...args)
      calls.push({ args, result })
      return result
    },
    { calls },
  )
}

function observations() {
  return {
    createWaitlistEmailWorker: observe(createWaitlistEmailWorker),
    scanWaitlists: observe(scanWaitlists),
    waitlistMaintenanceJobs: observe(waitlistMaintenanceJobs),
    executeWorkflowClaim: observe(executeWorkflowClaim),
    workflowJobs: observe(workflowJobs),
    mailboxProofJobs: observe(mailboxProofJobs),
    disableSsoEnforcement: observe(disableSsoEnforcement),
    ssoOperatorRecoveryEmailJob: observe(ssoOperatorRecoveryEmailJob),
  }
}

/** Observe the production entry point's calls while running the real jobs and handlers. */
async function entryPoint<T>(
  file: string,
  probes: ReturnType<typeof observations>,
  names: readonly (keyof typeof probes)[],
): Promise<T> {
  const location = new URL(file, import.meta.url)
  const probeKey = randomUUID()
  const globals = globalThis as unknown as Record<string, typeof probes>
  const replaced = new Set<string>()
  const javascript = stripTypeScriptTypes(readFileSync(location, 'utf8'))
    .replace(
      /^(import\s+\{)([^}]+)(\}\s+from\s+'[^']+')/gm,
      (_, start: string, run: string, end: string) =>
        start +
        run.replace(/\b\w+\b/g, (name) => {
          if (!(names as readonly string[]).includes(name)) return name
          replaced.add(name)
          return `${name} as observed_${name}`
        }) +
        end,
    )
    .replace(
      /((?:from|import)\s*)'([^']+)'/g,
      (_, prefix: string, specifier: string) =>
        `${prefix}'${specifier.startsWith('.') ? new URL(specifier, location).href : import.meta.resolve(specifier)}'`,
    )
  expect([...replaced].sort()).toEqual([...names].sort())
  const source = `${javascript}\nconst { ${names.join(', ')} } = globalThis[${JSON.stringify(probeKey)}]\n`
  globals[probeKey] = probes
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  } finally {
    delete globals[probeKey]
  }
}

describe.skipIf(!databaseUrl).each([
  { label: 'empty in copied env', setting: '', enabled: true },
  { label: 'explicitly off', setting: 'off', enabled: false },
])('production job composition with SCIM $label', ({ setting, enabled }) => {
  let owned: TestDatabase
  let running: RunningServer
  const probes = observations()
  const run = { id: randomUUID(), attempt: 1, signal: new AbortController().signal }

  beforeAll(async () => {
    const server = await entryPoint<typeof import('./server.ts')>('./server.ts', probes, [
      'createWaitlistEmailWorker',
      'scanWaitlists',
      'waitlistMaintenanceJobs',
      'executeWorkflowClaim',
      'workflowJobs',
      'mailboxProofJobs',
      'ssoOperatorRecoveryEmailJob',
    ])
    for (const method of ['log', 'info', 'warn', 'error'] as const)
      vi.spyOn(console, method).mockImplementation(() => {})
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'scim_worker' })
    running = await server.startServer({
      DATABASE_URL: owned.url,
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
      PUBLIC_URL: 'http://localhost',
      SIGNUP: 'closed',
      HOURMERE_ROLE: 'worker',
      PORT: '0',
      WORKFLOWS_ENABLED: 'true',
      SCIM_PROVISIONING_ENABLED: setting,
    })
  })

  afterAll(async () => {
    try {
      await running?.close()
    } finally {
      await owned?.drop()
      vi.restoreAllMocks()
    }
  })

  it('passes the setting to the waitlist email worker', () => {
    expect(
      probes.createWaitlistEmailWorker.calls.map(({ args: [deps] }) => deps.scimResourcesEnabled),
    ).toEqual([enabled])
  })

  it('passes the setting to both the startup and scheduled waitlist scans', async () => {
    expect(probes.scanWaitlists.calls[0]?.args[0].scimResourcesEnabled).toBe(enabled)
    const scanned = probes.scanWaitlists.calls.length
    const discovery = probes.waitlistMaintenanceJobs.calls[0]?.result[0]
    if (!discovery) throw new Error('Missing the waitlist discovery job')
    await discovery.handler({}, run)
    expect(probes.scanWaitlists.calls[scanned]?.args[0].scimResourcesEnabled).toBe(enabled)
  })

  it('passes the setting through the workflow job callback', async () => {
    const execute = probes.workflowJobs.calls[0]?.args[3]
    if (!execute) throw new Error('Missing the workflow execution callback')
    const claim = { runId: randomUUID(), token: randomUUID() }
    await execute(claim)
    expect(
      probes.executeWorkflowClaim.calls.map(({ args: [ctx, executed] }) => ({
        enabled: ctx.scimResourcesEnabled,
        claim: executed,
      })),
    ).toEqual([{ enabled, claim }])
  })

  it('passes the setting to the SSO operator recovery email job', () => {
    expect(probes.ssoOperatorRecoveryEmailJob.calls.map(({ args }) => args[2])).toEqual([enabled])
  })

  it('passes the setting to the operator recovery CLI service', async () => {
    const operator = await entryPoint<typeof import('./sso-operator-recovery-cli.ts')>(
      './sso-operator-recovery-cli.ts',
      probes,
      ['disableSsoEnforcement'],
    )
    const organizationId = randomUUID()
    await expect(
      operator.runSsoOperatorRecovery([organizationId], {
        DATABASE_URL: owned.url,
        HOURMERE_SERVER_CONTAINER: '1',
        SCIM_PROVISIONING_ENABLED: setting,
      }),
    ).resolves.toBe(1)
    expect(probes.disableSsoEnforcement.calls.map(({ args }) => args.slice(2))).toEqual([
      [organizationId, enabled],
    ])
  })

  it('passes the setting to mapping consent email delivery', () => {
    expect(
      probes.mailboxProofJobs.calls.map(({ args: [deps] }) => deps.scimMappingConsentEnabled),
    ).toEqual([enabled])
  })
})
