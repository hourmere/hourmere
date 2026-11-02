/** Capability paths include rejected embed attempts and malformed tokens. */
export function isOneTimeLinkPath(path: string): boolean {
  return /(?:^|\/)book(?:\/|$)/i.test(path)
}
