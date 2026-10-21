import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { createConnection, type Server, type Socket } from 'node:net'
import { getRequestListener } from '@hono/node-server'
import { describe, expect, it, vi } from 'vitest'
import { listenOwned, trackOwned } from '../tools/e2e/listeners.ts'

type Helpers = { listenOwned: typeof listenOwned; trackOwned: typeof trackOwned }
function sourceCopy(replacement: [string, string]): Helpers {
  let source = readFileSync('tools/e2e/listeners.ts', 'utf8')
  expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
  source = source.replace(...replacement).replace(/^import .*\n/gm, '')
  source = stripTypeScriptTypes(source).replace(/\bexport (?=(?:async )?function)/g, '')
  return new Function(
    'assert',
    'createConnection',
    `${source}; return { listenOwned, trackOwned }`,
  )(assert, createConnection) as Helpers
}

async function verifyLiveHandoff(bind = listenOwned) {
  const server = createServer()
  const owned = await bind(server)
  const competitor = createServer()
  try {
    const result = await new Promise<string>((resolve) => {
      competitor.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'unknown'))
      competitor.listen(owned.port, '127.0.0.1', () => resolve('accepted'))
    })
    expect(result, 'The owned port stays bound while URL-dependent setup runs').toBe('EADDRINUSE')
    server.on(
      'request',
      getRequestListener(() => new Response('same live listener')),
    )
    const response = await fetch(owned.url)
    expect(await response.text()).toBe('same live listener')
  } finally {
    if (competitor.listening)
      await new Promise<void>((resolve) => competitor.close(() => resolve()))
    await owned.close()
  }
}

async function verifyExcluded(bind = listenOwned, port = 3998) {
  const server = createServer()
  const address = server.address.bind(server)
  vi.spyOn(server, 'address').mockImplementation(() => {
    const bound = address()
    return bound && typeof bound !== 'string' ? { ...bound, port } : bound
  })
  try {
    await expect(bind(server)).rejects.toThrow('Forbidden fixture port')
    expect(server.listening).toBe(false)
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.restoreAllMocks()
  }
}

async function verifyCloseError(track = trackOwned) {
  const server = createServer()
  const nativeClose = server.close.bind(server)
  const owned = track(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  vi.spyOn(server, 'close').mockImplementation((callback) =>
    nativeClose(() => callback?.(new Error('synthetic close failure'))),
  )
  try {
    await expect(owned.close()).rejects.toThrow('synthetic close failure')
    await expect(owned.assertClosed()).rejects.toThrow('close callback')
  } finally {
    vi.restoreAllMocks()
    if (server.listening) await new Promise<void>((resolve) => nativeClose(() => resolve()))
  }
}

// Isolate each invariant: Node can report the listener stopped before close callbacks
// and accepted sockets finish. These states must never be mistaken for completed cleanup.
async function verifyInvariant(
  state: 'callback' | 'event' | 'listening' | 'handle' | 'tracked' | 'connections',
  track = trackOwned,
) {
  class ControlledServer extends EventEmitter {
    listening = state === 'listening'
    address() {
      return state === 'handle' ? { address: '127.0.0.1', family: 'IPv4', port: 12345 } : null
    }
    getConnections(callback: (error: Error | null, count: number) => void) {
      callback(null, state === 'connections' ? 1 : 0)
    }
    close(callback: (error?: Error) => void) {
      if (state !== 'event') this.emit('close')
      callback()
      return this
    }
  }
  const server = new ControlledServer()
  const owned = track(server as unknown as Server)
  if (state === 'callback') {
    server.emit('close')
    await expect(owned.assertClosed()).rejects.toThrow('close callback')
  } else if (state === 'tracked') {
    // Add an accepted connection during the callback, after the destruction snapshot.
    const socket = new EventEmitter()
    await expect(
      owned.close(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await Promise.resolve()
        server.emit('connection', socket as Socket)
      }),
    ).rejects.toThrow('tracked connection')
  } else {
    const messages = {
      event: 'emit close',
      listening: 'stop listening',
      handle: 'bound handle',
      connections: 'remaining connections',
    }
    await expect(owned.close()).rejects.toThrow(messages[state])
  }
}

