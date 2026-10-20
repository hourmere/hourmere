import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Principal } from '@hourmere/auth'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from '../../../tools/cli/src/cli.ts'
import { createApp } from './app.ts'
import { mcpEndpoint } from './mcp/endpoint.ts'

const root = new URL('../../../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  version: string
}
const principal: Principal = {
  kind: 'api_key',
  apiKeyId: '00000000-0000-7000-8000-000000000001',
  user: { id: '00000000-0000-7000-8000-000000000002', name: 'Ada', email: 'ada@example.com' },
  organization: {
    id: '00000000-0000-7000-8000-000000000003',
    name: 'Ada',
    slug: 'ada',
    personal: true,
  },
}
const app = createApp({
  checkDb: async () => {},
  publicUrl: 'http://localhost:3000',
  authHandler: async () => new Response(null, { status: 404 }),
  resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
  mcp: mcpEndpoint({ tools: [] }),
})

describe('release version surfaces', () => {
  it('serves the canonical version in the OpenAPI document', async () => {
    const response = await app.request('/api/v1/openapi.json')
    expect(response.status).toBe(200)
    const doc = (await response.json()) as { info: { version: string } }
    expect(doc.info.version).toBe(manifest.version)
  })

  it('serves the canonical version in the MCP initialize response', async () => {
    const response = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer hm_version_test',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'version-test', version: '1.0.0' },
        },
      }),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    const message = JSON.parse(
      response.headers.get('content-type')?.startsWith('text/event-stream')
        ? (body
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6) ?? 'null')
        : body,
    ) as { result: { serverInfo: { version: string } } }
    expect(message.result.serverInfo.version).toBe(manifest.version)
  })

  it('prints the canonical version from the CLI executable', () => {
    const stdout = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('tools/cli/src/index.ts', root)), '--version'],
      { encoding: 'utf8', env: { PATH: process.env.PATH } },
    )
    expect(stdout).toBe(`${manifest.version}\n`)
  })

  it('sends the canonical version in the CLI User-Agent', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: { ok: true } } }),
    )
    const code = await runCli({
      argv: ['whoami'],
      env: { HOURMERE_URL: 'https://hourmere.example', HOURMERE_API_KEY: 'hm_version_test' },
      stdin: (async function* () {})(),
      stdout: () => {},
      stderr: () => {},
      fetch: fetcher,
    })
    expect(code).toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('user-agent')).toBe(
      `hourmere-cli/${manifest.version}`,
    )
  })

  it('keeps registry, CLI and npm lock metadata at the canonical version', () => {
    const registry = JSON.parse(readFileSync(new URL('server.json', root), 'utf8')) as {
      version: string
    }
    const cli = JSON.parse(readFileSync(new URL('tools/cli/package.json', root), 'utf8')) as {
      version: string
    }
    const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8')) as {
      version: string
      packages: Record<string, { version?: string }>
    }
    expect({
      registry: registry.version,
      cli: cli.version,
      lock: lock.version,
      rootPackageLock: lock.packages['']?.version,
      cliPackageLock: lock.packages['tools/cli']?.version,
    }).toEqual({
      registry: manifest.version,
      cli: manifest.version,
      lock: manifest.version,
      rootPackageLock: manifest.version,
      cliPackageLock: manifest.version,
    })
  })
})
