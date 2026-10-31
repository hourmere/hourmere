import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  type HttpMethod,
  type InterfaceInventory,
  interfaceParityErrors,
  knownGapRatchetErrors,
  loadInterfaceInventory,
  loadKnownGapBaseline,
  restOperations,
} from './interface-parity.ts'

const source = readFileSync(new URL('./interface-parity.ts', import.meta.url), 'utf8')
const checkedMapping: unknown = JSON.parse(
  readFileSync(new URL('./interface-parity.json', import.meta.url), 'utf8'),
)
const checkedGaps: unknown = JSON.parse(
  readFileSync(new URL('./interface-parity-known-gaps.json', import.meta.url), 'utf8'),
)
const baseline: InterfaceInventory = {
  rest: [
    {
      path: '/api/v1/bookings',
      method: 'post',
      operationId: 'createBooking',
      security: [{ session: [] }],
    },
  ],
  mcp: ['create_booking', 'cancel_booking'],
  cli: { book: 'create_booking', cancel: 'cancel_booking' },
}
const mapping = { createBooking: { mcp: 'create_booking', cli: 'book' } }
type Checker = Pick<
  typeof import('./interface-parity.ts'),
  'interfaceParityErrors' | 'restOperations' | 'knownGapRatchetErrors' | 'loadKnownGapBaseline'
>
const original: Checker = {
  interfaceParityErrors,
  restOperations,
  knownGapRatchetErrors,
  loadKnownGapBaseline,
}
const cases: { name: string; verify: (checker: Checker) => void }[] = []
const exemption = (reason: unknown = 'Existing browser consent flow requires a live session.') => ({
  exemption: 'browser-session-only',
  reason,
})
const missingMapping =
  'missing MCP/CLI mapping, verified browser-session-only exemption or frozen known gap.'
const malformedMapping =
  'expected exactly {mcp, cli} or {exemption: "browser-session-only", reason}.'

function check(name: string, verify: (checker: Checker) => void) {
  cases.push({ name, verify })
}

check('accepts real MCP/CLI equivalents and a reasoned exemption', ({ interfaceParityErrors }) => {
  expect(interfaceParityErrors(baseline, mapping)).toEqual([])
  expect(
    interfaceParityErrors(baseline, {
      createBooking: exemption(),
    }),
  ).toEqual([])
})

for (const method of ['post', 'put', 'patch', 'delete'] as const) {
  check(
    `requires parity for an unmapped ${method.toUpperCase()} write`,
    ({ interfaceParityErrors }) => {
      const inventory: InterfaceInventory = {
        ...baseline,
        rest: [...baseline.rest, { path: '/api/v1/fake', method, operationId: 'fakeWrite' }],
      }
      expect(interfaceParityErrors(inventory, mapping)).toContain(
        `fakeWrite (${method.toUpperCase()} /api/v1/fake): ${missingMapping}`,
      )
    },
  )
}

check('allows unmapped read operations', ({ interfaceParityErrors }) => {
  expect(
    interfaceParityErrors(
      {
        ...baseline,
        rest: [
          ...baseline.rest,
          { path: '/api/v1/bookings', method: 'get', operationId: 'listBookings' },
          { path: '/api/v1/bookings', method: 'head' },
        ],
      },
      mapping,
    ),
  ).toEqual([])
})

for (const operationId of [undefined, null, '', ' ', '1bad', 'bad id', 'bad\nid', 'bad\n', 42]) {
  check(
    `rejects missing or malformed write operationId ${JSON.stringify(operationId)}`,
    ({ interfaceParityErrors }) => {
      expect(
        interfaceParityErrors(
          { ...baseline, rest: [{ path: '/api/v1/fake', method: 'post', operationId }] },
          {},
        ),
      ).toContain('POST /api/v1/fake: missing or malformed operationId; use a stable identifier.')
    },
  )
}

