import { constants, readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'
import * as client from './client.ts'

const secret = 'https://hooks.slack.com/services/Tfixture/Bfixture/private-fixture-secret'
// Single- and multi-line import declarations; the bindings below supply their values.
const imports = /^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm
async function verify(command: string, runner = runCli) {
  let output = ''
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { url: secret } } }),
  )
  const code = await runner({
    argv: ['slack', command, '--input', '-'],
    env: { HOURMERE_URL: 'https://hourmere.example', HOURMERE_API_KEY: 'hm_fixture' },
    stdin: (async function* () {
      yield JSON.stringify({ url: secret })
    })(),
    stdout: (text) => {
      output += text
    },
    stderr: (text) => {
      output += text
    },
    fetch: fetcher,
  })
  expect(code).toBe(0)
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).params.name).toBe(
    `${command}_slack_destination${command === 'list' ? 's' : ''}`,
  )
  expect(output).not.toContain(secret)
  expect(output).toContain('[redacted]')
}
it.each(['create', 'list', 'update', 'delete', 'test'])(
  'dispatches slack %s and redacts supplied URL',
  (command) => verify(command),
)
it('source-copy mutation detects missing URL redaction', async () => {
  let source = readFileSync('tools/cli/src/cli.ts', 'utf8')
  const anchor = 'if (slackUrl) secrets.push(slackUrl)'
  expect(source).toContain(anchor)
  const baseline = source
  source = source.replace(anchor, '')
  source = stripTypeScriptTypes(source.replace(imports, '')).replace(/\bexport /g, '')
  const bindings = { constants, ...client, open }
  const mutant = new Function(...Object.keys(bindings), `${source}; return runCli`)(
    ...Object.values(bindings),
  ) as typeof runCli
  const baselineScript = stripTypeScriptTypes(baseline.replace(imports, '')).replace(
    /\bexport /g,
    '',
  )
  const control = new Function(...Object.keys(bindings), `${baselineScript}; return runCli`)(
    ...Object.values(bindings),
  ) as typeof runCli
  await verify('create', control)
  await expect(verify('create', mutant)).rejects.toMatchObject({ name: 'AssertionError' })
})
