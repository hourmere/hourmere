import { readFileSync } from 'node:fs'
import { API_KEY_CLI_OPERATIONS, API_KEY_MCP_OPERATIONS } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../apps/server/src/app.ts'
import { mcpEndpoint } from '../apps/server/src/mcp/endpoint.ts'
import { openApiRouteInventory } from '../apps/server/src/openapi-document.ts'
import { productTools } from '../apps/server/src/server.ts'
import { runCli } from '../tools/cli/src/cli.ts'

function read(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

const guide = read('docs/meeting-polls-api.md')
const publicUrl = 'https://poll-docs.example.test'
type Schema = Record<string, unknown>
type JsonContent = { content: Record<string, { schema: Schema }> }
type OpenApiDocument = {
  components: { schemas: Record<string, Schema> }
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: { name: string; in: string; required?: boolean; schema: Schema }[]
        requestBody?: JsonContent
        responses: Record<string, JsonContent>
      }
    >
  >
}
type Inventory = {
  openapi: OpenApiDocument
  routes: Set<string>
  tools: Map<string, Schema>
  commands: Set<string>
}

async function publishedTools() {
  const app = createApp({
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({
      ok: true,
      setCookie: [],
      principal: {
        kind: 'api_key',
        apiKeyScope: 'full',
        apiKeyId: 'docs-test',
        user: { id: 'docs-test-user', name: 'Docs tester', email: 'docs@example.test' },
        organization: { id: 'docs-test-space', name: 'Docs', slug: 'docs', personal: true },
      },
    }),
    publicUrl,
    mcp: mcpEndpoint({ tools: productTools({ db: {} as Db, publicUrl }) }),
  })
  const client = new Client({ name: 'poll-docs-test', version: '1.0.0' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', publicUrl), {
        fetch: async (input, init) => app.request(input, init),
        requestInit: { headers: { authorization: 'Bearer hm_docs_test' } },
      }),
    )
    return new Map((await client.listTools()).tools.map((tool) => [tool.name, tool.inputSchema]))
  } finally {
    await client.close()
  }
}

async function cliCommands() {
  let help = ''
  expect(
    await runCli({
      argv: ['--help'],
      env: {},
      stdin: (async function* () {})(),
      stdout: (text) => {
        help += text
      },
      stderr: (text) => expect.fail(text),
    }),
  ).toBe(0)
  return new Set(
    [...help.matchAll(/hourmere polls ([\w|-]+) --input -/g)].flatMap(([, names = '']) =>
      names.split('|'),
    ),
  )
}

function checkOperation(inventory: Inventory, method: string, path: string) {
  const operation = inventory.openapi.paths[path]?.[method.toLowerCase()]
  const label = `${method} ${path}`
  expect(operation, `${label} in generated OpenAPI`).toBeDefined()
  expect(inventory.routes, `${label} in registered routes`).toContain(label)
  return operation
}

function checkOperations(source: string, inventory: Inventory) {
  const rows = [
    ...source.matchAll(/^\| `?([A-Z]+) `?(\/api\/v1\/\S+?)` \| `(\w+)` \| `([\w-]+)` \|/gm),
  ]
  expect(rows.length).toBeGreaterThan(0)
  const documentedRoutes = new Set<string>()
  const documentedCommands = new Set<string>()
  for (const [, method = '', path = '', tool = '', command = ''] of rows) {
    checkOperation(inventory, method, path)
    expect(inventory.tools.has(tool), `${tool} in tools/list`).toBe(true)
    expect(inventory.commands, `polls ${command} in CLI help`).toContain(command)
    const route = `${method} ${path}`
    expect(API_KEY_MCP_OPERATIONS.find((entry) => entry.tool === tool)?.rest, tool).toContain(route)
    expect(API_KEY_CLI_OPERATIONS.find((entry) => entry.command === `polls ${command}`)?.tool).toBe(
      tool,
    )
    documentedRoutes.add(route)
    documentedCommands.add(command)
  }
  expect(documentedRoutes).toEqual(inventory.routes)
  expect(documentedCommands).toEqual(inventory.commands)
}

function checkJson(schema: Schema | undefined, example: unknown, label: string, root?: Schema) {
  expect(schema, `${label} schema`).toBeDefined()
  const ajv = new Ajv2020({ strict: false })
  addFormats.default(ajv)
  const validate = ajv.compile({ ...schema, ...root })
  expect(validate(example), `${label}: ${ajv.errorsText(validate.errors)}`).toBe(true)
}

function blocks(language: string) {
  // Read the published examples themselves so edits to the guide always exercise the check.
  return [...guide.matchAll(new RegExp(`^\`{3}${language}\\n([\\s\\S]*?)^\`{3}$`, 'gm'))].map(
    ([, block = '']) => block.trim(),
  )
}

