import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import * as scheduling from '@hourmere/scheduling'
import { describe, expect, it, vi } from 'vitest'
import { ScheduleAvailability, ScheduleAvailabilityInput } from '../routes/schedules.ts'
import type { catalogTools } from './catalog.ts'
import { defineTool, type McpCaller } from './tools.ts'

const source = readFileSync(new URL('./catalog.ts', import.meta.url), 'utf8')
const id = '019a0000-0000-7000-8000-000000000001'
function copy(replacement?: [string, string]) {
  let text = source
  if (replacement) {
    expect(text).toContain(replacement[0])
    text = text.replace(...replacement)
  }
  const saveScheduleAvailability = vi.fn(async () => ({}))
  const deps = {
    ...scheduling,
    z,
    defineTool,
    saveScheduleAvailability,
    EventType: z.object({}),
    Profile: z.object({}),
    Schedule: z.object({}),
    ScheduleAvailability: { ...ScheduleAvailability, parse: (value: unknown) => value },
    ScheduleAvailabilityInput,
  }
  const body = stripTypeScriptTypes(text.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /^export /gm,
    '',
  )
  const factory = new Function(...Object.keys(deps), `${body}; return catalogTools`)(
    ...Object.values(deps),
  ) as typeof catalogTools
  const tool = factory({ db: {} as Db }).find((tool) => tool.name === 'save_schedule_availability')
  if (!tool) throw new Error('Missing availability tool')
  return { tool, saveScheduleAvailability }
}
async function verifyForwarding(value: ReturnType<typeof copy>) {
  const input = {
    name: 'Hours',
    timeZone: 'UTC',
    weeklyHours: { monday: [] },
    overrides: [{ date: '2026-12-25', intervals: [] }],
    expectedVersion: 'a'.repeat(64),
  }
  const caller = { kind: 'api_key', apiKeyScope: 'full' } as McpCaller
  await value.tool.run(value.tool.input.parse({ id, ...input }), { caller, rateLimit: () => {} })
  expect(value.saveScheduleAvailability).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ principal: caller }),
    id,
    input,
  )
}
describe('availability MCP source-copy protections', () => {
  it('forwards the complete replacement and revision unchanged', async () => {
    await verifyForwarding(copy())
  })
  it('detects dropping overrides before the atomic service', async () => {
    await expect(
      verifyForwarding(
        copy([
          'saveScheduleAvailability(context(call.caller), id, input)',
          'saveScheduleAvailability(context(call.caller), id, { ...input, overrides: [] })',
        ]),
      ),
    ).rejects.toThrow()
  })
  it('detects replacing the caller revision', async () => {
    await expect(
      verifyForwarding(
        copy([
          'saveScheduleAvailability(context(call.caller), id, input)',
          "saveScheduleAvailability(context(call.caller), id, { ...input, expectedVersion: 'wrong' })",
        ]),
      ),
    ).rejects.toThrow()
  })
})