check('rejects duplicate IDs including collisions with reads', ({ interfaceParityErrors }) => {
  expect(
    interfaceParityErrors(
      {
        ...baseline,
        rest: [
          ...baseline.rest,
          { path: '/api/v1/other', method: 'get', operationId: 'createBooking' },
        ],
      },
      mapping,
    ),
  ).toContain(
    'createBooking: duplicate operationId on POST /api/v1/bookings and GET /api/v1/other.',
  )
})

for (const entry of [mapping.createBooking, exemption('Legacy browser-only operation.')]) {
  const kind = 'exemption' in entry ? 'exemption' : 'mapping'
  check(`rejects a stale ${kind}`, ({ interfaceParityErrors }) => {
    expect(interfaceParityErrors(baseline, { ...mapping, removedWrite: entry })).toContain(
      `removedWrite: stale ${kind}; no REST write operation has this operationId.`,
    )
  })
}

check('rejects an exemption after its operation becomes read-only', ({ interfaceParityErrors }) => {
  expect(
    interfaceParityErrors(
      {
        ...baseline,
        rest: [{ path: '/api/v1/bookings', method: 'get', operationId: 'createBooking' }],
      },
      { createBooking: exemption('Legacy browser-only operation.') },
    ),
  ).toContain('createBooking: stale exemption; no REST write operation has this operationId.')
})

check('rejects an unregistered MCP tool', ({ interfaceParityErrors }) => {
  expect(
    interfaceParityErrors(baseline, {
      createBooking: { mcp: 'nonexistent_tool', cli: 'book' },
    }),
  ).toContain('createBooking: MCP tool "nonexistent_tool" is not registered.')
})

check('rejects a nonexistent CLI command', ({ interfaceParityErrors }) => {
  expect(
    interfaceParityErrors(baseline, {
      createBooking: { mcp: 'create_booking', cli: 'nonexistent-command' },
    }),
  ).toContain('createBooking: CLI command "nonexistent-command" does not exist.')
})

check(
  'rejects a CLI command that invokes a different real MCP tool',
  ({ interfaceParityErrors }) => {
    expect(
      interfaceParityErrors(baseline, {
        createBooking: { mcp: 'create_booking', cli: 'cancel' },
      }),
    ).toContain(
      'createBooking: CLI command "cancel" invokes "cancel_booking", not mapped MCP tool "create_booking".',
    )
  },
)

for (const reason of ['', '  ', '\n', 'First line.\nSecond line.', 'First\rSecond', '\u2028', 42]) {
  check(
    `rejects an invalid exemption reason ${JSON.stringify(reason)}`,
    ({ interfaceParityErrors }) => {
      expect(interfaceParityErrors(baseline, { createBooking: exemption(reason) })).toContain(
        'createBooking: exemption needs a nonempty, one-line reason.',
      )
    },
  )
}

for (const entry of [
  null,
  [],
  'create_booking',
  {},
  { mcp: 'create_booking' },
  { cli: 'book' },
  { mcp: 'create_booking', cli: 'book', exemption: 'Both are forbidden.' },
  { mcp: 'create_booking', cli: 'book', typo: true },
  { exemption: 'A reason.', typo: true },
  { ...exemption(), typo: true },
  { exemption: 'Gap: missing MCP/CLI support.' },
  { exemption: 'Gap: missing MCP/CLI support.', reason: 'A reason.' },
  { exemption: 'browser-session-only' },
  { exemption: 'browser-session-only', typo: true },
  { mcp: '', cli: 'book' },
  { mcp: 'create_booking', cli: '' },
]) {
  check(`rejects malformed mapping entry ${JSON.stringify(entry)}`, ({ interfaceParityErrors }) => {
    let errors: string[] = []
    expect(() => {
      errors = interfaceParityErrors(baseline, { createBooking: entry })
    }, 'Malformed entries must return diagnostics without crashing the guard.').not.toThrow()
    expect(errors).toContain(`createBooking: ${malformedMapping}`)
  })
}

