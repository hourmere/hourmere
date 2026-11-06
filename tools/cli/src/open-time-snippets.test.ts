import { constants, readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'
import * as client from './client.ts'

const args = {
  slug: 'chat',
  from: '2030-11-04T00:00:00Z',
  to: '2030-11-11T00:00:00Z',
  count: 3,
  locale: 'zh-CN',
  displayTimeZone: 'America/New_York',
}
const snippet = {
  text: '可预约时间',
  html: '<p>可预约时间</p>',
  slots: [{ url: 'https://example.test/host/chat?start=2030-11-04T09%3A00%3A00Z' }],
}
async function verify(runner = runCli) {
  let stdout = ''
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: snippet } }),
  )
  const code = await runner({
    argv: ['open-time-snippet', '--json', '--input', '-'],
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
  expect(JSON.parse(stdout)).toEqual(snippet)
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
    name: 'generate_open_time_snippet',
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
  const bindings = { constants, open, ...client }
  return new Function(...Object.keys(bindings), `${source}; return runCli`)(
    ...Object.values(bindings),
  )
}
it('forwards snippet options and prints both formats with explicit --json', () => verify())
it('checks unchanged source and kills changed dispatch and lost output', async () => {
  await verify(copy())
  for (const change of [
    [
      "'open-time-snippet': 'generate_open_time_snippet'",
      "'open-time-snippet': 'find_available_slots'",
    ],
    [
      'options.stdout(printable(result, [...secrets, token]))',
      'options.stdout(printable({}, [...secrets, token]))',
    ],
  ] as [string, string][]) {
    await expect(verify(copy(change))).rejects.toMatchObject({ name: 'AssertionError' })
  }
})
