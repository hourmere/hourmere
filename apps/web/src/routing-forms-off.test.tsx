// Routing forms are storage only (docs/routing-forms.md, step a1a): the web mounts no
// routing page and PATHS names none. Step a1b adds no web surface: the web does not read the
// new `/instance` capability `routingFormsEnabled` yet. This is the web-route half of the
// routing Off check; scripts/routing-forms-off.test.ts covers OpenAPI, MCP, CLI and storage
// imports. It asserts absence by the names docs/routing-forms.md assigns and never
// snapshots the route table. Route sources covered: the `appRoutes` table, PATHS, and every
// `<Route path>` attribute and route object (a `path` beside `element`, `Component`, `lazy`,
// `children`, `index`, `loader`, `action`, `errorElement` or `ErrorBoundary`) in every
// non-test source under apps/web/src, which includes the
// data router in main.tsx and any descendant `<Routes>` a page renders, relative paths too.
// Later plan steps narrow it when they add their pages: c3 (`/route/{handle}/{slug}` and
// `/route/team/{teamSlug}/{slug}`), c6 (`/route/continue`) and d1 (manager screens under
// PATHS), each mounting its routes only while `routingFormsEnabled` is true.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '@babel/parser'
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

// jsdom gives modules no file URL; tests run from the repository root.
const sourceRoot = 'apps/web/src'

/** Every non-test TypeScript source of the web app (test support and generated types aside). */
function webSources(): [string, string][] {
  const files: [string, string][] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      const file = relative(sourceRoot, path)
      if (statSync(path).isDirectory()) {
        if (file !== 'test') walk(path)
      } else if (/\.tsx?$/.test(entry) && !/\.(test\.tsx?|d\.ts)$/.test(entry))
        files.push([file, readFileSync(path, 'utf8')])
    }
  }
  walk(sourceRoot)
  return files
}

type SyntaxNode = { type: string; start?: number | null; end?: number | null } & Record<
  string,
  unknown
>
const isNode = (value: unknown): value is SyntaxNode =>
  typeof value === 'object' && value !== null && typeof (value as SyntaxNode).type === 'string'
const ROUTE_OBJECT_KEYS = new Set([
  'element',
  'Component',
  'lazy',
  'children',
  'index',
  'loader',
  'action',
  'errorElement',
  'ErrorBoundary',
])
const keyName = (property: SyntaxNode): string => {
  const key = property.key as SyntaxNode | undefined
  return String(
    key?.type === 'Identifier' ? key.name : key?.type === 'StringLiteral' ? key.value : '',
  )
}

/**
 * The path of every `<Route>` element and route object in a source, as written: a string's
 * value, or the source text of an expression (`PATHS.join`, a template).
 */
function routePathsIn(file: string, source: string): string[] {
  const tree = parse(source, {
    sourceType: 'module',
    plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  })
  const paths: string[] = []
  const written = (value: unknown) => {
    if (!isNode(value)) return
    const inner = value.type === 'JSXExpressionContainer' ? (value.expression as SyntaxNode) : value
    paths.push(
      inner.type === 'StringLiteral'
        ? String(inner.value)
        : source.slice(inner.start ?? 0, inner.end ?? 0),
    )
  }
  const stack: unknown[] = [tree]
  while (stack.length) {
    const value = stack.pop()
    if (Array.isArray(value)) {
      stack.push(...value)
      continue
    }
    if (!isNode(value)) continue
    const name = value.name as SyntaxNode | undefined
    if (
      value.type === 'JSXOpeningElement' &&
      (name?.type === 'JSXIdentifier'
        ? name.name === 'Route'
        : name?.type === 'JSXMemberExpression' && (name.property as SyntaxNode).name === 'Route')
    )
      for (const attribute of value.attributes as SyntaxNode[])
        if (attribute.type === 'JSXAttribute' && (attribute.name as SyntaxNode).name === 'path')
          written(attribute.value)
    if (value.type === 'ObjectExpression') {
      // Methods count too: `{ path, async lazy() {} }`.
      const properties = (value.properties as SyntaxNode[]).filter(
        (property) => property.type === 'ObjectProperty' || property.type === 'ObjectMethod',
      )
      const path = properties.find((property) => keyName(property) === 'path')
      if (
        path?.type === 'ObjectProperty' &&
        properties.some((property) => ROUTE_OBJECT_KEYS.has(keyName(property)))
      )
        written(path.value)
    }
    for (const [key, child] of Object.entries(value))
      if (!['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments'].includes(key))
        stack.push(child)
  }
  return paths
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

  it('declares no routing route in any web source, relative or descendant routes included', () => {
    const sources = webSources()
    expect(sources.map(([file]) => file)).toEqual(
      expect.arrayContaining(['main.tsx', 'App.tsx', 'pages/NotFound.tsx']),
    )
    const paths = sources.flatMap(([file, source]) => routePathsIn(file, source))
    // main.tsx's data router, absolute, relative and PATHS-based routes in App.tsx.
    expect(paths).toEqual(
      expect.arrayContaining(['*', '/:handle/:slug', 'event-types', 'PATHS.join']),
    )
    expect(paths.filter(isRoutingName)).toEqual([])
  }, 30_000)

  it.each([
    // A relative route beside main.tsx's catch-all, or a descendant <Routes> inside a page.
    ['main.tsx', "createBrowserRouter([{ path: 'route/:handle/:slug', element: <Page /> }])"],
    ['main.tsx', "useRoutes([{ path: 'routing-forms', Component: Page }])"],
    ['main.tsx', "createBrowserRouter([{ path: 'route/:slug', async lazy() { return {} } }])"],
    ['main.tsx', "createBrowserRouter([{ path: 'routing-forms/export', loader }])"],
    ['pages/NotFound.tsx', '<Routes><Route path="routing-forms" element={<Page />} /></Routes>'],
    [
      'pages/NotFound.tsx',
      '<Routes><Route path={PATHS.routingForms} element={<Page />} /></Routes>',
    ],
    ['App.tsx', `<Route path={\`\${APP_BASE}/routing-forms\`} element={<Page />} />`],
  ])('sees a routing route added to %s: %s', (file, added) => {
    const source = readFileSync(join(sourceRoot, file), 'utf8')
    expect(routePathsIn(file, source).filter(isRoutingName)).toEqual([])
    expect(routePathsIn(file, `${source}\n${added}\n`).filter(isRoutingName)).not.toEqual([])
    // Unrelated routes and a route object without a page are not routing routes.
    expect(
      routePathsIn(file, "[{ path: 'routes', element: <Page /> }, { path: 'route', size: 1 }]"),
    ).toEqual(['routes'])
  })

  it.each(PUBLIC_ROUTING_PAGES)('resolves %s as an ordinary public page', (pathname) => {
    // While routing is off, /route/… falls through to existing public page resolution.
    const matched = matchRoutes(appRoutes, pathname)?.map(({ route }) => route.path ?? '') ?? []
    expect(matched.length).toBeGreaterThan(0)
    expect(matched.filter(isRoutingName)).toEqual([])
  })
})
