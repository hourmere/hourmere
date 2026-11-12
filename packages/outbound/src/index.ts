// The outbound URL policy and pinned-socket transport shared by webhooks, CalDAV and SSO.
// Profiles add their own scheme, timeout, body and logging rules on top of it; the SSO
// profile is its own entry point (`@hourmere/outbound/sso`) and is not re-exported here.
export { isLoopbackAddress, isPublicAddress } from './addresses.ts'
export {
  answersPermitted,
  type DnsAnswer,
  isPublicHttpsUrl,
  MAX_DNS_ANSWERS,
  MAX_OUTBOUND_URL_BYTES,
  normalizedOutboundUrl,
  parseOutboundUrl,
  pinnedConnection,
  resolveAnswers,
  urlHostname,
  urlPort,
  validAnswers,
} from './destination.ts'
export {
  isPrivateTargetAddress,
  type PrivateTarget,
  parsePrivateTargets,
  privateTargetCandidates,
  privateTargetContains,
} from './private-targets.ts'