for (const value of [null, [], 'not an object']) {
  check(`rejects a non-object mapping ${JSON.stringify(value)}`, ({ interfaceParityErrors }) => {
    let errors: string[] = []
    expect(() => {
      errors = interfaceParityErrors(baseline, value)
    }, 'Malformed mapping documents must return diagnostics without crashing the guard.').not.toThrow()
    expect(errors).toContain(
      'Interface parity mapping must be an object keyed by REST write operationId.',
    )
  })
}

check('does not accept inherited mapping or command names', ({ interfaceParityErrors }) => {
  expect(interfaceParityErrors(baseline, Object.create(mapping))).toContain(
    `createBooking (POST /api/v1/bookings): ${missingMapping}`,
  )
  expect(
    interfaceParityErrors(baseline, { createBooking: { mcp: 'create_booking', cli: 'toString' } }),
  ).toContain('createBooking: CLI command "toString" does not exist.')
})

check('reports all failures with readable routes in stable order', ({ interfaceParityErrors }) => {
  const errors = interfaceParityErrors(
    {
      ...baseline,
      rest: [
        ...baseline.rest,
        { path: '/api/v1/fake', method: 'delete', operationId: 'fakeWrite' },
      ],
    },
    { createBooking: { mcp: 'missing_tool', cli: 'missing-command' }, stale: exemption('') },
  )
  expect(errors).toEqual([
    'createBooking: CLI command "missing-command" does not exist.',
    'createBooking: MCP tool "missing_tool" is not registered.',
    `fakeWrite (DELETE /api/v1/fake): ${missingMapping}`,
    'stale: exemption needs a nonempty, one-line reason.',
    'stale: stale exemption; no REST write operation has this operationId.',
  ])
})

check('extracts all real HTTP methods under the exact /api/v1 prefix', ({ restOperations }) => {
  const methods: HttpMethod[] = [
    'get',
    'head',
    'options',
    'trace',
    'post',
    'put',
    'patch',
    'delete',
  ]
  const item = Object.fromEntries(
    methods.map((method) => [method, { operationId: `${method}Item` }]),
  )
  const paths = {
    '/api/v1/items': { ...item, parameters: [{ name: 'ignored' }] },
    '/api/v1': { post: { operationId: 'rootWrite' } },
    '/api/v10/items': item,
    '/api/auth/sign-in': item,
    '/elsewhere/api/v1/items': item,
  }
  expect(restOperations({ paths })).toEqual([
    ...methods.map((method) => ({
      path: '/api/v1/items',
      method,
      operationId: `${method}Item`,
      security: undefined,
    })),
    { path: '/api/v1', method: 'post', operationId: 'rootWrite', security: undefined },
  ])
})

check('preserves a write missing its ID in the OpenAPI inventory', ({ restOperations }) => {
  expect(restOperations({ paths: { '/api/v1/fake': { post: {} } } })).toEqual([
    { path: '/api/v1/fake', method: 'post', operationId: undefined, security: undefined },
  ])
})

check('rejects malformed OpenAPI documents and path items', ({ restOperations }) => {
  for (const document of [null, {}, { paths: [] }]) {
    expect(() => restOperations(document)).toThrow(
      'The generated OpenAPI document must contain a paths object.',
    )
  }
  expect(() => restOperations({ paths: { '/api/v1/fake': null } })).toThrow(
    'OpenAPI path /api/v1/fake must contain an object.',
  )
})

for (const security of [
  undefined,
  null,
  [],
  [{}],
  [{ apiKey: [] }],
  [{ session: [] }, { apiKey: [] }],
  [{ session: [], apiKey: [] }],
  [{ session: ['scope'] }],
  [{ session: 'cookie' }],
  [{ session: '' }],
  [Object.assign(Object.create({ session: [] }), { apiKey: [] })],
  [null],
  [{ session: [] }, {}],
]) {
  check(
    `rejects an unjustified session exemption with security ${JSON.stringify(security)}`,
    ({ interfaceParityErrors }) => {
      let errors: string[] = []
      expect(() => {
        errors = interfaceParityErrors(
          {
            ...baseline,
            rest: [{ ...baseline.rest[0], security } as InterfaceInventory['rest'][number]],
          },
          { createBooking: exemption() },
        )
      }).not.toThrow()
      expect(errors).toContain(
        'createBooking: browser-session-only exemption requires OpenAPI security exactly [{session: []}]; add the MCP tool and CLI command instead.',
      )
    },
  )
}

