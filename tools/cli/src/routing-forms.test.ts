import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { COMMANDS, HELP, runCli } from './cli.ts'

const commands = [
  ['list', 'list_routing_forms'],
  ['get', 'get_routing_form'],
  ['create', 'create_routing_form'],
  ['update', 'update_routing_form'],
  ['archive', 'archive_routing_form'],
  ['publish', 'publish_routing_form'],
  ['preview', 'preview_routing_form'],
] as const

const id = '019a0000-0000-7000-8000-000000000001'
const previewInput = { id, answers: { '019a0000-0000-7000-8000-000000000002': 'Example answer' } }
const publicInputs = [
  { handle: 'ada', slug: 'intake' },
  { teamSlug: 'TeamName', slug: 'intake' },
]

async function run(
  command: string,
  disabled = false,
  result?: object,
  inputPath = '-',
  input: Record<string, unknown> = command === 'preview'
    ? previewInput
    : { id, expectedRevision: 1 },
) {
  let stdout = ''
  let stderr = ''
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      jsonrpc: '2.0',
      id: 1,
      result: disabled
        ? {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: 'routing_forms_disabled' }) }],
          }
        : (result ?? { structuredContent: { id, revision: 2 } }),
    }),
  )
  const code = await runCli({
    argv: ['routing-forms', command, '--input', inputPath],
    env: { HOURMERE_URL: 'https://hourmere.example', HOURMERE_API_KEY: 'hm_routing_cli_test' },
    stdin: (async function* () {
      if (inputPath === '-') yield JSON.stringify(input)
    })(),
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    fetch: fetcher,
  })
  return { code, stdout, stderr, fetcher, input }
}

describe('routing form CLI commands', () => {
  it.each(commands)('dispatches %s through the shared MCP adapter', async (command, tool) => {
    const result = await run(command)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({ id, revision: 2 })
    expect(result.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
      name: tool,
      arguments: result.input,
    })
  })

  it.each(commands)('prints the hard-off error for %s without retrying', async (command) => {
    const result = await run(command, true)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr).error).toBe('routing_forms_disabled')
    expect(result.fetcher).toHaveBeenCalledTimes(1)
  })

  it('reads preview answers from a file and prints the draft diagnostics', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hourmere-cli-preview-'))
    const path = join(dir, 'preview.json')
    const diagnostics = {
      draftRevision: 2,
      matchedRuleId: 'fallback',
      resolvedRuleId: 'fallback',
      target: { kind: 'message', message: 'Thank you for your interest' },
      unavailableTargets: [],
      rules: [],
    }
    try {
      await writeFile(path, JSON.stringify(previewInput))
      const result = await run('preview', false, { structuredContent: diagnostics }, path)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toEqual(diagnostics)
      expect(result.fetcher).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
        name: 'preview_routing_form',
        arguments: previewInput,
      })
    } finally {
      await unlink(path).catch(() => {})
      await rmdir(dir)
    }
  })

  it('reads large publication replies and keeps the standard limit for other commands', async () => {
    // MCP sends both the current form and published version as structured JSON and text.
    const ruleContent = 'x'.repeat(3 * 1024 * 1024)
    const publication = { form: { ruleContent }, version: { ruleContent } }
    const reply = {
      structuredContent: publication,
      content: [{ type: 'text', text: JSON.stringify(publication) }],
    }
    const published = await run('publish', false, reply)
    expect(published.code).toBe(0)
    expect(published.stdout.length).toBe(JSON.stringify(publication, null, 2).length + 1)
    const other = await run('get', false, reply)
    expect(other.code).toBe(1)
    expect(JSON.parse(other.stderr).error).toBe('response_too_large')
  })

  it.each(publicInputs)('reads public metadata for %o through the MCP adapter', async (input) => {
    const metadata = { versionId: id, title: 'Intake', questions: [] }
    const result = await run('public', false, { structuredContent: metadata }, '-', input)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual(metadata)
    expect(result.fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(result.fetcher.mock.calls[0]?.[1]?.body)).params).toMatchObject({
      name: 'get_public_routing_form',
      arguments: input,
    })

    const disabled = await run('public', true, undefined, '-', input)
    expect(disabled.code).toBe(1)
    expect(disabled.stdout).toBe('')
    expect(JSON.parse(disabled.stderr)).toMatchObject({ error: 'routing_forms_disabled' })
    expect(disabled.fetcher).toHaveBeenCalledTimes(1)
  })

  it('advertises exactly the configuration and public metadata commands', () => {
    expect(Object.keys(COMMANDS).filter((command) => command.startsWith('routing-forms '))).toEqual(
      [...commands.map(([command]) => `routing-forms ${command}`), 'routing-forms public'],
    )
    expect(HELP).toContain('routing-forms list|get|create|update|archive|publish|preview|public')
    expect(HELP).toContain('Pass slug and exactly one of handle or teamSlug')
  })
})
