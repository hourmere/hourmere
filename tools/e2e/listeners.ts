import assert from 'node:assert/strict'
import { Server as HttpServer } from 'node:http'
import type { Server, Socket } from 'node:net'
import {
  closeServer,
  DEFAULT_SHUTDOWN_TIMING,
  type ShutdownTiming,
} from '../../apps/server/src/shutdown.ts'

export interface TrackedListener<T extends Server = Server> {
  server: T
  close: (shutdown?: () => Promise<void>) => Promise<void>
  assertClosed: () => Promise<void>
}

export interface OwnedListener<T extends Server = Server> extends TrackedListener<T> {
  port: number
  url: string
}

/** Track the object we own, never a port number that another worker can reuse. */
export function trackOwned<T extends Server>(
  server: T,
  timing: ShutdownTiming = DEFAULT_SHUTDOWN_TIMING,
): TrackedListener<T> {
  const sockets = new Set<Socket>()
  let closeCompleted = false,
    closeEmitted = false,
    closing: Promise<void> | undefined
  const connected = (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }
  const closed = () => {
    closeEmitted = true
  }
  server.on('connection', connected)
  server.once('close', closed)
  const assertClosed = async () => {
    assert(closeCompleted, 'The owned listener close callback must resolve without error')
    assert(closeEmitted, 'The owned listener must emit close')
    assert.equal(server.listening, false, 'The owned listener must stop listening')
    assert.equal(server.address(), null, 'The owned listener must release its bound handle')
    assert.equal(sockets.size, 0, 'The owned listener must release every tracked connection')
    const connections = await new Promise<number>((resolve, reject) =>
      server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
    )
    assert.equal(connections, 0, 'The owned listener must have no remaining connections')
  }
  return {
    server,
    assertClosed,
    close(shutdown) {
      closing ??= (async () => {
        const disconnected: Promise<void>[] = []
        const disconnect = () => {
          for (const socket of sockets) {
            disconnected.push(new Promise<void>((resolve) => socket.once('close', resolve)))
            socket.destroy()
          }
        }
        let cutoff: ReturnType<typeof setTimeout> | undefined
        try {
          // Preserve in-flight HTTP work before pools close. The additional cutoff
          // also covers upgraded sockets, which closeAllConnections omits.
          const completion = shutdown
            ? shutdown()
            : server instanceof HttpServer
              ? closeServer(server, timing)
              : new Promise<void>((resolve, reject) =>
                  server.close((error) => (error ? reject(error) : resolve())),
                )
          if (!shutdown && !(server instanceof HttpServer)) disconnect()
          else cutoff = setTimeout(disconnect, timing.cutoffMs)
          await completion
          closeCompleted = true
        } finally {
          clearTimeout(cutoff)
          disconnect()
          await Promise.all(disconnected)
        }
        await assertClosed()
        server.off('connection', connected)
        server.off('close', closed)
      })()
      return closing
    },
  }
}

/** Bind exactly once; callers attach handlers to this live server after learning its URL. */
export async function listenOwned<T extends Server>(server: T): Promise<OwnedListener<T>> {
  const owned = trackOwned(server)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    assert(address && typeof address !== 'string', 'No owned fixture port')
    // These development ports must never be exposed by a fixture. A forbidden OS
    // assignment fails setup and closes its owner; it never closes and rebinds it.
    assert(![3000, 3998].includes(address.port), 'Forbidden fixture port')
    return { ...owned, port: address.port, url: `http://127.0.0.1:${address.port}` }
  } catch (error) {
    if (server.listening) await owned.close()
    throw error
  }
}
