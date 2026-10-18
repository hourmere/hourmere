import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createPool } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const serverUrl = process.env.DATABASE_URL
// The process boundary also contains a deliberately broken listen-error mutant. An
// uncaught error must fail the assertion without leaving an invisible worker in Vitest.
const childSource = `
import {randomBytes} from 'node:crypto'
import {startServer} from ${JSON.stringify(new URL('./server.ts', import.meta.url).href)}
const methods=['log','info','warn','error','debug','dir','dirxml']
const saved=methods.map(key=>console[key])
process.on('message',()=>{})
process.on('uncaughtException',error=>process.send?.({type:'uncaught',code:error.code}))
const env={DATABASE_URL:process.env.DATABASE_URL,PORT:process.env.TEST_OCCUPIED_PORT,
  HOURMERE_ROLE:process.env.TEST_SERVER_ROLE,PUBLIC_URL:'http://localhost',
  BETTER_AUTH_SECRET:randomBytes(32).toString('base64url'),SIGNUP:'closed'}
try {
  const unexpected=await startServer(env)
  await unexpected.close()
  process.send?.({type:'unexpected-success'})
} catch(error) {
  const consoleRestored=methods.every((key,index)=>console[key]===saved[index])
  const next=await startServer({...env,PORT:'0'})
  const port=next.port
  let healthStatus
  try {healthStatus=(await fetch('http://127.0.0.1:'+port+'/api/health')).status}
  finally {await next.close()}
  process.send?.({type:'rejected',code:error.code,consoleRestored,healthStatus,port,
    consoleStillRestored:methods.every((key,index)=>console[key]===saved[index])})
}
`

describe.skipIf(!serverUrl)('failed listener startup (owned PostgreSQL)', () => {
  let owned: TestDatabase
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
  })
  afterAll(async () => {
    if (!owned) return
    await owned.drop()
    const pool = createPool(owned.url)
    try {
      await expect(pool.query('SELECT 1')).rejects.toMatchObject({ code: '3D000' })
    } finally {
      await pool.end()
    }
  })
  for (const role of ['web', 'all', 'worker']) {
    it(`rejects an occupied port, releases every connection and permits a fresh ${role} start`, async () => {
      const occupied = createServer()
      await new Promise<void>((resolve) => occupied.listen(0, resolve))
      const address = occupied.address()
      if (!address || typeof address === 'string') throw new Error('Expected an owned TCP listener')
      const env: NodeJS.ProcessEnv = {}
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'NODE_OPTIONS', 'HOURMERE_OUTBOX_DB_REGISTRY'])
        if (process.env[key]) env[key] = process.env[key]
      Object.assign(env, {
        DATABASE_URL: owned.url,
        TEST_OCCUPIED_PORT: String(address.port),
        TEST_SERVER_ROLE: role,
      })
      const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
        env,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      })
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
          child.once('message', (value) => resolve(value as Record<string, unknown>))
          child.once('error', reject)
          child.once('exit', () => reject(new Error('Startup probe exited before its result')))
          timeout = setTimeout(
            () => reject(new Error('Startup did not reject within its bound')),
            10000,
          )
        })
        expect(result).toMatchObject({
          type: 'rejected',
          code: 'EADDRINUSE',
          consoleRestored: true,
          consoleStillRestored: true,
          healthStatus: 200,
        })
        expect(result.port).toBeGreaterThan(0)
        expect(result.port).not.toBe(address.port)
        const clients = await owned.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname=current_database() AND pid<>pg_backend_pid()
             AND backend_type='client backend'`,
        )
        expect(clients.rows[0]?.n).toBe(0)
      } finally {
        clearTimeout(timeout)
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGTERM')
          await exited
        }
        await new Promise<void>((resolve) => occupied.close(() => resolve()))
      }
    }, 15000)
  }
})
