import { escapeControlCharacters, redactLogDetails } from '@hourmere/auth'

/** Capability paths include rejected embed attempts and malformed tokens. */
export function isOneTimeLinkPath(path: string): boolean {
  return /(?:^|\/)book(?:\/|$)/i.test(path)
}

/** Keep error messages and stacks useful without allowing a capability into diagnostics. */
export function redactOneTimeLogDetails(text: string): string {
  // Services only pass the digest to storage, but an unexpected error may still repeat
  // input. Also remove longer base64url runs so a token embedded in other text stays private.
  return escapeControlCharacters(
    redactLogDetails(text).replace(/[A-Za-z0-9_-]{43,}/g, '[redacted capability]'),
  )
}
