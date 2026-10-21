import { AsyncLocalStorage } from 'node:async_hooks'
import { tracingChannel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { Server as HttpServer } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { createConnection, createServer, type NetConnectOpts, type Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { startFixtureServer } from '../tools/e2e/fixture-server.ts'
import { listenOwned, trackOwned } from '../tools/e2e/listeners.ts'

type Start = typeof startFixtureServer
type Replacement = [string, string]
function sourceCopy(
  replacements: Replacement[] = [],
  connect = (options: NetConnectOpts) => createConnection(options),
): Start {
  let source = readFileSync('tools/e2e/fixture-server.ts', 'utf8')
  for (const replacement of replacements) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  source = stripTypeScriptTypes(source.replace(/^import .*\n/gm, '')).replace(
    /\bexport (?=(?:async )?function)/g,
    '',
  )
  return new Function(
    'AsyncLocalStorage',
    'tracingChannel',
    'HttpServer',
    'createConnection',
    'trackOwned',
    'startServer',
    `${source}; return startFixtureServer`,
  )(AsyncLocalStorage, tracingChannel, HttpServer, connect, trackOwned, undefined) as Start
}

async function fixture(
  start: Start,
  connected: (socket: Socket) => void,
  shutdownCheck = () => {},
  leaveOpen = false,
) {
  const listener = await listenOwned(createServer({ allowHalfOpen: true }))
  // Keep HTTP identity for the real production-listener diagnostic, but exercise
  // raw TCP half-closes without the HTTP parser's independent FIN handling.
  const backend = new HttpServer()
  backend.removeAllListeners('connection')
  const peers = new Set<Socket>()
  backend.on('connection', (socket) => {
    peers.add(socket)
    socket.once('close', () => peers.delete(socket))
    connected(socket)
  })
  const app = await start(listener, {}, async () => {
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
    const address = backend.address()
    if (!address || typeof address === 'string') throw new Error('No raw test backend')
    return {
      port: address.port,
      close: async () => {
        shutdownCheck()
        if (!leaveOpen)
          await new Promise<void>((resolve, reject) =>
            backend.close((error) => (error ? reject(error) : resolve())),
          )
      },
    }
  })
  return {
    app,
    backend,
    listener,
    async cleanup() {
      for (const socket of peers) socket.destroy()
      if (backend.listening) await new Promise<void>((resolve) => backend.close(() => resolve()))
      await listener.close()
    },
  }
}

async function exerciseActive(
  replacements: Replacement[] = [],
  residual = false,
  leaveOpen = false,
) {
  let outbound: Socket | undefined,
    closeObserved = false
  const start = sourceCopy(replacements, (options) => {
    outbound = createConnection(options)
    outbound.once('close', () => {
      closeObserved = true
    })
    return outbound
  })
  let received!: () => void
  const active = new Promise<void>((resolve) => {
    received = resolve
  })
  const owned = await fixture(
    start,
    (socket) => socket.once('data', received),
    () => expect(closeObserved, 'Outbound close must finish before production shutdown').toBe(true),
    leaveOpen,
  )
  const client = createConnection({ host: '127.0.0.1', port: owned.listener.port })
  client.on('error', () => {})
  let closing: Promise<void> | undefined
  try {
    await once(client, 'connect')
    client.write('active connection')
    await active
    expect(outbound?.destroyed).toBe(false)
    closing = owned.app.close()
    void closing.catch(() => {})
    expect(outbound?.destroyed, 'Shutdown must destroy the owned outbound socket').toBe(true)
    if (residual) await expect(closing).rejects.toThrow('release its outbound proxy connections')
    else if (leaveOpen) {
      await expect(closing).rejects.toThrow('emit close')
      expect(owned.backend.listening).toBe(true)
    } else {
      await closing
      expect(closeObserved).toBe(true)
      expect(owned.backend.listening).toBe(false)
    }
  } finally {
    outbound?.destroy()
    client.destroy()
    await Promise.allSettled([closing])
    await owned.cleanup()
  }
}

async function exerciseHalfClose(start: Start = startFixtureServer, first: 'client' | 'backend') {
  let received!: (value: string) => void
  const backendBody = new Promise<string>((resolve) => {
    received = resolve
  })
  const owned = await fixture(start, (socket) => {
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (first === 'backend' && chunks.length === 1) socket.end('backend reply')
    })
    socket.on('end', () => {
      received(Buffer.concat(chunks).toString())
      if (first === 'client') setImmediate(() => socket.end('backend reply'))
    })
  })
  const client = createConnection({
    host: '127.0.0.1',
    port: owned.listener.port,
    allowHalfOpen: true,
  })
  client.on('error', () => {})
  const chunks: Buffer[] = []
  client.on('data', (chunk: Buffer) => chunks.push(chunk))
  try {
    await once(client, 'connect')
    const ended = once(client, 'end')
    if (first === 'client') client.end('before FIN')
    else client.write('before FIN')
    await ended
    if (first === 'backend') client.end(' after FIN')
    expect(await backendBody, 'A backend FIN must not truncate later client bytes').toBe(
      first === 'client' ? 'before FIN' : 'before FIN after FIN',
    )
    expect(Buffer.concat(chunks).toString(), 'A client FIN must not truncate the reply').toBe(
      'backend reply',
    )
    await owned.app.close()
  } finally {
    client.destroy()
    await owned.cleanup()
  }
}

describe('fixture proxy socket ownership', () => {
  it('destroys active outbound sockets and waits for their close before shutting down', () =>
    exerciseActive())
  it('rejects a no-op production shutdown even with an active proxied connection', () =>
    exerciseActive([], false, true))
  it.each(['client', 'backend'] as const)('preserves streams when %s half-closes first', (first) =>
    exerciseHalfClose(startFixtureServer, first),
  )
})

describe('fixture proxy source-copy negative controls', () => {
  it.each([
    ['outbound tracking', 'outbound.add(socket)', ''],
    ['outbound destruction', 'for (const socket of outbound) socket.destroy()', ''],
    ['pending-close tracking', 'pendingClose.add(closed)', ''],
    ['pending-close wait', 'await Promise.all(pendingClose)', ''],
    ['outbound removal', 'outbound.delete(socket)', ''],
    ['pending-close removal', 'pendingClose.delete(closed)', ''],
  ])('detects removal of %s', async (_name, before, after) => {
    await expect(exerciseActive([[before, after]])).rejects.toThrow()
  })
  it.each(['outbound', 'pendingClose'])('detects removal of the residual %s guard', async (set) => {
    const stale: Replacement =
      set === 'outbound' ? ['outbound.delete(socket)', ''] : ['pendingClose.delete(closed)', '']
    await exerciseActive([stale], true)
    await expect(
      exerciseActive(
        [
          stale,
          [
            'outbound.size || pendingClose.size',
            set === 'outbound' ? 'pendingClose.size' : 'outbound.size',
          ],
        ],
        true,
      ),
    ).rejects.toThrow()
  })
  it('detects loss of the outbound half-close protection', async () => {
    const copy = sourceCopy([['allowHalfOpen: true,', 'allowHalfOpen: false,']])
    await expect(exerciseHalfClose(copy, 'backend')).rejects.toThrow('after FIN')
  })
})
