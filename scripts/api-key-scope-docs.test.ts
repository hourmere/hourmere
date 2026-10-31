import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  renderScopeTables,
  replaceScopeTables,
  SCOPE_DOC_FILES,
  SCOPE_TABLE_END,
  SCOPE_TABLE_START,
  scopeDocumentationMatches,
} from './api-key-scope-docs.ts'

const documents = SCOPE_DOC_FILES.map(({ path, section }) => ({
  path,
  section,
  document: readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
}))

type Renderer = typeof import('./api-key-scope-docs.ts')
type Replacement = readonly [string, string]

function stripModule(source: string): string {
  return stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
}

function mutate(source: string, replacement?: Replacement): string {
  if (!replacement) return source
  expect(source.includes(replacement[0]), 'source-copy mutation anchor').toBe(true)
  return source.replace(replacement[0], replacement[1])
}

/** Compile isolated copies; neither the live registry nor published files are modified. */
function sourceCopy(options: { renderer?: Replacement; registry?: Replacement } = {}): Renderer {
  const registry = new Function(
    `${stripModule(
      mutate(
        readFileSync(
          new URL('../packages/auth/src/api-key-operations.ts', import.meta.url),
          'utf8',
        ),
        options.registry,
      ),
    )}; return { API_KEY_REST_OPERATIONS, API_KEY_MCP_OPERATIONS, API_KEY_CLI_OPERATIONS, API_KEY_NATIVE_REST_BOUNDARIES }`,
  )() as Record<string, unknown>
  return new Function(
    ...Object.keys(registry),
    `${stripModule(
      mutate(
        readFileSync(new URL('./api-key-scope-docs.ts', import.meta.url), 'utf8'),
        options.renderer,
      ),
    )}; return { renderScopeTables, replaceScopeTables, scopeDocumentationMatches }`,
  )(...Object.values(registry)) as Renderer
}

function changedDocument(document: string): string {
  const needle = '| `full`, `read`, `bookings` |'
  expect(document.includes(needle), 'published scope mutation anchor').toBe(true)
  return document.replace(needle, '| `full` |')
}

function verifyPublishedTables(renderer: Renderer) {
  for (const { path, section, document } of documents) {
    expect(renderer.scopeDocumentationMatches(document, section), path).toBe(true)
  }
}

function verifyDriftRejected(renderer: Renderer) {
  for (const { path, section, document } of documents) {
    expect(renderer.scopeDocumentationMatches(changedDocument(document), section), path).toBe(false)
  }
}

describe('published API key scope tables', () => {
  it.each(documents)(
    '$path matches the live operation registry exactly',
    ({ document, section }) => {
      expect(scopeDocumentationMatches(document, section)).toBe(true)
      expect(replaceScopeTables(document, section)).toBe(document)
    },
  )

  it.each(documents)('$path rejects a changed published permission', ({ document, section }) => {
    expect(scopeDocumentationMatches(changedDocument(document), section)).toBe(false)
  })

  it('publishes every MCP mode and each native REST boundary from the registry', () => {
    const rendered = renderScopeTables('all')
    expect(rendered).toContain('`reschedule_booking` / `host`')
    expect(rendered).toContain('`reschedule_booking` / `manageToken`')
    expect(rendered).toContain('`GET /api/health` | Public health check; no key needed')
    expect(rendered).toContain('`POST /api/conference/zoom/events` | Provider signature')
  })

  it('preserves prose outside the generated section', () => {
    const document = `Before\n${SCOPE_TABLE_START}\nstale table\n${SCOPE_TABLE_END}\nAfter\n`
    expect(replaceScopeTables(document, 'mcp')).toBe(`Before\n${renderScopeTables('mcp')}\nAfter\n`)
  })

  it.each([
    '',
    SCOPE_TABLE_START,
    SCOPE_TABLE_END + SCOPE_TABLE_START,
    SCOPE_TABLE_START + SCOPE_TABLE_END + SCOPE_TABLE_START,
    SCOPE_TABLE_START + SCOPE_TABLE_END + SCOPE_TABLE_END,
  ])('rejects missing, reversed or duplicate markers (%j)', (document) => {
    expect(() => replaceScopeTables(document, 'all')).toThrow(
      /generated API key scope table markers/,
    )
  })
})

describe('scope documentation source-copy mutation checks', () => {
  it('accepts the unmodified copies and rejects altered document copies', () => {
    verifyPublishedTables(sourceCopy())
    verifyDriftRejected(sourceCopy())
  })

  it('kills a permission change in an isolated copy of the authorization registry', () => {
    expect(() =>
      verifyPublishedTables(
        sourceCopy({
          registry: [
            "booking_write: Object.freeze(['full', 'bookings'] as const)",
            "booking_write: Object.freeze(['full', 'read', 'bookings'] as const)",
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    verifyPublishedTables(sourceCopy())
  })

  it('kills bypassing the exact published table comparison', () => {
    expect(() =>
      verifyDriftRejected(
        sourceCopy({
          renderer: ['return replaceScopeTables(document, section) === document', 'return true'],
        }),
      ),
    ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    verifyDriftRejected(sourceCopy())
  })

  it('kills omitting MCP modes from the generated inventory', () => {
    expect(() =>
      verifyPublishedTables(
        sourceCopy({
          renderer: [
            'policy.mcp.map((operation)',
            'policy.mcp.filter((operation) => operation.mode === undefined).map((operation)',
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    verifyPublishedTables(sourceCopy())
  })

  it.each([
    {
      label: 'missing/reversed markers',
      replacement: ['if (start === -1 || end < start)', 'if (false)'],
      document: '',
    },
    {
      label: 'duplicate start marker',
      replacement: ['document.indexOf(SCOPE_TABLE_START, start + 1) !== -1 ||', 'false ||'],
      document: SCOPE_TABLE_START + SCOPE_TABLE_END + SCOPE_TABLE_START,
    },
    {
      label: 'duplicate end marker',
      replacement: ['document.indexOf(SCOPE_TABLE_END, end + 1) !== -1', 'false'],
      document: SCOPE_TABLE_START + SCOPE_TABLE_END + SCOPE_TABLE_END,
    },
  ] as const)('kills bypassing $label protection', ({ replacement, document }) => {
    const verify = (renderer: Renderer) => {
      expect(() => renderer.replaceScopeTables(document, 'all')).toThrow(
        /generated API key scope table markers/,
      )
    }
    verify(sourceCopy())
    expect(() => verify(sourceCopy({ renderer: replacement }))).toThrow(
      expect.objectContaining({ name: 'AssertionError' }),
    )
    verify(sourceCopy())
  })
})
