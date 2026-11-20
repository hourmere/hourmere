import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createSatteriMarkdownProcessor } from '@astrojs/markdown-satteri'
import { describe, expect, it } from 'vitest'
import { API_KEY_MCP_OPERATIONS } from '../packages/auth/src/api-key-operations.ts'
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
  const needle = '| `full, read, bookings` |'
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

async function verifyRenderedCells(render: typeof renderScopeTables) {
  const processor = await createSatteriMarkdownProcessor({ syntaxHighlight: false })
  const { code: html } = await processor.render(render('mcp'))
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map(([, row]) => [...(row ?? '').matchAll(/<td>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell))
    .filter((cells) => cells.length > 0)
  expect(rows).toHaveLength(API_KEY_MCP_OPERATIONS.length)
  for (const cells of rows) {
    expect(cells).toHaveLength(4)
    expect(cells[0]).toMatch(/^<code>\w+<\/code>$/)
    expect(cells[1]).toMatch(/^(?:<code>\w+<\/code>|—)$/)
    expect(cells[2]).toMatch(/^(?:<code>[\w, -]+<\/code>|—)$/)
    expect(cells[3]).toMatch(/^<code>(?:full|read|bookings)(?:, (?:full|read|bookings))*<\/code>$/)
  }
  expect(rows).toContainEqual([
    '<code>create_booking</code>',
    '<code>oneTimeLink</code>',
    '<code>book</code>',
    '<code>full, bookings</code>',
  ])
  expect(rows).toContainEqual([
    '<code>reschedule_booking</code>',
    '<code>host</code>',
    '<code>reschedule</code>',
    '<code>full, bookings</code>',
  ])
}

describe('published API key scope tables', () => {
  it.each(documents)('$path publishes the meeting poll host scopes', ({ document, section }) => {
    for (const [method, path, tool, command, scopes] of [
      ['POST', '/meeting-polls', 'create_meeting_poll', 'create', 'full, bookings'],
      [
        'POST',
        '/meeting-polls/{id}/invitations',
        'invite_meeting_poll_voters',
        'invite',
        'full, bookings',
      ],
      [
        'POST',
        '/meeting-polls/{id}/invitations/{voterId}/resend',
        'resend_meeting_poll_invitation',
        'resend-invitation',
        'full, bookings',
      ],
      [
        'DELETE',
        '/meeting-polls/{id}/voters/{voterId}',
        'remove_meeting_poll_voter',
        'remove-voter',
        'full, bookings',
      ],
      [
        'POST',
        '/meeting-polls/{id}/remove-unverified',
        'remove_unverified_meeting_poll_voters',
        'remove-unverified',
        'full, bookings',
      ],
      [
        'POST',
        '/meeting-polls/{id}/rotate-link',
        'rotate_meeting_poll_link',
        'rotate-link',
        'full, bookings',
      ],
      ['GET', '/meeting-polls', 'list_meeting_polls', 'list', 'full, read, bookings'],
      ['GET', '/meeting-polls/{id}', 'get_meeting_poll', 'get', 'full, read, bookings'],
      [
        'GET',
        '/meeting-polls/{id}/results',
        'get_meeting_poll_results',
        'results',
        'full, read, bookings',
      ],
      ['POST', '/meeting-polls/{id}/close', 'close_meeting_poll', 'close', 'full, bookings'],
      ['POST', '/meeting-polls/{id}/cancel', 'cancel_meeting_poll', 'cancel', 'full, bookings'],
      ['DELETE', '/meeting-polls/{id}', 'delete_meeting_poll', 'delete', 'full, bookings'],
      [
        'POST',
        '/meeting-polls/{id}/finalize',
        'finalize_meeting_poll',
        'finalize',
        'full, bookings',
      ],
    ]) {
      expect(document).toContain(`| \`${tool}\` | — | \`polls ${command}\` | \`${scopes}\` |`)
      if (section === 'all')
        expect(document).toContain(
          `| \`${method} /api/v1${path}\` | Session or API key | \`${scopes}\` |`,
        )
    }
  })

  it.each(documents)(
    '$path labels the published SSO reads unavailable outside generated tables',
    ({ document }) => {
      const after = document.slice(document.indexOf(SCOPE_TABLE_END) + SCOPE_TABLE_END.length)
      expect(after).toContain('SSO is being built and is not available yet')
      expect(after).toContain('404 sso_disabled')
      expect(after).toContain('SSO 正在开发中，尚不可用')
      for (const name of [
        'list_sso_providers',
        'get_sso_policy',
        'sso providers list',
        'sso policy',
      ])
        expect(
          document.slice(document.indexOf(SCOPE_TABLE_START), document.indexOf(SCOPE_TABLE_END)),
        ).toContain(name)
    },
  )

  it('documents SSO trust writes as session-only without machine write commands', () => {
    for (const { document, section } of documents) {
      if (section !== 'all') continue
      for (const operation of [
        'POST /api/v1/team/sso/domains',
        'POST /api/v1/team/sso/domains/{domainId}/verify',
        'DELETE /api/v1/team/sso/domains/{domainId}',
        'POST /api/v1/team/sso/providers',
        'PATCH /api/v1/team/sso/providers/{providerId}',
        'DELETE /api/v1/team/sso/providers/{providerId}',
        'POST /api/v1/team/sso/providers/{providerId}/test',
        'POST /api/v1/team/sso/providers/{providerId}/link',
        'DELETE /api/v1/team/sso/providers/{providerId}/link',
        'DELETE /api/v1/team/sso/providers/{providerId}/links/{linkId}',
        'POST /api/v1/team/sso/delegations',
        'DELETE /api/v1/team/sso/delegations/{bindingId}',
        'POST /api/v1/team/sso/recovery',
        'POST /api/v1/team/sso/recovery/{enrollmentId}/accept',
      ])
        expect(document).toContain(`| \`${operation}\` | Browser session only | — |`)
    }
    for (const tool of [
      'create_sso_provider',
      'update_sso_provider',
      'delete_sso_provider',
      'test_sso_provider',
      'link_sso_account',
      'unlink_sso_account',
      'remove_sso_identity_link',
      'create_sso_domain_challenge',
      'verify_sso_domain',
      'delete_sso_domain',
      'bind_sso_delegation',
      'revoke_sso_delegation',
      'configure_sso_recovery',
      'accept_sso_recovery_enrollment',
    ])
      expect(API_KEY_MCP_OPERATIONS.some((operation) => operation.tool === tool)).toBe(false)
  })

  it('keeps the public SSO limitation current', () => {
    expect(
      readFileSync(new URL('../apps/site/src/content/docs/docs/index.md', import.meta.url), 'utf8'),
    ).toContain('Organization OIDC/SAML SSO is being built and is not available yet.')
  })

  it.each(documents)(
    '$path explains the routing hard-off beside the generated table',
    ({ document }) => {
      expect(document.slice(0, document.indexOf(SCOPE_TABLE_START))).toContain(
        'Routing operations return `routing_forms_disabled` until an operator enables routing.',
      )
    },
  )

  it.each(documents)(
    '$path lists publication and preview as full-scope only',
    ({ document, section }) => {
      for (const verb of ['publish', 'preview']) {
        expect(document).toContain(
          `| \`${verb}_routing_form\` | — | \`routing-forms ${verb}\` | \`full\` |`,
        )
        if (section === 'all')
          expect(document).toContain(
            `| \`POST /api/v1/routing-forms/{id}/${verb}\` | Session or API key | \`full\` |`,
          )
      }
    },
  )

  it.each(documents)('$path lists workflow preview as full-scope only', ({ document, section }) => {
    expect(document).toContain('| `preview_workflow` | — | `workflows preview` | `full` |')
    if (section === 'all')
      expect(document).toContain(
        '| `POST /api/v1/workflows/preview` | Session or API key | `full` |',
      )
  })

  it.each(documents)(
    '$path lists optional-key public routing metadata and submission',
    ({ document, section }) => {
      expect(document).toContain(
        '| `get_public_routing_form` | — | `routing-forms public` | `full, read, bookings` |',
      )
      expect(document).toContain('| `route_lead` | — | `routing-forms route` | `full, bookings` |')
      if (section === 'all') {
        for (const path of ['{handle}/{slug}', 'teams/{teamSlug}/{slug}']) {
          expect(document).toContain(
            `| \`GET /api/v1/public/-/routing/${path}\` | Public or manage token; check a supplied key | \`full, read, bookings\` |`,
          )
          expect(document).toContain(
            `| \`POST /api/v1/public/-/routing/${path}/route\` | Public or manage token; check a supplied key | \`full, bookings\` |`,
          )
        }
      }
    },
  )

  it.each(documents)('$path publishes webhook management scopes', ({ document, section }) => {
    expect(document).toContain('| `list_webhooks` | — | `webhooks list` | `full, read` |')
    expect(document).toContain('| `create_webhook` | — | `webhooks create` | `full` |')
    expect(document).toContain('| `update_webhook` | — | `webhooks update` | `full` |')
    expect(document).toContain('| `delete_webhook` | — | `webhooks delete` | `full` |')
    expect(document).toContain(
      '| `rotate_webhook_secret` | — | `webhooks rotate-secret` | `full` |',
    )
    expect(document).toContain(
      '| `list_webhook_deliveries` | — | `webhooks deliveries` | `full, read` |',
    )
    if (section === 'all') {
      expect(document).toContain('| `GET /api/v1/webhooks` | Session or API key | `full, read` |')
      expect(document).toContain('| `POST /api/v1/webhooks` | Session or API key | `full` |')
      expect(document).toContain('| `PATCH /api/v1/webhooks/{id}` | Session or API key | `full` |')
      expect(document).toContain('| `DELETE /api/v1/webhooks/{id}` | Session or API key | `full` |')
      expect(document).toContain(
        '| `POST /api/v1/webhooks/{id}/rotate-secret` | Session or API key | `full` |',
      )
      expect(document).toContain(
        '| `GET /api/v1/webhooks/{id}/deliveries` | Session or API key | `full, read` |',
      )
    }
  })

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
    expect(rendered).toContain('`reschedule_booking` | `host`')
    expect(rendered).toContain('`reschedule_booking` | `manageToken`')
    expect(rendered).toContain('`GET /api/health` | Public health check; no key needed')
    expect(rendered).toContain('`POST /api/v1/event-types/{id}/duplicate`')
    expect(rendered).toContain('| `duplicate_event_type` | — | `duplicate-event` | `full` |')
    expect(rendered).toContain('`POST /api/conference/zoom/events` | Provider signature')
  })

  it('renders scope lists in one code span with tool modes in separate cells', async () => {
    await verifyRenderedCells(renderScopeTables)
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
  it('kills splitting rendered scope lists into code spans with plain separators', async () => {
    await verifyRenderedCells(sourceCopy().renderScopeTables)
    await expect(
      verifyRenderedCells(
        sourceCopy({
          renderer: ["code(values.join(', '))", "values.map(code).join(', ')"],
        }).renderScopeTables,
      ),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
    await verifyRenderedCells(sourceCopy().renderScopeTables)
  })

  it('kills joining a tool and mode inside one rendered cell', async () => {
    await expect(
      verifyRenderedCells(
        sourceCopy({
          renderer: [
            'code(operation.tool),',
            "code(operation.tool) + (operation.mode === undefined ? '' : ' / ' + code(operation.mode)),",
          ],
        }).renderScopeTables,
      ),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
    await verifyRenderedCells(sourceCopy().renderScopeTables)
  })
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
