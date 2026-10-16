import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'

/**
 * What a service function receives for an authenticated call. REST routes and MCP tools
 * build it the same way, so people and agents get exactly the same behavior.
 */
export interface ServiceContext {
  db: Db
  principal: Principal
  /** The clock, injectable for tests. */
  now: () => Temporal.Instant
}

/** For unauthenticated flows such as public booking pages and invitee links. */
export interface PublicContext {
  db: Db
  now: () => Temporal.Instant
}
