import type { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import { afterAll, afterEach } from 'vitest'

/**
 * Connection order guard for every node test. Code running inside a native auth transaction
 * (marked by @hourmere/auth's teamTransactionAdapter) must never ask a pool other than the
 * auth pool for a connection: the MCP OAuth broker holds an application transaction while
 * it waits for an auth connection, so the opposite order can deadlock once both pools are
 * busy. Any such request fails the test that made it, whether or not the pools were busy.
 *
 * The marker and the auth pool tag are global symbols, so this file needs no import of the
 * auth package and also sees isolated source copies of it.
 */
const AUTH_TRANSACTION = Symbol.for('hourmere.auth-transaction')
const AUTH_POOL = Symbol.for('hourmere.auth-pool')

type Connect = (this: pg.Pool, ...args: unknown[]) => unknown
const VIOLATIONS = Symbol.for('hourmere.pool-order-violations')
// Shared with takePoolOrderViolations in @hourmere/db/testing, for mutation tests that
// reproduce this wait on purpose.
const store = globalThis as { [VIOLATIONS]?: string[] }
const violations = store[VIOLATIONS] ?? []
store[VIOLATIONS] = violations
const prototype = pg.Pool.prototype as unknown as { connect: Connect }
const connect = prototype.connect
const marker = Symbol.for('hourmere.pool-order-guard')

if (!(marker in connect)) {
  const guarded: Connect = function (this: pg.Pool, ...args: unknown[]) {
    const held = (globalThis as { [AUTH_TRANSACTION]?: AsyncLocalStorage<true> })[
      AUTH_TRANSACTION
    ]?.getStore()
    if (held && !(this as unknown as Record<symbol, unknown>)[AUTH_POOL]) {
      violations.push(
        new Error('a connection from another pool was requested inside an auth transaction')
          .stack ?? '',
      )
    }
    return connect.apply(this, args)
  }
  Object.defineProperty(guarded, marker, { value: true })
  prototype.connect = guarded
}

function reportViolations() {
  if (violations.length === 0) return
  const found = violations.splice(0)
  throw new Error(
    `${found.length} connection(s) requested from another pool while holding an auth transaction; acquire them before the transaction opens or use its connection.\n${found[0]}`,
  )
}

afterEach(reportViolations)
// Requests made from suite hooks, or that finish after the last test.
afterAll(reportViolations)
