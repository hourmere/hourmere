import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import { createApp } from '../../../apps/server/src/app.ts'
import type { SsoCapabilities } from '../../../apps/server/src/sso.ts'
import { samlSignInRoutes } from '../../../apps/server/src/sso-saml-sign-in.ts'
import type { SignupPolicy } from '../../../packages/auth/src/index.ts'
import { createDb, createPool } from '../../../packages/db/src/index.ts'
import { listenOwned } from '../listeners.ts'

interface SamlPeerConfig {
  databaseUrl: string
  publicUrl: string
  capabilities: SsoCapabilities
  configurationKey: Buffer
  signup: SignupPolicy
  secret: string
}

/** Use a second server process with its own pool and the same canonical SP and database. */
export async function startSamlPeer(config: SamlPeerConfig) {
  const child = fork(fileURLToPath(import.meta.url), [], {
    execArgv: [],
    env: {},
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const exited = new Promise<boolean>((resolve) => {
    // After a parent-initiated IPC disconnect, Node may emit exit without close.
    child.once('exit', (code) => resolve(code === 0))
    child.once('error', () => {
      if (!child.pid) resolve(false)
    })
  })
  try {
    // Configuration travels only over the private IPC channel.
    const ready = new Promise<number>((resolve, reject) => {
      const fail = () => reject(new Error('The SAML peer failed to start'))
      child.once('error', fail)
      void exited.then(fail)
      child.once('message', (port) => {
        if (typeof port === 'number') resolve(port)
        else fail()
      })
      child.send(config, (error) => {
        if (error) fail()
      })
    })
    const port = await ready
    return {
      async post(path: string, fields: URLSearchParams) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          body: fields,
          redirect: 'manual',
        })
        await response.body?.cancel()
        return { status: response.status, location: response.headers.get('location') }
      },
      async close() {
        if (child.connected) child.disconnect()
        if (!(await exited)) throw new Error('The SAML peer did not shut down cleanly')
      },
    }
  } catch (error) {
    if (child.connected) child.disconnect()
    await exited
    throw error
  }
}

async function servePeer() {
  const disconnected = once(process, 'disconnect')
  const [config] = (await once(process, 'message')) as [SamlPeerConfig]
  const { publicUrl, databaseUrl, capabilities, configurationKey, signup, secret } = config
  const db = createDb(createPool(databaseUrl))
  try {
    const app = createApp({
      publicUrl,
      checkDb: async () => {},
      authHandler: async () => new Response(null, { status: 404 }),
      resolveCaller: async () => ({ ok: false, error: 'unauthorized', setCookie: [] }),
      ssoSamlSignIn: samlSignInRoutes({
        db,
        capabilities,
        configurationKey,
        signup,
        session: { secret },
      }),
    })
    const listener = await listenOwned(
      createServer(getRequestListener(app.fetch, { hostname: '127.0.0.1' })),
    )
    try {
      process.send?.(listener.port)
      await disconnected
    } finally {
      await listener.close()
    }
  } finally {
    await db.destroy()
  }
}

if (import.meta.main) {
  try {
    await servePeer()
  } catch {
    process.exitCode = 1
    if (process.connected) process.disconnect?.()
  }
}
