import { constants, readFileSync } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'
import * as client from './client.ts'

const args = {
  eventTypeId: '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f',
  date: '2030-11-04',
  timeZone: 'Europe/Berlin',
  durationMinutes: 30,
}
const explanation = {
  eventTypeId: args.eventTypeId,
  date: args.date,
  timeZone: args.timeZone,
  durationMinutes: 30,
  rangeStart: '2030-11-03T23:00:00Z',
  rangeEnd: '2030-11-04T23:00:00Z',
  hosts: [],
  slots: [
    {
      start: '2030-11-04T08:00:00Z',
      end: '2030-11-04T08:30:00Z',
      status: 'unavailable',
      reasons: [
        { code: 'calendar_busy', start: '2030-11-04T08:00:00Z', end: '2030-11-04T08:30:00Z' },
      ],
    },
  ],
}
async function verify(runner = runCli) {
  let stdout = ''
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: explanation } }),
  )
  const code = await runner({
    argv: ['troubleshoot-availability', '--input', '-'],
    env: { HOURMERE_URL: 'https://example.test', HOURMERE_API_KEY: 'hm_test' },
    stdin: (async function* () {
      yield JSON.stringify(args)
    })(),
    stdout: (text) => {
      stdout += text
    },
    stderr: () => {},
    fetch: fetcher,
  })
  expect(code).toBe(0)
  expect(JSON.parse(stdout)).toEqual(explanation)
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
    name: 'troubleshoot_availability',
    arguments: args,
  })
}
function copy(change?: [string, string]): typeof runCli {
  let source = readFileSync('tools/cli/src/cli.ts', 'utf8')
  if (change) {
    expect(source).toContain(change[0])
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = { constants, open, unlink, ...client }
  return new Function(...Object.keys(bindings), `${source}; return runCli`)(
    ...Object.values(bindings),
  )
}
it('forwards the day, zone and length and prints the explanation unchanged', () => verify())
it('checks unchanged source and kills changed dispatch and lost output', async () => {
  await verify(copy())
  for (const change of [
    [
      "'troubleshoot-availability': 'troubleshoot_availability'",
      "'troubleshoot-availability': 'find_available_slots'",
    ],
    [
      'options.stdout(printable(result, [...secrets, token]))',
      'options.stdout(printable({}, [...secrets, token]))',
    ],
  ] as [string, string][]) {
    await expect(verify(copy(change))).rejects.toMatchObject({ name: 'AssertionError' })
  }
})
