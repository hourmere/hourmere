import { AsyncLocalStorage } from 'node:async_hooks'
import { tracingChannel } from 'node:diagnostics_channel'
import { readFileSync } from 'node:fs'
import { createServer, Server as HttpServer, request } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { createConnection, createServer as createTcpServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import type { startServer } from '../apps/server/src/server.ts'
import { startFixtureServer } from '../tools/e2e/fixture-server.ts'
import { listenOwned, trackOwned } from '../tools/e2e/listeners.ts'

type Start = typeof startFixtureServer
function sourceCopy(replacement: [string, string]): Start {
  let source = readFileSync('tools/e2e/fixture-server.ts', 'utf8')
  expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
  source = source.replace(...replacement).replace(/^import .*\n/gm, '')
  source = stripTypeScriptTypes(source).replace(/\bexport (?=(?:async )?function)/g, '')
  return new Function(
    'AsyncLocalStorage',
    'tracingChannel',
    'HttpServer',
    'createConnection',
    'trackOwned',
    'startServer',
    `${source}; return startFixtureServer`,
  )(AsyncLocalStorage, tracingChannel, HttpServer, createConnection, trackOwned, undefined) as Start
}

async function exercise(start: Start = startFixtureServer, leaveBackendOpen = false) {
  const listener = await listenOwned(createTcpServer({ allowHalfOpen: true }))
  let backend: HttpServer | undefined
  const startup: typeof startServer = async (env = {}) => {
    expect(env.PORT, 'Only the production listener chooses its backend port').toBe('0')
    expect(env.PUBLIC_URL, 'Public origin is already bound').toBe(listener.url)
    // Overlap startups so diagnostics from another fixture must be ignored.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const server = createServer((incoming, response) => {
      const body: Buffer[] = []
      incoming.on('data', (chunk) => body.push(chunk))
      incoming.on('end', () => {
        response.setHeader('Location', `${env.PUBLIC_URL}/next`)
        response.end(
          JSON.stringify({
            method: incoming.method,
            path: incoming.url,
            host: incoming.headers.host,
            origin: incoming.headers.origin,
            body: Buffer.concat(body).toString(),
          }),
        )
      })
    })
    backend = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test backend')
    return {
      port: address.port,
      close: async () => {
        if (!leaveBackendOpen)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          )
      },
    }
  }
  try {
    const app = await start(listener, {}, startup)
    expect(app.port).toBe(listener.port)
    const result = await new Promise<{ location: string | undefined; body: string }>(
      (resolve, reject) => {
        const outgoing = request(
          `${listener.url}/fixture?query=preserved`,
          { method: 'POST', agent: false, headers: { origin: listener.url } },
          (response) => {
            const chunks: Buffer[] = []
            response.on('data', (chunk) => chunks.push(chunk))
            response.on('end', () =>
              resolve({
                location: response.headers.location,
                body: Buffer.concat(chunks).toString(),
              }),
            )
          },
        )
        outgoing.once('error', reject)
        outgoing.end('unchanged request body')
      },
    )
    expect(result.location).toBe(`${listener.url}/next`)
    expect(JSON.parse(result.body)).toEqual({
      method: 'POST',
      path: '/fixture?query=preserved',
      host: new URL(listener.url).host,
      origin: listener.url,
      body: 'unchanged request body',
    })
    if (leaveBackendOpen) {
      await expect(app.close()).rejects.toThrow('emit close')
      expect(backend?.listening).toBe(true)
    } else {
      await app.close()
      expect(backend?.listening).toBe(false)
      expect(backend?.address()).toBe(null)
    }
  } finally {
    backend?.closeAllConnections()
    if (backend?.listening) await new Promise<void>((resolve) => backend?.close(() => resolve()))
    await listener.close()
  }
}

async function verifyBackendValidation(
  mode: 'count' | 'mismatch' | 'forbidden',
  start: Start = startFixtureServer,
) {
  const listener = await listenOwned(createTcpServer({ allowHalfOpen: true }))
  const servers: HttpServer[] = []
  try {
    await expect(
      start(listener, {}, async () => {
        for (let index = 0; index < (mode === 'count' ? 2 : 1); index++) {
          const server = createServer()
          servers.push(server)
          await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        }
        const server = servers[0]
        const address = server?.address()
        if (!server || !address || typeof address === 'string') throw new Error('No backend')
        if (mode === 'forbidden')
          vi.spyOn(server, 'address').mockImplementation(() =>
            server.listening ? { ...address, port: 3998 } : null,
          )
        return {
          port: mode === 'forbidden' ? 3998 : address.port + (mode === 'mismatch' ? 1 : 0),
          close: async () => {
            for (const owned of servers)
              await new Promise<void>((resolve) => owned.close(() => resolve()))
          },
        }
      }),
    ).rejects.toThrow(
      mode === 'count' ? 'exactly one' : mode === 'mismatch' ? 'reported bound port' : 'Forbidden',
    )
    expect(servers.every((server) => !server.listening)).toBe(true)
  } finally {
    vi.restoreAllMocks()
    for (const server of servers) {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await listener.close()
  }
}

describe('production fixture port ownership', () => {
  it.each(['count', 'mismatch', 'forbidden'] as const)('rejects invalid backend: %s', (mode) =>
    verifyBackendValidation(mode),
  )
  it('retains the public listener and preserves HTTP bytes through a port-0 backend', () =>
    exercise())
  it('isolates owned backend objects across eight concurrent startups', async () => {
    await Promise.all(Array.from({ length: 8 }, () => exercise()))
  })
  it('fails cleanup when production shutdown leaves its real listener open', () =>
    exercise(startFixtureServer, true))
  it('closes a captured backend if startup rejects after binding', async () => {
    const listener = await listenOwned(createTcpServer({ allowHalfOpen: true }))
    const backend = createServer()
    try {
      await expect(
        startFixtureServer(listener, {}, async () => {
          await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
          throw new Error('synthetic failed startup')
        }),
      ).rejects.toThrow('synthetic failed startup')
      expect(backend.listening).toBe(false)
      expect(backend.address()).toBe(null)
    } finally {
      if (backend.listening) await new Promise<void>((resolve) => backend.close(() => resolve()))
      await listener.close()
    }
  })
})

describe('production fixture source-copy negative controls', () => {
  it.each([
    ['count', 'captured.length !== 1 || !backend', '!backend'],
    ['mismatch', 'address.port !== running.port', 'false'],
    ['forbidden', '[3000, 3998].includes(address.port)', 'false'],
  ] as const)('detects removal of the %s backend protection', async (mode, before, after) => {
    await expect(verifyBackendValidation(mode, sourceCopy([before, after]))).rejects.toThrow()
  })
  it('detects handing the retained frontend port to a second binder', async () => {
    const copy = sourceCopy(["PORT: '0'", 'PORT: String(listener.port)'])
    await expect(exercise(copy)).rejects.toThrow('backend port')
  })
  it('detects capturing another concurrently starting fixture', async () => {
    const copy = sourceCopy(['startupScope.getStore() === scope && ', ''])
    await expect(Promise.all(Array.from({ length: 4 }, () => exercise(copy)))).rejects.toThrow(
      'exactly one',
    )
  })
  it('detects removal of the owned backend closure guard', async () => {
    const copy = sourceCopy([
      'await backend.close(() => running.close())\n        await backend.assertClosed()',
      'await running.close()',
    ])
    await expect(exercise(copy, true)).rejects.toThrow()
  })
})
