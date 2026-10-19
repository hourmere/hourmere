import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { MCP_REGISTRY_SCHEMA, validateMcpRegistry } from './validate-mcp-registry.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const script = fileURLToPath(new URL('./validate-mcp-registry.ts', import.meta.url))
const metadata = () => JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'))
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('MCP Registry launch metadata', () => {
  it('validates the draft against an unchanged official released schema', () => {
    const schema = readFileSync(
      new URL('./schemas/mcp-registry/server-2025-12-11.schema.json', import.meta.url),
    )
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      '3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0',
    )
    expect(validateMcpRegistry(metadata())).toEqual([])
    expect(metadata()).toMatchObject({
      $schema: MCP_REGISTRY_SCHEMA,
      name: 'io.github.hourmere/hourmere',
      remotes: [
        {
          type: 'streamable-http',
          url: 'https://{instance}/mcp',
          variables: { instance: { isRequired: true } },
        },
      ],
      _meta: {
        'io.modelcontextprotocol.registry/publisher-provided': {
          'com.hourmere': {
            publicationStatus: 'draft',
            oauth: { version: '2.1', enabledByDefault: false },
          },
        },
      },
    })
  })

  it.each([
    ['invalid namespace', (draft: ReturnType<typeof metadata>) => (draft.name = 'hourmere')],
    [
      'overlong description',
      (draft: ReturnType<typeof metadata>) => (draft.description = 'x'.repeat(101)),
    ],
    [
      'invalid transport',
      (draft: ReturnType<typeof metadata>) => (draft.remotes[0].type = 'stdio'),
    ],
    ['missing version', (draft: ReturnType<typeof metadata>) => delete draft.version],
  ])('rejects %s using the official schema', (_name, mutate) => {
    const draft = metadata()
    mutate(draft)
    expect(validateMcpRegistry(draft)).toContain('Official MCP Registry schema validation failed.')
  })

  it('rejects schema drift', () => {
    const draft = metadata()
    draft.$schema = 'https://example.com/other.schema.json'
    expect(validateMcpRegistry(draft)).toContain('Use the pinned MCP Registry schema.')
  })

  it.each([
    ['wrong header', { name: 'X-API-Key' }],
    ['optional input', { isRequired: false }],
    ['non-secret input', { isSecret: false }],
    ['embedded value', { value: 'synthetic-private-marker' }],
    ['embedded default', { default: 'synthetic-private-marker' }],
  ])('rejects an Authorization %s', (_name, change) => {
    const draft = metadata()
    Object.assign(draft.remotes[0].headers[0], change)
    const errors = validateMcpRegistry(draft)
    expect(errors).toContain(
      'Describe one Streamable HTTP remote with a required secret Authorization input.',
    )
    expect(errors.join(' ')).not.toContain('synthetic-private-marker')
  })

  it('rejects missing or extra remote/header descriptions', () => {
    const draft = metadata()
    draft.remotes.push(structuredClone(draft.remotes[0]))
    expect(validateMcpRegistry(draft)).toHaveLength(1)
    draft.remotes.pop()
    draft.remotes[0].headers.push(structuredClone(draft.remotes[0].headers[0]))
    expect(validateMcpRegistry(draft)).toHaveLength(1)
    draft.remotes[0].headers = []
    expect(validateMcpRegistry(draft)).toHaveLength(1)
  })

  it('rejects schema-valid SSE metadata for this Streamable HTTP server', () => {
    const draft = metadata()
    draft.remotes[0].type = 'sse'
    expect(validateMcpRegistry(draft)).toContain(
      'Describe one Streamable HTTP remote with a required secret Authorization input.',
    )
  })

  it('requires owner approval independently of replacing the placeholder', () => {
    const draft = metadata()
    draft.remotes[0].url = 'https://calendar.hourmere.com/mcp'
    expect(validateMcpRegistry(draft, true)).toContain(
      'Submission requires owner approval and a concrete HTTPS /mcp URL.',
    )
  })

  it.each([
    'https://{instance}/mcp',
    'http://calendar.hourmere.com/mcp',
    'https://calendar.hourmere.com/',
  ])('requires a concrete HTTPS /mcp URL independently of approval: %s', (url) => {
    const draft = metadata()
    draft._meta['io.modelcontextprotocol.registry/publisher-provided'][
      'com.hourmere'
    ].publicationStatus = 'owner-approved'
    draft.remotes[0].url = url
    expect(validateMcpRegistry(draft, true)).toContain(
      'Submission requires owner approval and a concrete HTTPS /mcp URL.',
    )
  })

  it('can check an owner-prepared copy without asserting the endpoint is live', () => {
    const draft = metadata()
    draft._meta['io.modelcontextprotocol.registry/publisher-provided'][
      'com.hourmere'
    ].publicationStatus = 'owner-approved'
    draft.remotes[0].url = 'https://calendar.hourmere.com/mcp'
    expect(validateMcpRegistry(draft, true)).toEqual([])
  })

  it('validates offline from the CLI and refuses the draft submission check', () => {
    const draft = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' })
    expect(draft.status).toBe(0)
    expect(draft.stdout).toContain('No publication or live check performed.')
    const submission = spawnSync(process.execPath, [script, '--for-submission'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(submission.status).toBe(1)
    expect(submission.stderr).toContain('Submission requires owner approval')
  })

  it('does not echo invalid JSON or literal credentials in CLI diagnostics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hourmere-mcp-metadata-'))
    dirs.push(dir)
    const path = join(dir, 'server.json')
    for (const input of ['{"private123":}', JSON.stringify({ name: 'private123' })]) {
      writeFileSync(path, input)
      const result = spawnSync(process.execPath, [script, path], { cwd: root, encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('private123')
    }
  })
})
