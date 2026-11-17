/** Internal foundation; no REST, MCP, CLI or application worker integration is enabled yet. */

export {
  type CalDavConnectionDeps,
  connectCalDav,
  disconnectCalDav,
  listCalDavConnections,
} from './caldav-connection.ts'
export {
  type CalDavCredentialRecord,
  type CalDavCredentials,
  createCalDavCredentialRecord,
  readCalDavCredentials,
} from './caldav-credentials.ts'
export {
  type CalDavCalendar,
  type CalDavDiscoveryClient,
  type CalDavDiscoveryResult,
  createCalDavDiscovery,
} from './caldav-discovery.ts'
export { calDavDispatchJob, calDavSyncJob, createCalDavSyncEnqueuer } from './caldav-jobs.ts'

export { type CalDavSyncDeps, configureCalDavCalendar, syncCalDavCalendar } from './caldav-sync.ts'
export {
  type CalDavSyncClient,
  type CalDavSyncCursor,
  type CalDavSyncResult,
  createCalDavSyncClient,
} from './caldav-sync-client.ts'
export {
  CalDavError,
  type CalDavPrivateTarget,
  type CalDavRequest,
  type CalDavResponse,
  type CalDavTransport,
} from './caldav-transport.ts'
export { type CalDavWriteClient, createCalDavWriteClient } from './caldav-write-client.ts'
export { configureCalDavWriteCalendar } from './caldav-write-selection.ts'
export {
  type CalDavBookingPayload,
  type CalDavWritebackDeps,
  calDavBookingNotifier,
  writeCalDavBooking,
} from './caldav-writeback.ts'
export { calDavBookingJob, createCalDavBookingEnqueuer } from './caldav-writeback-jobs.ts'