describe('published meeting poll operations and examples', () => {
  let inventory: Inventory

  beforeAll(async () => {
    const [{ document, routes }, tools, commands] = await Promise.all([
      openApiRouteInventory(),
      publishedTools(),
      cliCommands(),
    ])
    inventory = {
      openapi: document as OpenApiDocument,
      routes: new Set(
        routes
          .filter(
            ({ method, path }) =>
              method !== 'ALL' && /^\/api\/v1\/(?:public\/)?meeting-polls(?:\/|$)/.test(path),
          )
          .map(({ method, path }) => `${method} ${path.replace(/:(\w+)/g, '{$1}')}`),
      ),
      tools,
      commands,
    }
  })

  it('lists the registered REST routes, discoverable MCP tools and advertised CLI commands', () => {
    checkOperations(guide, inventory)
  })

  it('keeps the technical reference and transport guides on published operations', () => {
    checkOperations(read('docs/meeting-polls.md'), inventory)
    for (const path of [
      'docs/mcp.md',
      'tools/cli/README.md',
      'apps/site/src/content/docs/docs/rest.md',
      'apps/site/src/content/docs/docs/mcp.md',
      'apps/site/src/content/docs/docs/cli.md',
    ]) {
      const source = read(path)
      for (const [, method = '', route = ''] of source.matchAll(
        /\b(GET|POST|DELETE|PATCH|PUT) `?(\/api\/v1\/(?:public\/)?meeting-polls[^\s`|]*)/g,
      )) {
        checkOperation(inventory, method, route)
      }
      for (const [tool] of source.matchAll(/(?<=`)\w+_meeting_poll\w*(?=`)/g)) {
        expect(inventory.tools.has(tool), `${path}: ${tool} in tools/list`).toBe(true)
      }
      for (const [, names = ''] of source.matchAll(
        /(?<=`)hourmere polls ([\w|-]+) --input -(?=`)/g,
      )) {
        for (const command of names.split('|')) {
          expect(inventory.commands, `${path}: polls ${command} in CLI help`).toContain(command)
        }
      }
      for (const [, command = ''] of source.matchAll(/(?<=`)polls ([\w-]+)(?=`)/g)) {
        expect(inventory.commands, `${path}: polls ${command} in CLI help`).toContain(command)
      }
    }
  })

  it('validates HTTP requests and responses with the generated OpenAPI schemas', () => {
    const examples = blocks('http')
    expect(examples.length).toBeGreaterThan(0)
    let lastRequest: ReturnType<typeof checkOperation>
    for (const example of examples) {
      const [head = '', body = ''] = example.split('\n\n')
      const [line = '', ...headers] = head.split('\n')
      expect(headers).toContain('Content-Type: application/json')
      const response = line.match(/^HTTP\/1\.1 (\d{3}) /)
      const root = { components: inventory.openapi.components }
      if (response) {
        expect(lastRequest, `${line} follows a request`).toBeDefined()
        checkJson(
          lastRequest?.responses[response[1] ?? '']?.content['application/json']?.schema,
          JSON.parse(body),
          line,
          root,
        )
        continue
      }
      const [method = '', path = ''] = line.split(' ')
      lastRequest = checkOperation(inventory, method, path)
      checkJson(
        lastRequest?.requestBody?.content['application/json']?.schema,
        JSON.parse(body),
        line,
        root,
      )
      const suppliedHeaders = new Headers(
        headers.map((header) => {
          const colon = header.indexOf(':')
          return [header.slice(0, colon), header.slice(colon + 1).trim()]
        }),
      )
      for (const parameter of lastRequest?.parameters ?? []) {
        if (parameter.in !== 'header') continue
        const value = suppliedHeaders.get(parameter.name)
        if (parameter.required || value !== null)
          checkJson(parameter.schema, value, parameter.name, root)
      }
    }
  })

  it('validates the MCP calls against the input schema returned by tools/list', () => {
    const examples = blocks('json')
    expect(examples.length).toBeGreaterThan(0)
    for (const example of examples) {
      const call = JSON.parse(example)
      expect(call).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', id: expect.any(Number) })
      const { name, arguments: args } = call.params
      checkJson(inventory.tools.get(name), args, name)
    }
  })

  it('dispatches the published CLI invocation through the real CLI and validates its MCP input', async () => {
    const examples = blocks('sh')
    expect(examples.length).toBeGreaterThan(0)
    for (const example of examples) {
      const [invocation = '', ...stdin] = example.split('\n')
      expect(invocation).toMatch(/^hourmere polls [\w-]+ --input - <<'JSON'$/)
      expect(stdin.pop()).toBe('JSON')
      const argv = invocation.split(' ').slice(1, -1)
      const command = argv[1] ?? ''
      expect(inventory.commands).toContain(command)
      const input = stdin.join('\n')
      let called = false
      expect(
        await runCli({
          argv,
          env: { HOURMERE_URL: publicUrl, HOURMERE_API_KEY: 'hm_docs_test' },
          stdin: (async function* () {
            yield input
          })(),
          stdout: () => {},
          stderr: (text) => expect.fail(text),
          fetch: async (_url, request) => {
            const call = JSON.parse(String(request?.body))
            const { name, arguments: args } = call.params
            expect(call.method).toBe('tools/call')
            expect(args).toEqual(JSON.parse(input))
            checkJson(inventory.tools.get(name), args, name)
            called = true
            return Response.json({ jsonrpc: '2.0', id: call.id, result: { structuredContent: {} } })
          },
        }),
      ).toBe(0)
      expect(called).toBe(true)
    }
  })

  it.each([
    [
      '/api/v1/meeting-polls/{id}/results',
      '/api/v1/meeting-polls/{id}/summary',
      'in generated OpenAPI',
    ],
    ['`get_meeting_poll_results`', '`summarize_meeting_poll`', 'in tools/list'],
    ['`results` |', '`summary` |', 'in CLI help'],
  ])('rejects a source copy with an unshipped operation in %s', (original, replacement, error) => {
    const mutated = guide.replace(original, replacement)
    expect(mutated).not.toBe(guide)
    expect(() => checkOperations(mutated, inventory)).toThrow(error)
  })
})
