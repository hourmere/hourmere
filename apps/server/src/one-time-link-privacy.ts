import { escapeControlCharacters, redactLogDetails } from '@hourmere/auth'

/** Only public booking paths carry the capability in the request URL. */
export function isOneTimeCapabilityPath(path: string): boolean {
  return /(?:^|\/)book(?:\/|$)/i.test(path)
}

/** Capability paths and administration include rejected attempts and malformed inputs. */
export function isOneTimeLinkPath(path: string): boolean {
  return isOneTimeCapabilityPath(path) || /(?:^|\/)one-time-links(?:\/|$)/i.test(path)
}

/** Keep error messages and stacks useful without allowing a capability into diagnostics. */
export function redactOneTimeLogDetails(text: string): string {
  // Services only pass the digest to storage, but an unexpected error may still repeat
  // input. Also remove longer base64url runs so a token embedded in other text stays private.
  return escapeControlCharacters(
    redactLogDetails(text).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted capability]'),
  )
}
