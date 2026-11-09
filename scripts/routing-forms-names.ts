// The routing-form vocabulary from docs/routing-forms.md, matched token by token so that
// identifiers which merely contain the letters (`rerouting`, `router`, `routes`) do not count.
// Shared by scripts/routing-forms-off.test.ts and apps/web/src/routing-forms-off.test.tsx.

/**
 * Words the design uses for routing-form surfaces: `routing-forms`, `route_lead`, `routed`,
 * and the plural `routings`. Not `routes` or `router`, which name unrelated existing things.
 */
export const ROUTING_WORDS: ReadonlySet<string> = new Set([
  'route',
  'routing',
  'routed',
  'routings',
])

/**
 * Run-together spellings of the design's compound names, which split into one token:
 * `routeforms`, `routingforms`, `routeleads`, `routedslots` and their singulars.
 */
export const ROUTING_COMPOUNDS: ReadonlySet<string> = new Set([
  'routeform',
  'routeforms',
  'routingform',
  'routingforms',
  'routelead',
  'routeleads',
  'routedslot',
  'routedslots',
])

/**
 * Splits an identifier or path on separators, camelCase boundaries (including an acronym
 * run, `MCPRoute`) and letter/digit boundaries (`route2`, `v2route`, `V2Route`), lower-cased.
 */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

/**
 * True when any whole token of the name is a routing word (`routeLead`, `/route/x`,
 * `RoutingForm`) or a run-together compound (`routingforms`).
 */
export function isRoutingName(name: string): boolean {
  return nameTokens(name).some((token) => ROUTING_WORDS.has(token) || ROUTING_COMPOUNDS.has(token))
}