check('uses the effective OpenAPI security including operation overrides', ({ restOperations }) => {
  expect(
    restOperations({
      security: [{ apiKey: [] }],
      paths: {
        '/api/v1/items': {
          post: { operationId: 'createItem' },
          put: { operationId: 'updateItem', security: [{ session: [] }] },
          patch: { operationId: 'patchItem', security: [] },
        },
      },
    }),
  ).toEqual([
    {
      path: '/api/v1/items',
      method: 'post',
      operationId: 'createItem',
      security: [{ apiKey: [] }],
    },
    {
      path: '/api/v1/items',
      method: 'put',
      operationId: 'updateItem',
      security: [{ session: [] }],
    },
    { path: '/api/v1/items', method: 'patch', operationId: 'patchItem', security: [] },
  ])
})

const gapInventory: InterfaceInventory = {
  ...baseline,
  rest: [{ ...baseline.rest[0], security: [{ apiKey: [] }] } as InterfaceInventory['rest'][number]],
}
const gap = { createBooking: 'Existing MCP/CLI booking capability is missing.' }

check(
  'accepts a frozen known gap while allowing the list to shrink',
  ({ interfaceParityErrors, knownGapRatchetErrors }) => {
    expect(interfaceParityErrors(gapInventory, {}, gap)).toEqual([])
    expect(knownGapRatchetErrors(gap, gap)).toEqual([])
    expect(knownGapRatchetErrors({}, gap)).toEqual([])
  },
)

check('requires a mapping after removing a known gap', ({ interfaceParityErrors }) => {
  expect(interfaceParityErrors(gapInventory, {}, {})).toContain(
    `createBooking (POST /api/v1/bookings): ${missingMapping}`,
  )
})

check('rejects new gaps even with a concrete reason', ({ knownGapRatchetErrors }) => {
  expect(
    knownGapRatchetErrors(
      { zWrite: 'No tools.', ...gap, newWrite: 'New operation has no tools yet.' },
      gap,
    ),
  ).toEqual([
    'newWrite: new MCP/CLI gaps are forbidden; add the MCP tool and CLI command instead.',
    'zWrite: new MCP/CLI gaps are forbidden; add the MCP tool and CLI command instead.',
  ])
})

check('does not reintroduce a previously removed original gap', ({ knownGapRatchetErrors }) => {
  expect(knownGapRatchetErrors({ updateProfile: 'This was an original gap.' }, {})).toEqual([
    'updateProfile: new MCP/CLI gaps are forbidden; add the MCP tool and CLI command instead.',
  ])
  expect(knownGapRatchetErrors(gap, Object.create(gap))).toEqual([
    'createBooking: new MCP/CLI gaps are forbidden; add the MCP tool and CLI command instead.',
  ])
})

for (const reason of [
  '',
  ' ',
  '\n',
  'First\nSecond',
  '\u2029',
  42,
  { reason: 'Nested reasons are forbidden.' },
]) {
  check(
    `rejects an invalid known-gap reason ${JSON.stringify(reason)}`,
    ({ interfaceParityErrors }) => {
      expect(interfaceParityErrors(gapInventory, {}, { createBooking: reason })).toContain(
        'createBooking: known gap needs a nonempty, one-line reason.',
      )
    },
  )
}

for (const value of [null, [], 'not an object']) {
  check(
    `rejects malformed gap documents ${JSON.stringify(value)}`,
    ({ interfaceParityErrors, knownGapRatchetErrors }) => {
      let errors: string[] = []
      expect(() => {
        errors = interfaceParityErrors(gapInventory, {}, value)
      }).not.toThrow()
      expect(errors).toContain(
        'Known MCP/CLI gaps must be an object keyed by REST write operationId.',
      )
      expect(() => {
        errors = knownGapRatchetErrors(gap, value)
      }).not.toThrow()
      expect(errors).toEqual(['The committed interface-parity gap baseline must be an object.'])
      expect(() => {
        errors = knownGapRatchetErrors(value, {})
      }).not.toThrow()
      expect(errors).toEqual([])
    },
  )
}

