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
const approvedMetadata = () => {
  const draft = metadata()
  draft._meta['io.modelcontextprotocol.registry/publisher-provided'][
    'com.hourmere'
  ].publicationStatus = 'owner-approved'
  return draft
}
const templateError =
  'Submission requires owner approval and an HTTPS /mcp URL template with declared variables.'
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
          url: 'https://{hourmere_host}/mcp',
          variables: { hourmere_host: { isRequired: true } },
          headers: [
            {
              name: 'Authorization',
              description: 'Bearer API key; omit when the client uses OAuth',
              isRequired: false,
              isSecret: true,
            },
          ],
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

  it.each(['draft', 'concrete', 'template'] as const)(
    'keeps the static API-key header optional for OAuth clients in %s mode',
    (mode) => {
      const draft = mode === 'draft' ? metadata() : approvedMetadata()
      if (mode === 'concrete') draft.remotes[0].url = 'https://hourmere.example.invalid/mcp'
      expect(draft.remotes[0].headers[0].isRequired).toBe(false)
      expect(validateMcpRegistry(draft, mode)).toEqual([])

      draft.remotes[0].headers[0].isRequired = true
      expect(validateMcpRegistry(draft, mode)).toContain(
        'Describe one Streamable HTTP remote with an optional secret Authorization input.',
      )
    },
  )

  it.each([
    ['wrong header', { name: 'X-API-Key' }],
    ['required input', { isRequired: true }],
    ['non-secret input', { isSecret: false }],
    ['embedded value', { value: 'synthetic-private-marker' }],
    ['embedded default', { default: 'synthetic-private-marker' }],
  ])('rejects an Authorization %s', (_name, change) => {
    const draft = metadata()
    Object.assign(draft.remotes[0].headers[0], change)
    const errors = validateMcpRegistry(draft)
    expect(errors).toContain(
      'Describe one Streamable HTTP remote with an optional secret Authorization input.',
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
      'Describe one Streamable HTTP remote with an optional secret Authorization input.',
    )
  })

  it('requires owner approval independently of replacing the placeholder', () => {
    const draft = metadata()
    draft.remotes[0].url = 'https://calendar.hourmere.com/mcp'
    expect(validateMcpRegistry(draft, 'concrete')).toContain(
      'Submission requires owner approval and a concrete HTTPS /mcp URL.',
    )
  })

  it.each([
    'https://{hourmere_host}/mcp',
    'http://calendar.hourmere.com/mcp',
    'https://calendar.hourmere.com/',
  ])('requires a concrete HTTPS /mcp URL independently of approval: %s', (url) => {
    const draft = metadata()
    draft._meta['io.modelcontextprotocol.registry/publisher-provided'][
      'com.hourmere'
    ].publicationStatus = 'owner-approved'
    draft.remotes[0].url = url
    expect(validateMcpRegistry(draft, 'concrete')).toContain(
      'Submission requires owner approval and a concrete HTTPS /mcp URL.',
    )
  })

  it('can check an owner-prepared copy without asserting the endpoint is live', () => {
    const draft = metadata()
    draft._meta['io.modelcontextprotocol.registry/publisher-provided'][
      'com.hourmere'
    ].publicationStatus = 'owner-approved'
    draft.remotes[0].url = 'https://calendar.hourmere.com/mcp'
    expect(validateMcpRegistry(draft, 'concrete')).toEqual([])
  })

  it('requires owner approval for a template submission', () => {
    expect(validateMcpRegistry(metadata(), 'template')).toContain(templateError)
  })

  it('rejects a template submission without a remote', () => {
    const draft = approvedMetadata()
    delete draft.remotes
    expect(validateMcpRegistry(draft, 'template')).toContain(templateError)
  })

  it.each([
    'https://{hourmere_host}/mcp',
    'https://{hourmere_host}.example.invalid/mcp',
    'https://{hourmere_host}:{port}/mcp',
  ])('accepts an approved declared URL template offline: %s', (url) => {
    const draft = approvedMetadata()
    draft.remotes[0].url = url
    draft.remotes[0].variables.port = { isRequired: true }
    expect(validateMcpRegistry(draft, 'template')).toEqual([])
  })

  it.each([
    [
      'missing variables',
      (draft: ReturnType<typeof metadata>) => delete draft.remotes[0].variables,
    ],
    [
      'undeclared variable',
      (draft: ReturnType<typeof metadata>) => (draft.remotes[0].url = 'https://{other_host}/mcp'),
    ],
    [
      'concrete URL',
      (draft: ReturnType<typeof metadata>) =>
        (draft.remotes[0].url = 'https://hourmere.example.invalid/mcp'),
    ],
    [
      'malformed placeholder',
      (draft: ReturnType<typeof metadata>) =>
        (draft.remotes[0].url = 'https://{hourmere_host}}/mcp'),
    ],
  ])('rejects a template submission with a %s', (_name, mutate) => {
    const draft = approvedMetadata()
    mutate(draft)
    expect(validateMcpRegistry(draft, 'template')).toContain(templateError)
  })

  it.each([
    'http://{hourmere_host}/mcp',
    'https://{hourmere_host}/',
    'https://{hourmere_host}/mcp?path=/mcp',
    'https://{hourmere_host}/mcp#path=/mcp',
    'https://{hourmere_host}.localhost/mcp',
  ])('rejects an unsuitable substituted template URL: %s', (url) => {
    const draft = approvedMetadata()
    draft.remotes[0].url = url
    expect(validateMcpRegistry(draft, 'template')).toContain(templateError)
  })

  it.each([
    'https://localhost/mcp',
    'https://api.localhost/mcp',
    'https://127.0.0.1/mcp',
    'https://[::1]/mcp',
    'https://not^a-host/mcp',
  ])('rejects a local or malformed concrete submission URL: %s', (url) => {
    const draft = approvedMetadata()
    draft.remotes[0].url = url
    expect(validateMcpRegistry(draft, 'concrete')).toContain(
      'Submission requires owner approval and a concrete HTTPS /mcp URL.',
    )
  })

  it('selects the template submission mode explicitly from the CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hourmere-mcp-template-'))
    dirs.push(dir)
    const path = join(dir, 'server.json')
    writeFileSync(path, JSON.stringify(approvedMetadata()))
    const template = spawnSync(process.execPath, [script, path, '--for-template-submission'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(template.status).toBe(0)
    expect(template.stdout).toContain('No publication or live check performed.')
    const concrete = spawnSync(process.execPath, [script, path, '--for-submission'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(concrete.status).toBe(1)
    const unapproved = spawnSync(process.execPath, [script, '--for-template-submission'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(unapproved.status).toBe(1)
    expect(unapproved.stderr).toContain(templateError)
  })

  it('rejects conflicting submission mode flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hourmere-mcp-modes-'))
    dirs.push(dir)
    const path = join(dir, 'server.json')
    writeFileSync(path, JSON.stringify(approvedMetadata()))
    const result = spawnSync(
      process.execPath,
      [script, path, '--for-submission', '--for-template-submission'],
      { cwd: root, encoding: 'utf8' },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Usage:')
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
