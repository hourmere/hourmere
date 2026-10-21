import { AsyncLocalStorage } from 'node:async_hooks'
import { tracingChannel } from 'node:diagnostics_channel'
import { Server as HttpServer } from 'node:http'
import { createConnection, type Server, type Socket } from 'node:net'
import { type RunningServer, startServer } from '../../apps/server/src/server.ts'
import { type OwnedListener, trackOwned } from './listeners.ts'

const startupScope = new AsyncLocalStorage<symbol>()
const listening = tracingChannel<{ server: Server }>('net.server.listen')

/** Keep the public origin bound while production startup chooses its own backend port. */
export async function startFixtureServer(
  listener: OwnedListener,
  env: NodeJS.ProcessEnv,
  start: typeof startServer = startServer,
): Promise<RunningServer> {
  const scope = Symbol('fixture server startup')
  const captured: ReturnType<typeof trackOwned>[] = []
  const subscribers = {
    asyncStart({ server }: { server: Server }) {
      if (startupScope.getStore() === scope && server instanceof HttpServer)
        captured.push(trackOwned(server))
    },
  }
  let running: RunningServer | undefined
  listening.subscribe(subscribers)
  try {
    running = await startupScope.run(scope, () =>
      start({ ...env, PORT: '0', PUBLIC_URL: listener.url }),
    )
  } catch (error) {
    await Promise.allSettled(captured.map((owned) => owned.close()))
    throw error
  } finally {
    listening.unsubscribe(subscribers)
  }
  const backend = captured[0]
  if (captured.length !== 1 || !backend) {
    try {
      await running.close()
    } finally {
      await Promise.allSettled(
        captured.filter((owned) => owned.server.listening).map((owned) => owned.close()),
      )
    }
    throw new Error('The fixture must own exactly one production HTTP listener')
  }
  const address = backend.server.address()
  if (!address || typeof address === 'string' || address.port !== running.port) {
    await backend.close(() => running.close())
    throw new Error('The production listener must match its reported bound port')
  }
  if ([3000, 3998].includes(address.port)) {
    await backend.close(() => running.close())
    throw new Error('Forbidden production fixture port')
  }

  const outbound = new Set<Socket>()
  const pendingClose = new Set<Promise<void>>()
  let closing: Promise<void> | undefined
  const forward = (incoming: Socket) => {
    if (closing) {
      incoming.destroy()
      return
    }
    const socket = createConnection({
      host: '127.0.0.1',
      port: running.port,
      allowHalfOpen: true,
    })
    outbound.add(socket)
    const closed = new Promise<void>((resolve) => {
      socket.once('close', () => {
        outbound.delete(socket)
        pendingClose.delete(closed)
        incoming.destroy()
        resolve()
      })
    })
    pendingClose.add(closed)
    incoming.once('error', () => socket.destroy())
    incoming.once('close', () => socket.destroy())
    socket.once('error', () => incoming.destroy())
    incoming.pipe(socket).pipe(incoming)
  }
  listener.server.on('connection', forward)
  listener.server.once('close', () => listener.server.off('connection', forward))

  return {
    port: listener.port,
    close() {
      closing ??= (async () => {
        try {
          await backend.close(() => running.close())
          await backend.assertClosed()
        } finally {
          for (const socket of outbound) socket.destroy()
          await Promise.all(pendingClose)
        }
        if (outbound.size || pendingClose.size)
          throw new Error('The fixture must release its outbound proxy connections')
      })()
      return closing
    },
  }
}
