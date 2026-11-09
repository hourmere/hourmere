// Routing forms are storage only (docs/routing-forms.md, step a1a): the web mounts no
// routing page and PATHS names none. This is the web-route half of the routing Off check;
// scripts/routing-forms-off.test.ts covers OpenAPI, MCP, CLI and storage imports. It asserts
// absence by the names docs/routing-forms.md assigns and never snapshots the route table.
// Later plan steps narrow it when they add their pages: c3 (`/route/{handle}/{slug}` and
// `/route/team/{teamSlug}/{slug}`), c6 (`/route/continue`) and d1 (manager screens under
// PATHS), each mounting its routes only while `routingFormsEnabled` is true.
import { matchRoutes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { isRoutingName } from '../../../scripts/routing-forms-names.ts'
import { appRoutes } from './App.tsx'
import { PATHS } from './paths.ts'

type Route = (typeof appRoutes)[number]

// Routing-form names are matched token by token (`isRoutingName`): `route`, `routing` or
// `routed` as a whole path segment or identifier word; `/routes/:id` or `/app/router` is not one.
const PUBLIC_ROUTING_PAGES = ['/route/ada/intro', '/route/team/alpha/intro', '/route/continue']

function routePaths(routes: Route[], parent = ''): string[] {
  return routes.flatMap((route) => {
    const path = (
      route.path?.startsWith('/') ? route.path : `${parent}/${route.path ?? ''}`
    ).replace(/\/+/g, '/')
    return [path, ...routePaths(route.children ?? [], path)]
  })
}

describe('routing forms have no web route', () => {
  it('mounts no routing route and names none in PATHS', () => {
    const paths = routePaths(appRoutes)
    expect(paths).toContain('/app/event-types')
    expect(paths).toContain('/:handle/:slug')
    expect(paths.filter(isRoutingName)).toEqual([])
    const names = [...Object.keys(PATHS), ...Object.values(PATHS)]
    expect(names).toContain('/app/event-types')
    expect(names.filter(isRoutingName)).toEqual([])
  })

  it.each(PUBLIC_ROUTING_PAGES)('resolves %s as an ordinary public page', (pathname) => {
    // While routing is off, /route/… falls through to existing public page resolution.
    const matched = matchRoutes(appRoutes, pathname)?.map(({ route }) => route.path ?? '') ?? []
    expect(matched.length).toBeGreaterThan(0)
    expect(matched.filter(isRoutingName)).toEqual([])
  })
})