check('requires removal of a known gap when parity is mapped', ({ interfaceParityErrors }) => {
  expect(interfaceParityErrors(gapInventory, mapping, gap)).toContain(
    'createBooking: stale known gap; remove it and keep the mapping or verified exemption.',
  )
})

check(
  'requires replacing a session-only known gap with its verified exemption',
  ({ interfaceParityErrors }) => {
    expect(interfaceParityErrors(baseline, {}, gap)).toContain(
      'createBooking: stale known gap; remove it and keep the mapping or verified exemption.',
    )
  },
)

for (const method of ['get', undefined] as const) {
  check(
    `rejects a stale known gap after its write is ${method ? 'read-only' : 'removed'}`,
    ({ interfaceParityErrors }) => {
      expect(
        interfaceParityErrors(
          {
            ...gapInventory,
            rest: method
              ? [{ ...gapInventory.rest[0], method } as InterfaceInventory['rest'][number]]
              : [],
          },
          {},
          gap,
        ),
      ).toContain('createBooking: stale known gap; no REST write operation has this operationId.')
    },
  )
}

check('does not accept inherited gap names', ({ interfaceParityErrors }) => {
  expect(interfaceParityErrors(gapInventory, {}, Object.create(gap))).toContain(
    `createBooking (POST /api/v1/bookings): ${missingMapping}`,
  )
})

const baselineCommit = 'a'.repeat(40)
const gapsPath = 'scripts/interface-parity-known-gaps.json'

check(
  'loads the ratchet from the verified base commit',
  ({ loadKnownGapBaseline, knownGapRatchetErrors }) => {
    const calls: string[][] = []
    const loaded = loadKnownGapBaseline('test-base', (args) => {
      calls.push(args)
      if (args[0] === 'rev-parse') return `${baselineCommit}\n`
      if (args[0] === 'ls-tree') return `${gapsPath}\n`
      if (args[0] === 'show') return JSON.stringify(gap)
      throw new Error('Unexpected Git command.')
    })
    expect(loaded).toEqual(gap)
    expect(calls).toEqual([
      ['rev-parse', '--verify', '--end-of-options', 'test-base^{commit}'],
      ['ls-tree', '--name-only', baselineCommit, '--', gapsPath],
      ['show', `${baselineCommit}:${gapsPath}`],
    ])
    expect(knownGapRatchetErrors({ updateProfile: 'An old gap was removed.' }, loaded)).toEqual([
      'updateProfile: new MCP/CLI gaps are forbidden; add the MCP tool and CLI command instead.',
    ])
  },
)

check(
  'bootstraps only the frozen original 20 gaps when the base predates this file',
  ({ loadKnownGapBaseline, knownGapRatchetErrors }) => {
    const loaded = loadKnownGapBaseline('test-base', (args) =>
      args[0] === 'rev-parse' ? baselineCommit : '',
    )
    expect(Object.keys(loaded as object)).toHaveLength(20)
    expect(knownGapRatchetErrors({ updateProfile: 'Original gap.' }, loaded)).toEqual([])
    expect(knownGapRatchetErrors({ newWrite: 'New gap.' }, loaded)).toEqual([
      'newWrite: new MCP/CLI gaps are forbidden; add the MCP tool and CLI command instead.',
    ])
  },
)

check('fails closed when the configured Git base is unavailable', ({ loadKnownGapBaseline }) => {
  expect(() =>
    loadKnownGapBaseline('missing-base', () => {
      throw new Error('Missing commit.')
    }),
  ).toThrow('Cannot resolve the interface-parity base commit; fetch its Git history.')
})

