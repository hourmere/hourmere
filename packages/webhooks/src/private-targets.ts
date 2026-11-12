// The private-target policy lives in the shared outbound module; webhooks keep their names
// and their own operator setting, WEBHOOK_PRIVATE_TARGETS.
import { isPrivateTargetAddress, type PrivateTarget, parsePrivateTargets } from '@hourmere/outbound'

export { privateTargetCandidates, privateTargetContains } from '@hourmere/outbound'

export type WebhookPrivateTarget = PrivateTarget

/** Only ordinary private/loopback space; metadata, link-local and other special use stay denied. */
export function isWebhookPrivateAddress(address: string): boolean {
  return isPrivateTargetAddress(address)
}

/** Parse the operator setting once at startup, without DNS or echoing supplied values. */
export function parseWebhookPrivateTargets(value?: string): readonly WebhookPrivateTarget[] {
  return parsePrivateTargets(value, 'WEBHOOK_PRIVATE_TARGETS')
}