async function verifyPortReuse(bind = listenOwned) {
  const owned = await bind(createServer())
  await owned.close()
  const replacement = createServer((_request, response) => response.end('other worker'))
  try {
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject)
      replacement.listen(owned.port, '127.0.0.1', resolve)
    })
    await new Promise<void>((resolve, reject) => {
      const request = get(owned.url, { agent: false }, (response) => {
        response.resume().once('end', resolve)
      })
      request.once('error', reject)
    })
    expect(replacement.listening).toBe(true)
    await owned.assertClosed()
  } finally {
    await new Promise<void>((resolve) => replacement.close(() => resolve()))
  }
}

describe('fixture-owned listeners', () => {
  it('keeps the actual listener bound while its handler is constructed', () => verifyLiveHandoff())
  it.each([3000, 3998])('excludes port %i without closing and retrying', (port) =>
    verifyExcluded(listenOwned, port),
  )
  it('rejects a failed close callback', () => verifyCloseError())
  it.each(['callback', 'event', 'listening', 'handle', 'tracked', 'connections'] as const)(
    'rejects incomplete cleanup: %s',
    (state) => verifyInvariant(state),
  )
  it('rejects a real server deliberately left open', async () => {
    const owned = await listenOwned(createServer())
    try {
      await expect(owned.assertClosed()).rejects.toThrow('close callback')
      expect(owned.server.listening).toBe(true)
    } finally {
      await owned.close()
    }
  })
  it('closes active accepted sockets and releases the native connection count', async () => {
    const owned = await listenOwned(createServer())
    const connected = new Promise<void>((resolve) =>
      owned.server.once('connection', () => resolve()),
    )
    const socket = createConnection({ host: '127.0.0.1', port: owned.port })
    try {
      await connected
      await owned.close()
      await owned.assertClosed()
    } finally {
      socket.destroy()
      if (owned.server.listening) await owned.close()
    }
  })
  it('accepts cleanup when another worker has already reused the closed port', () =>
    verifyPortReuse())
  it('isolates 40 parallel listener lifecycles', async () => {
    await Promise.all(Array.from({ length: 40 }, () => verifyLiveHandoff()))
  })
})

describe('source-copy negative controls', () => {
  it('deterministically detects restoring the old port-based teardown probe', async () => {
    const copy = sourceCopy([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Match the literal TypeScript source.
      'return { ...owned, port: address.port, url: `http://127.0.0.1:${address.port}` }',
      `return { ...owned, port: address.port, url: 'http://127.0.0.1:' + address.port,
        assertClosed: async () => {
          await owned.assertClosed()
          const accepted = await new Promise((resolve) => {
            const socket = createConnection({ host: '127.0.0.1', port: address.port })
            socket.once('connect', () => { socket.destroy(); resolve(true) })
            socket.once('error', () => resolve(false))
          })
          assert.equal(accepted, false, 'The helper-owned listener must be closed')
        }
      }`,
    ])
    await expect(verifyPortReuse(copy.listenOwned)).rejects.toThrow('helper-owned listener')
  })
  it('detects releasing a port before handing it to a consumer', async () => {
    const copy = sourceCopy([
      'return { ...owned, port:',
      'await owned.close(); return { ...owned, port:',
    ])
    await expect(verifyLiveHandoff(copy.listenOwned)).rejects.toThrow('EADDRINUSE')
  })
  it('detects removal of the forbidden-port protection', async () => {
    const copy = sourceCopy([
      "assert(![3000, 3998].includes(address.port), 'Forbidden fixture port')",
      '',
    ])
    await expect(verifyExcluded(copy.listenOwned)).rejects.toThrow()
  })
  it('detects swallowing close callback errors', async () => {
    const copy = sourceCopy(['(error ? reject(error) : resolve())', 'resolve()'])
    await expect(verifyCloseError(copy.trackOwned)).rejects.toThrow()
  })
  it.each([
    [
      'callback',
      "assert(closeCompleted, 'The owned listener close callback must resolve without error')",
    ],
    ['event', "assert(closeEmitted, 'The owned listener must emit close')"],
    [
      'listening',
      "assert.equal(server.listening, false, 'The owned listener must stop listening')",
    ],
    [
      'handle',
      "assert.equal(server.address(), null, 'The owned listener must release its bound handle')",
    ],
    [
      'tracked',
      "assert.equal(sockets.size, 0, 'The owned listener must release every tracked connection')",
    ],
    [
      'connections',
      "assert.equal(connections, 0, 'The owned listener must have no remaining connections')",
    ],
  ] as const)('detects removal of the %s invariant', async (state, guard) => {
    const copy = sourceCopy([guard, ''])
    await expect(verifyInvariant(state, copy.trackOwned)).rejects.toThrow()
  })
})
