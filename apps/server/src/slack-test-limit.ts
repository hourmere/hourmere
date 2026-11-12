import { createRateLimiter } from './rate-limit.ts'

// REST and MCP share one organization budget per server process. Only attempts that
// passed the final owner/admin check for an existing destination are counted, so
// members cannot spend the admins' budget. The durable pending-sample guard also bounds
// outstanding work across server instances.
export const slackTestLimiter = createRateLimiter({ limit: 5, windowSeconds: 60 })

/** Thrown from the authorized admission callback when the organization budget is spent. */
export class SlackTestRateLimited extends Error {
  readonly retryAfterSeconds: number
  constructor(retryAfterSeconds: number) {
    super('rate limited')
    this.retryAfterSeconds = retryAfterSeconds
  }
}
