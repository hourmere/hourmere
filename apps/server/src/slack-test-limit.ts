import { createRateLimiter } from './rate-limit.ts'

// REST and MCP share one organization budget per server process. The durable
// pending-sample guard also bounds outstanding work across server instances.
export const slackTestLimiter = createRateLimiter({ limit: 5, windowSeconds: 60 })
