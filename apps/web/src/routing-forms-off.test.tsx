// Inventory routing addresses and require the manager branch to go through its gate.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '@babel/parser'
import { screen, within } from '@testing-library/react'
import { isValidElement } from 'react'
import { matchRoutes } from 'react-router'
import { describe, expect, it } from 'vitest'
import { isRoutingName } from '../../../scripts/routing-forms-names.ts'
import { appRoutes } from './App.tsx'
import { RequireRoutingForms } from './lazy-pages.tsx'
import { PATHS, routingFormPath } from './paths.ts'
import { fakeApi, json, later, ME, renderApp, signedIn } from './test/fake-api.tsx'

type Route = (typeof appRoutes)[number]

// Routing-form names are matched token by token (`isRoutingName`): `route`, `routing` or
// `routed` as a whole path segment or identifier word; `/routes/:id` or `/app/router` is not one.
const PUBLIC_ROUTING_PAGES = ['/route/ada/intro', '/route/team/alpha/intro', '/route/continue']
const MANAGER_PATHS = ['routing-forms', 'routing-forms/new', 'routing-forms/:id']
const GATED_FORM_PATHS = ['/route/:handle/:slug', '/route/team/:teamSlug/:slug', ...MANAGER_PATHS]
const editorAddress = routingFormPath('72100000-0000-4000-8000-000000000001', ME.organization.id)
const managerAddresses = [PATHS.routingForms, PATHS.newRoutingForm, editorAddress]

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

describe('only gated routing pages are declared', () => {
  it('keeps only the gated manager paths in appRoutes and PATHS', () => {
    const paths = routePaths(appRoutes)
    expect(paths).toContain('/app/event-types')
    expect(paths).toContain('/:handle/:slug')
    expect(paths.filter(isRoutingName)).toEqual(MANAGER_PATHS.map((path) => `/app/${path}`))
    expect(Object.keys(PATHS).filter(isRoutingName)).toEqual(['routingForms', 'newRoutingForm'])
    expect(Object.values(PATHS).filter(isRoutingName)).toEqual(managerAddresses.slice(0, 2))
    for (const address of managerAddresses) {
      const matches = matchRoutes(appRoutes, address)
      const parent = matches?.at(-2)?.route.element
      expect(isValidElement(parent) && parent.type).toBe(RequireRoutingForms)
    }
  })

  it('declares only the known routing paths in the web source', () => {
    const sources = webSources()
    expect(sources.map(([file]) => file)).toEqual(
      expect.arrayContaining(['main.tsx', 'App.tsx', 'pages/NotFound.tsx']),
    )
    const paths = sources.flatMap(([file, source]) => routePathsIn(file, source))
    // main.tsx's data router, absolute, relative and PATHS-based routes in App.tsx.
    expect(paths).toEqual(
      expect.arrayContaining(['*', '/:handle/:slug', 'event-types', 'PATHS.join']),
    )
    expect(paths.filter(isRoutingName).sort()).toEqual(GATED_FORM_PATHS.toSorted())
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
    const existing = file === 'App.tsx' ? GATED_FORM_PATHS.toSorted() : []
    expect(routePathsIn(file, source).filter(isRoutingName).sort()).toEqual(existing)
    expect(routePathsIn(file, `${source}\n${added}\n`).filter(isRoutingName)).toHaveLength(
      existing.length + 1,
    )
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

const routingNav = () =>
  within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('link', {
    name: 'Routing forms',
  })

function expectEditorControlsHidden() {
  expect(screen.queryByText('Routing rules', { exact: true })).toBeNull()
  expect(screen.queryByText('Fallback', { exact: true })).toBeNull()
  expect(screen.queryByText('Answer mappings', { exact: true })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Run preview' })).toBeNull()
}

describe('routing manager capability', () => {
  it.each(managerAddresses)(
    'shows the ordinary not-found page while off at %s',
    async (address) => {
      const api = fakeApi({
        ...signedIn,
        'GET /api/v1/instance': () => json(200, { routingFormsEnabled: false }),
      })
      renderApp(address)
      await screen.findByRole('heading', { name: 'Page not found' })
      expect(screen.getByText('There is nothing at this address.')).toBeDefined()
      expect(routingNav()).toBeNull()
      expectEditorControlsHidden()
      expect(api.to('GET /api/v1/instance')).toHaveLength(1)
      expect(api.calls.filter(({ path }) => isRoutingName(path))).toEqual([])
      expect(api.to('GET /api/v1/event-types')).toHaveLength(0)
    },
  )

  it('keeps the direct rule editor gated before discovery confirms routing is off', async () => {
    const instance = later()
    const api = fakeApi({
      ...signedIn,
      'GET /api/v1/instance': () => instance.response,
    })
    renderApp(editorAddress)
    await screen.findByRole('navigation', { name: 'Main' })
    expectEditorControlsHidden()
    expect(api.calls.filter(({ path }) => isRoutingName(path))).toEqual([])
    expect(api.to('GET /api/v1/event-types')).toHaveLength(0)

    await instance.answer(json(200, { routingFormsEnabled: false }))
    await screen.findByRole('heading', { name: 'Page not found' })
    expectEditorControlsHidden()
    expect(api.calls.filter(({ path }) => isRoutingName(path))).toEqual([])
    expect(api.to('GET /api/v1/event-types')).toHaveLength(0)
  })

  it('waits for instance discovery without mounting the list or showing a navigation link', async () => {
    const instance = later()
    const api = fakeApi({
      ...signedIn,
      'GET /api/v1/instance': () => instance.response,
      'GET /api/v1/routing-forms': () => json(200, { data: [], nextCursor: null }),
    })
    renderApp(PATHS.routingForms)
    await screen.findByRole('navigation', { name: 'Main' })
    expect(routingNav()).toBeNull()
    expect(api.to('GET /api/v1/routing-forms')).toHaveLength(0)
    await instance.answer(
      json(200, { routingFormsEnabled: true, privacyPolicyUrl: 'https://example.test/privacy' }),
    )
    await screen.findByText('No routing forms yet.')
    expect(routingNav()?.getAttribute('href')).toBe(PATHS.routingForms)
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toBeDefined()
    expect(api.to('GET /api/v1/instance')).toHaveLength(1)
  })

  it.each([json(200, {}), json(503, { error: 'unavailable' })])(
    'fails closed without a confirmed capability (instance HTTP $status)',
    async (response) => {
      const api = fakeApi({ ...signedIn, 'GET /api/v1/instance': () => response })
      renderApp(PATHS.routingForms)
      await screen.findByRole('heading', { name: 'Page not found' })
      expect(routingNav()).toBeNull()
      expect(api.calls.filter(({ path }) => isRoutingName(path))).toEqual([])
    },
  )
})
