import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { guardPoolErrors } from './index.ts'

afterEach(() => vi.restoreAllMocks())

it.each(['idle', 'checked out'] as const)(
  'suppresses %s pool errors after parent IPC disconnect',
  async (state) => {
    const source = `
      import { EventEmitter } from 'node:events';
      import { guardPoolErrors } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      const pool = new EventEmitter();
      const client = new EventEmitter();
      guardPoolErrors(pool);
      pool.emit('acquire', client);
      console.error = () => process.stdout.write('logged error\\n');
      process.on('disconnect', () => {
        ${state === 'idle' ? 'pool' : 'client'}.emit('error', new Error('fixture failure'));
        pool.emit('release', undefined, client);
        process.stdout.write('guarded error\\n');
      });
      process.stdout.write('ready\\n');
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const exited = once(child, 'exit')
    let output = ''
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
    })
    try {
      await once(child.stdout as NodeJS.ReadableStream, 'data')
      child.disconnect()
      expect(await exited).toEqual([0, null])
      expect(output).toBe('ready\nguarded error\n')
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
  },
)

it('logs pool errors by default', () => {
  const pool = new EventEmitter()
  const client = new EventEmitter()
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  guardPoolErrors(pool as pg.Pool)
  pool.emit('error', new Error('idle fixture failure'))
  pool.emit('acquire', client)
  client.emit('error', new Error('checked-out fixture failure'))
  expect(log.mock.calls).toEqual([
    ['idle Postgres client error: idle fixture failure'],
    ['Postgres client error while in use: checked-out fixture failure'],
  ])
  pool.emit('release', undefined, client)
})
