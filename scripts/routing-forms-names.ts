// The routing-form vocabulary from docs/routing-forms.md, matched token by token so that
// identifiers which merely contain the letters (`rerouting`, `router`, `routes`) do not count.
// Shared by scripts/routing-forms-off.test.ts and apps/web/src/routing-forms-off.test.tsx.

/** Words the design uses for routing-form surfaces: `routing-forms`, `route_lead`, `routed`. */
export const ROUTING_WORDS: ReadonlySet<string> = new Set(['route', 'routing', 'routed'])

/** Splits an identifier or path on separators and camelCase boundaries, lower-cased. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

/** True when any whole token of the name is a routing word (`routeLead`, `/route/x`, `RoutingForm`). */
export function isRoutingName(name: string): boolean {
  return nameTokens(name).some((token) => ROUTING_WORDS.has(token))
}