for (const commit of ['', 'short-sha', 'a'.repeat(41), 'g'.repeat(40)]) {
  check(
    `rejects an unverified base commit ${JSON.stringify(commit)}`,
    ({ loadKnownGapBaseline }) => {
      expect(() => loadKnownGapBaseline('test-base', () => commit)).toThrow(
        'The interface-parity base must resolve to a full Git commit ID.',
      )
    },
  )
}

check('fails closed on a corrupt baseline path or JSON', ({ loadKnownGapBaseline }) => {
  expect(() =>
    loadKnownGapBaseline('test-base', (args) =>
      args[0] === 'rev-parse' ? baselineCommit : 'other/path',
    ),
  ).toThrow('Unexpected interface-parity baseline path.')
  expect(() =>
    loadKnownGapBaseline('test-base', (args) => {
      if (args[0] === 'rev-parse') return baselineCommit
      if (args[0] === 'ls-tree') return gapsPath
      return 'invalid JSON'
    }),
  ).toThrow(SyntaxError)
})

describe('REST, MCP and CLI write parity', () => {
  it('covers the generated OpenAPI document using the registered tools and actual CLI table', async () => {
    const inventory = await loadInterfaceInventory()
    expect(inventory.rest.length).toBeGreaterThan(0)
    expect(inventory.mcp.length).toBeGreaterThan(0)
    expect(Object.keys(inventory.cli).length).toBeGreaterThan(0)
    const errors = [
      ...interfaceParityErrors(inventory, checkedMapping, checkedGaps),
      ...knownGapRatchetErrors(checkedGaps, loadKnownGapBaseline()),
    ].sort()
    expect(
      errors,
      `Interface parity failed:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    ).toEqual([])
  })

  for (const { name, verify } of cases) it(name, () => verify(original))
})

function sourceCopy(copy: string): Checker {
  // Importing a checker copy must not execute database or CLI entry points. Evaluate the
  // actual pure helpers; the unused loader still has its original body and is never called.
  const body = stripTypeScriptTypes(copy)
    .replace(/^import .*\n/gm, '')
    .replace(/^export /gm, '')
  return new Function(
    `${body}\nreturn {interfaceParityErrors, restOperations, knownGapRatchetErrors, loadKnownGapBaseline}`,
  )() as Checker
}

describe('source-copy parity guard mutation checks', () => {
  it('passes the same behavioral assertions against an unchanged source copy', () => {
    const copy = sourceCopy(source)
    for (const { verify } of cases) verify(copy)
  })

  for (const [name, from, to] of [
    [
      'POST writes',
      "new Set(['post', 'put', 'patch', 'delete'])",
      "new Set(['put', 'patch', 'delete'])",
    ],
    [
      'PUT writes',
      "new Set(['post', 'put', 'patch', 'delete'])",
      "new Set(['post', 'patch', 'delete'])",
    ],
    [
      'PATCH writes',
      "new Set(['post', 'put', 'patch', 'delete'])",
      "new Set(['post', 'put', 'delete'])",
    ],
    [
      'DELETE writes',
      "new Set(['post', 'put', 'patch', 'delete'])",
      "new Set(['post', 'put', 'patch'])",
    ],
    ['REST prefix', "path !== '/api/v1' && !path.startsWith('/api/v1/')", 'false'],
    ['OpenAPI document shape', '!isRecord(document) || !isRecord(document.paths)', 'false'],
    ['OpenAPI path shape', '!isRecord(item)', 'false'],
    ['operation IDs', '!identifier(operation.operationId)', 'false'],
    ['identifier first character', '/^[A-Za-z_]/.test(value)', 'true'],
    ['identifier character set', '!/[^A-Za-z0-9_.-]/.test(value)', 'true'],
    ['duplicate operation IDs', 'if (prior)', 'if (false)'],
    ['mapping root shape', '!isRecord(mapping)', 'false'],
    [
      'missing mapping',
      '!Object.hasOwn(mapping, operationId) && !Object.hasOwn(knownGaps, operationId)',
      'false',
    ],
    ['stale entries', '!writes.has(operationId)', 'false'],
    ['entry object shape', '!isRecord(entry)', 'false'],
    ['nonempty exemption', 'value.trim().length > 0', 'true'],
    ['one-line exemption', '!/[\\r\\n\\u2028\\u2029]/.test(value)', 'true'],
    ['strict exemption keys', 'keys.length === 2 &&', 'true &&'],
    ['exemption discriminator', "entry.exemption === 'browser-session-only'", 'true'],
    ['exemption reason key', "Object.hasOwn(entry, 'reason')", 'true'],
    ['exemption security check', '!browserSessionOnly(operation.security)', 'false'],
    ['operation security override', "Object.hasOwn(operation, 'security')", 'false'],
    ['root security inheritance', ': document.security,', ': undefined,'],
    ['session security array', '!Array.isArray(security)', 'false'],
    ['session security alternatives', 'security.length !== 1', 'false'],
    ['session requirement object', 'isRecord(requirement) &&', 'true &&'],
    ['session security key count', 'Object.keys(requirement).length === 1', 'true'],
    ['own session requirement', "Object.hasOwn(requirement, 'session')", 'true'],
    ['session scopes array', 'Array.isArray(requirement.session)', 'true'],
    ['empty session scopes', 'requirement.session.length === 0', 'true'],
    ['known-gap root shape', 'if (!isRecord(knownGaps)) {', 'if (false) {'],
    ['ratchet gap root shape', 'if (!isRecord(knownGaps)) return []', 'if (false) return []'],
    ['known-gap reason', '!oneLineReason(reason)', 'false'],
    [
      'removed known gap',
      `errors.push(\`\${operationId}: stale known gap; no REST write operation has this operationId.\`)`,
      `void(\`\${operationId}: stale known gap; no REST write operation has this operationId.\`)`,
    ],
    [
      'closed mapped gap',
      'Object.hasOwn(mapping, operationId) || browserSessionOnly(operation.security)',
      'false || browserSessionOnly(operation.security)',
    ],
    [
      'session-only stale gap',
      'Object.hasOwn(mapping, operationId) || browserSessionOnly(operation.security)',
      'Object.hasOwn(mapping, operationId) || false',
    ],
    ['gap baseline shape', '!isRecord(baseline)', 'false'],
    ['frozen gap additions', '!Object.hasOwn(baseline, operationId)', 'false'],
    ['gap diagnostic order', '    .sort()', ''],
    ['verified base commit shape', '!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)', 'false'],
    [
      'missing base failure',
      "throw new Error('Cannot resolve the interface-parity base commit; fetch its Git history.')",
      'return {}',
    ],
    ['committed gap baseline', "if (path === '')", 'if (true)'],
    ['unexpected baseline path', 'if (path !== KNOWN_GAPS_PATH)', 'if (false)'],
    [
      'frozen initial gap ceiling',
      "  'updateWebhook',\n] as const",
      "  'updateWebhook',\n  'newWrite',\n] as const",
    ],
    ['strict mapping keys', 'keys.length !== 2 ||', 'false ||'],
    ['MCP name', '!identifier(entry.mcp)', 'false'],
    ['CLI name', '!identifier(entry.cli)', 'false'],
    ['registered MCP tool', '!tools.has(entry.mcp)', 'false'],
    ['existing CLI command', '!Object.hasOwn(inventory.cli, entry.cli)', 'false'],
    ['CLI target', 'inventory.cli[entry.cli] !== entry.mcp', 'false'],
    ['stable diagnostic order', 'return errors.sort()', 'return errors'],
  ] as const) {
    it(`detects removal of ${name}`, () => {
      const mutant = source.replace(from, to)
      expect(mutant, 'the probe must change the real source').not.toBe(source)
      const checker = sourceCopy(mutant)
      expect(() => {
        for (const { verify } of cases) verify(checker)
      }).toThrow(expect.objectContaining({ name: 'AssertionError' }))
    })
  }
})
