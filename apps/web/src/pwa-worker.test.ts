// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import { isShellAsset, offlineShell } from '../pwa/build.ts'

const paths = ['/index.html', '/app/offline.html', '/assets/main-abc123.js', '/app/icon-192.png']
const source = readFileSync(new URL('../pwa/worker.js', import.meta.url), 'utf8')
  .replace('__PRECACHE__', JSON.stringify(paths))
  .replace('__CACHE_NAME__', JSON.stringify('hourmere-shell-current'))

function harness(active = false, worker = source) {
  const listeners: Record<string, (event: unknown) => void> = {}
  const store = new Map<string, Response>()
  const cache = {
    put: vi.fn(async (path: string, response: Response) => store.set(path, response)),
    match: vi.fn(async (request: string | Request) => {
      const path = typeof request === 'string' ? request : new URL(request.url).pathname
      return store.get(path)
    }),
  }
  const oldStore = new Map<string, Response>()
  const otherStore = new Map<string, Response>()
  const caches = {
    open: vi.fn(async (name: string) =>
      name === 'hourmere-shell-current'
        ? cache
        : {
            ...cache,
            match: vi.fn(async (path: string | Request) =>
              (name === 'hourmere-shell-old' ? oldStore : otherStore).get(String(path)),
            ),
          },
    ),
    keys: vi.fn(async () => ['hourmere-shell-old', 'hourmere-shell-current', 'other-app-cache']),
    delete: vi.fn(async () => true),
  }
  const fetch = vi.fn(async (_request: Request) => new Response('static'))
  const skipWaiting = vi.fn(async () => {})
  const claim = vi.fn()
  const postMessage = vi.fn()
  const unregister = vi.fn(async () => true)
  const registration = { active: active ? {} : null, waiting: { postMessage }, unregister }
  const context = {
    URL,
    Request,
    Response,
    Set,
    fetch,
    caches,
    self: {
      location: { origin: 'https://hourmere.example' },
      skipWaiting,
      registration,
      clients: { claim },
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        listeners[name] = listener
      },
    },
  }
  // Worker globals include DOMException; storage APIs reject with it (for example
  // QuotaExceededError from Cache.put). Define it on the worker realm's own Error.
  runInNewContext(
    `globalThis.DOMException = class DOMException extends Error {
      constructor(message = '', name = 'Error') {
        super(message)
        this.name = name
      }
      get code() {
        return { QuotaExceededError: 22, SecurityError: 18 }[this.name] ?? 0
      }
    }
    // Chromium rejects over-quota writes with the QuotaExceededError interface.
    globalThis.QuotaExceededError = class QuotaExceededError extends DOMException {
      constructor(message = '', options = {}) {
        super(message, 'QuotaExceededError')
        this.quota = options.quota ?? null
        this.requested = options.requested ?? null
      }
    }`,
    context,
  )
  runInNewContext(worker, context)
  // Browsers reject fetch() and cache writes with errors from the worker's own realm. Build
  // injected failures with the context's constructors so `instanceof` behaves as in production.
  const realm = runInNewContext(
    `({
      Error,
      TypeError,
      DOMException,
      QuotaExceededError,
      isError: (error) => error instanceof Error,
      isTypeError: (error) => error instanceof TypeError,
    })`,
    context,
  ) as {
    Error: ErrorConstructor
    TypeError: TypeErrorConstructor
    DOMException: new (message?: string, name?: string) => Error & { code: number }
    QuotaExceededError: new (
      message?: string,
      options?: { quota?: number; requested?: number },
    ) => Error & { code: number; quota: number | null; requested: number | null }
    isError: (error: unknown) => boolean
    isTypeError: (error: unknown) => boolean
  }
  const global = runInNewContext('globalThis', context) as Record<string, unknown>
  async function lifecycle(name: string) {
    let promise: Promise<unknown> | undefined
    listeners[name]?.({
      waitUntil: (value: Promise<unknown>) => {
        promise = value
      },
    })
    await promise
  }
  function request(path: string, options: RequestInit = {}, navigate = false) {
    const req = new Request(new URL(path, 'https://hourmere.example'), options)
    if (navigate) Object.defineProperty(req, 'mode', { value: 'navigate' })
    let response: Promise<Response> | undefined
    listeners.fetch?.({
      request: req,
      respondWith: (value: Promise<Response>) => {
        response = value
      },
    })
    return response
  }
  return {
    cache,
    caches,
    fetch,
    skipWaiting,
    claim,
    lifecycle,
    request,
    store,
    oldStore,
    otherStore,
    unregister,
    postMessage,
    listeners,
    realm,
    global,
  }
}

type Harness = ReturnType<typeof harness>
type ErrorKind = [label: string, make: (sw: Harness, message: string) => Error]

// The worker must treat every failure the same whatever its type, so the same assertions
// run once per realm-own error kind: WebKit reports disk and internal failures (and every
// engine reports network failures) as TypeError; Chromium and WebKit use DOMExceptions
// with these names (SecurityError when storage access is denied); current Chromium rejects
// over-quota writes with the QuotaExceededError interface; a plain Error stands for the rest.
const typeError: ErrorKind[1] = (sw, message) => new sw.realm.TypeError(message)
const errorKinds: ErrorKind[] = [
  ['TypeError', typeError],
  [
    'DOMException UnknownError',
    (sw, message) => new sw.realm.DOMException(message, 'UnknownError'),
  ],
  [
    'DOMException QuotaExceededError',
    (sw, message) => new sw.realm.DOMException(message, 'QuotaExceededError'),
  ],
  [
    'DOMException InvalidStateError',
    (sw, message) => new sw.realm.DOMException(message, 'InvalidStateError'),
  ],
  [
    'DOMException NotFoundError',
    (sw, message) => new sw.realm.DOMException(message, 'NotFoundError'),
  ],
  [
    'DOMException SecurityError',
    (sw, message) => new sw.realm.DOMException(message, 'SecurityError'),
  ],
  ['QuotaExceededError', (sw, message) => new sw.realm.QuotaExceededError(message)],
  ['Error', (sw, message) => new sw.realm.Error(message)],
]

describe('offline shell routing', () => {
  it.each([
    '/api/v1/bookings',
    '/api/auth/get-session',
    '/mcp',
    '/mcp/tools',
    '/oauth2/authorize',
    '/sign-in',
    '/sign-in/confirm?token=secret',
    '/manage/token',
    '/booking/manage/token',
    '/book/token',
    '/embed/alice/intro',
    '/hourmere-embed.js',
    '/alice/intro',
    '/assets/main-abc123.js?token=secret',
    'https://other.example/assets/main-abc123.js',
    '/app/settings',
    '/app/api-keys',
  ])('leaves %s network-only', (path) => {
    const sw = harness()
    expect(sw.request(path)).toBeUndefined()
    expect(sw.cache.match).not.toHaveBeenCalled()
    expect(sw.cache.put).not.toHaveBeenCalled()
  })

  it('does not intercept writes or authenticated static requests', () => {
    const sw = harness()
    expect(sw.request('/assets/main-abc123.js', { method: 'POST' })).toBeUndefined()
    expect(
      sw.request('/assets/main-abc123.js', { headers: { Authorization: 'Bearer secret' } }),
    ).toBeUndefined()
  })

  it('uses only exact static entries and never writes runtime responses', async () => {
    const sw = harness()
    sw.store.set('/assets/main-abc123.js', new Response('cached static'))
    expect(await (await sw.request('/assets/main-abc123.js'))?.text()).toBe('cached static')
    expect(sw.fetch).not.toHaveBeenCalled()
    sw.fetch.mockResolvedValue(
      new Response('private', { headers: { 'Cache-Control': 'private, no-store' } }),
    )
    expect(await (await sw.request('/app/icon-192.png'))?.text()).toBe('private')
    expect(sw.cache.put).not.toHaveBeenCalled()
  })

  it('always requests fresh admin navigation and uses only the offline notice on failure', async () => {
    const sw = harness()
    sw.store.set('/index.html', new Response('stale functional app'))
    sw.store.set('/app/offline.html', new Response('offline notice'))
    sw.fetch.mockResolvedValueOnce(new Response('fresh navigation'))
    expect(await (await sw.request('/app/bookings', {}, true))?.text()).toBe('fresh navigation')
    expect(sw.cache.put).not.toHaveBeenCalled()
    sw.fetch.mockRejectedValueOnce(new sw.realm.TypeError('offline'))
    expect(await (await sw.request('/app/bookings', {}, true))?.text()).toBe('offline notice')
    expect(sw.request('/manage/token', {}, true)).toBeUndefined()
    expect(sw.request('/alice/intro', {}, true)).toBeUndefined()
  })

  it('obtains the offline response before update activation can delete the old cache', async () => {
    const sw = harness(true)
    sw.store.set('/app/offline.html', new Response('offline notice'))
    sw.fetch.mockRejectedValue(new sw.realm.TypeError('offline'))
    sw.postMessage.mockImplementation(() => sw.store.clear())
    expect(await (await sw.request('/app/bookings', {}, true))?.text()).toBe('offline notice')
    expect(sw.postMessage).toHaveBeenCalledOnce()
  })

  it('retains the notice for a slow navigation while another tab activates an update', async () => {
    const sw = harness(true)
    sw.store.set('/app/offline.html', new Response('offline notice'))
    let rejectSlow: ((reason: Error) => void) | undefined
    let started: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    sw.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectSlow = reject
          started?.()
        }),
    )
    const slow = sw.request('/app/bookings', {}, true)
    await ready
    sw.postMessage.mockImplementation(() => sw.store.clear())
    await sw.request('/app/settings', {}, true)
    rejectSlow?.(new sw.realm.TypeError('offline'))
    expect(await (await slow)?.text()).toBe('offline notice')
  })

  it.each(errorKinds)(
    'keeps online navigation and static files working when storage is unavailable (%s)',
    async (_kind, make) => {
      const sw = harness()
      sw.caches.open.mockRejectedValue(make(sw, 'storage denied'))
      expect(await (await sw.request('/app/bookings', {}, true))?.text()).toBe('static')
      expect(await (await sw.request('/assets/main-abc123.js'))?.text()).toBe('static')
      expect(sw.fetch).toHaveBeenCalledTimes(2)
    },
  )

  it('preserves server denial responses instead of substituting an offline page', async () => {
    const sw = harness()
    sw.fetch.mockResolvedValue(new Response('denied', { status: 403 }))
    expect((await sw.request('/app/settings', {}, true))?.status).toBe(403)
    expect(sw.cache.put).not.toHaveBeenCalled()
  })
})

describe('offline shell installation and updates', () => {
  it('keeps updates waiting until the next full navigation', async () => {
    const sw = harness(true)
    await sw.lifecycle('install')
    expect(sw.skipWaiting).not.toHaveBeenCalled()
    await sw.request('/app/bookings', {}, true)
    expect(sw.postMessage).toHaveBeenCalledWith({ type: 'ACTIVATE' })
    let activation: Promise<unknown> | undefined
    sw.listeners.message?.({
      data: { type: 'ACTIVATE' },
      waitUntil: (value: Promise<unknown>) => {
        activation = value
      },
    })
    await activation
    expect(sw.skipWaiting).toHaveBeenCalledOnce()
  })

  it('precaches only static files without cookies and activates without taking over open pages', async () => {
    const sw = harness()
    await sw.lifecycle('install')
    expect(sw.cache.put.mock.calls.map(([path]) => path)).toEqual(paths)
    for (const [request] of sw.fetch.mock.calls) {
      expect(request.credentials).toBe('omit')
      expect(request.cache).toBe('reload')
      expect(request.redirect).toBe('error')
    }
    expect(sw.skipWaiting).toHaveBeenCalledOnce()
    expect(sw.claim).not.toHaveBeenCalled()
  })

  it.each(['no-store', 'private', 'max-age=0, PRIVATE', 'public, no-store'])(
    'rejects %s during precache and discards partial cache',
    async (control) => {
      const sw = harness()
      sw.fetch
        .mockResolvedValueOnce(new Response('static'))
        .mockResolvedValueOnce(new Response('secret', { headers: { 'Cache-Control': control } }))
      await expect(sw.lifecycle('install')).rejects.toThrow('Unsafe precache response')
      expect(sw.cache.put).toHaveBeenCalledTimes(1)
      expect(sw.caches.delete).toHaveBeenCalledWith('hourmere-shell-current')
      expect(sw.skipWaiting).not.toHaveBeenCalled()
    },
  )

  it('rejects failed, redirected and cookie-setting responses', async () => {
    for (const response of [
      new Response('missing', { status: 404 }),
      new Response('cookie', { headers: { 'Set-Cookie': 'session=secret' } }),
      Object.defineProperty(new Response('redirect'), 'redirected', { value: true }),
    ]) {
      const sw = harness()
      sw.fetch.mockResolvedValue(response)
      await expect(sw.lifecycle('install')).rejects.toThrow()
      expect(sw.cache.put).not.toHaveBeenCalled()
    }
  })

  it('removes only obsolete Hourmere shell caches and never claims open clients', async () => {
    const sw = harness()
    await sw.lifecycle('activate')
    expect(sw.caches.delete.mock.calls).toEqual([['hourmere-shell-old']])
    expect(sw.claim).not.toHaveBeenCalled()
  })

  it.each(errorKinds)(
    'fails activation when deleting an old shell cache fails (%s)',
    async (_kind, make) => {
      const sw = harness()
      const error = make(sw, 'delete failed')
      sw.caches.delete.mockRejectedValue(error)
      await expect(sw.lifecycle('activate')).rejects.toBe(error)
      expect(sw.caches.delete.mock.calls).toEqual([['hourmere-shell-old']])
      expect(sw.claim).not.toHaveBeenCalled()
    },
  )
})

describe('build precache selection', () => {
  it('allows static shell files and rejects data routes, embed bundles and arbitrary output', () => {
    for (const path of [
      ...paths,
      '/assets/font-abc123.woff2',
      '/assets/main-abc123.css',
      '/app/maskable-512.png',
    ])
      expect(isShellAsset(path)).toBe(true)
    for (const path of [
      '/api/v1/bookings',
      '/api/auth/session',
      '/mcp',
      '/oauth2/authorize',
      '/manage/token',
      '/embed/index.html',
      '/hourmere-embed.js',
      '/app/sw.js',
      '/assets/secrets.json',
      '/assets/plain.js',
      '/app/icon-192.png?token=x',
    ])
      expect(isShellAsset(path)).toBe(false)
  })

  it('ships an admin-only bilingual notice with no functional booking form', () => {
    const html = readFileSync(new URL('../pwa/offline.html', import.meta.url), 'utf8')
    expect(html).toContain('You’re offline')
    expect(html).toContain('lang="zh-CN"')
    expect(html).toContain('你已离线')
    expect(html).not.toMatch(/<script|<form/)
  })
})

// A real build checks the generated artifact, not only the selection helper.
it('builds a static-only precache and versions changed shell content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hourmere-pwa-build-'))
  try {
    await mkdir(join(root, 'public/api/v1'), { recursive: true })
    await writeFile(join(root, 'public/api/v1/private.json'), '{"secret":"fixture"}')
    await writeFile(join(root, 'index.html'), '<html><body>shell one</body></html>')
    const options = {
      root,
      configFile: false as const,
      logLevel: 'silent' as const,
      plugins: [offlineShell()],
    }
    await build(options)
    const first = await readFile(join(root, 'dist/app/sw.js'), 'utf8')
    expect(first).toContain('"/index.html"')
    expect(first).toContain('"/app/offline.html"')
    expect(first).not.toContain('/api/v1/private.json')
    expect(first).not.toContain('__PRECACHE__')
    expect(first).toMatch(/hourmere-shell-[a-f0-9]{20}/)
    await writeFile(join(root, 'index.html'), '<html><body>shell two</body></html>')
    await build(options)
    const second = await readFile(join(root, 'dist/app/sw.js'), 'utf8')
    expect(second.match(/hourmere-shell-[a-f0-9]{20}/)?.[0]).not.toBe(
      first.match(/hourmere-shell-[a-f0-9]{20}/)?.[0],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('leaves in-memory builds valid without creating output files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hourmere-pwa-memory-build-'))
  try {
    await writeFile(join(root, 'index.html'), '<html><body>in-memory shell</body></html>')
    const buildResult = build({
      root,
      configFile: false,
      publicDir: false,
      logLevel: 'silent',
      build: { write: false },
      plugins: [offlineShell()],
    })
    await expect(buildResult).resolves.toHaveProperty('output')
    const result = await buildResult
    expect(existsSync(join(root, 'dist'))).toBe(false)
    expect('output' in result).toBe(true)
    if ('output' in result) {
      expect(
        result.output.some(
          (file) =>
            file.fileName === 'index.html' &&
            file.type === 'asset' &&
            String(file.source).includes('in-memory shell'),
        ),
      ).toBe(true)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function verifyReuse(worker = source) {
  const sw = harness(true, worker)
  for (const path of paths) sw.oldStore.set(path, new Response('previous'))
  await sw.lifecycle('install')
  expect(sw.fetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(
    paths.filter((path) => path !== '/assets/main-abc123.js'),
  )
  expect(await sw.store.get('/assets/main-abc123.js')?.text()).toBe('previous')
  expect(await sw.store.get('/index.html')?.text()).toBe('static')
}

async function verifyReuseIsolation(worker = source) {
  const sw = harness(true, worker)
  sw.otherStore.set('/assets/main-abc123.js', new Response('another application'))
  sw.oldStore.set(
    '/assets/main-abc123.js',
    new Response('private', { headers: { 'cache-control': 'private' } }),
  )
  await sw.lifecycle('install')
  expect(await sw.store.get('/assets/main-abc123.js')?.text()).toBe('static')
}

it('reuses unchanged hashed URLs from an older Hourmere cache but refreshes mutable files', async () => {
  await verifyReuse()
  await verifyReuseIsolation()
})

type ReuseFailure = 'list' | 'open' | 'match' | 'copy'
type ReuseState = ReuseFailure | 'none'
const asset = '/assets/main-abc123.js'

// Put a reusable copy of the hashed asset into the old cache ('none': no old entry), then
// make the given step of reusing it fail so the worker falls back to a network fetch.
function arrangeReuse(sw: Harness, failure: ReuseState, make = typeError) {
  const cached = new Response('previous')
  if (failure !== 'none') sw.oldStore.set(asset, cached)
  const error = make(sw, 'old cache unavailable')
  if (failure === 'list') sw.caches.keys.mockRejectedValue(error)
  if (failure === 'open' || failure === 'match') {
    const open = sw.caches.open.getMockImplementation()
    if (!open) throw new Error('Missing cache open fixture')
    sw.caches.open.mockImplementation(async (name) => {
      if (name === 'hourmere-shell-old') {
        if (failure === 'open') throw error
        return { ...sw.cache, match: vi.fn().mockRejectedValue(error) }
      }
      return open(name)
    })
  }
  if (failure === 'copy') {
    const put = sw.cache.put.getMockImplementation()
    if (!put) throw new Error('Missing cache put fixture')
    sw.cache.put.mockImplementation(async (path, response) => {
      if (response === cached) throw error
      return put(path, response)
    })
  }
}

// The fallback fetch for the hashed asset answers with `respond`; every other path succeeds.
function answerAsset(sw: Harness, respond: () => Response) {
  sw.fetch.mockImplementation(async (request) =>
    new URL(request.url).pathname === asset ? respond() : new Response('static'),
  )
}

async function verifyReuseFailure(failure: ReuseFailure, worker = source, make = typeError) {
  const sw = harness(true, worker)
  arrangeReuse(sw, failure, make)
  await expect(sw.lifecycle('install')).resolves.toBeUndefined()
  expect(sw.fetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual(paths)
  for (const [request] of sw.fetch.mock.calls) {
    expect(request.credentials).toBe('omit')
    expect(request.cache).toBe('reload')
    expect(request.redirect).toBe('error')
  }
  expect(await sw.store.get(asset)?.text()).toBe('static')
  expect(sw.store.size).toBe(paths.length)
  expect(sw.caches.delete).not.toHaveBeenCalled()
  expect(sw.skipWaiting).not.toHaveBeenCalled()
}

const reuseFailures: ReuseFailure[] = ['list', 'open', 'match', 'copy']

it.each<[ReuseFailure, string, ErrorKind[1]]>(
  reuseFailures.flatMap((failure) =>
    errorKinds.map(([kind, make]): [ReuseFailure, string, ErrorKind[1]] => [failure, kind, make]),
  ),
)('fetches fresh assets when previous cache %s fails (%s)', async (failure, _kind, make) => {
  await verifyReuseFailure(failure, source, make)
})

it.each([false, true])(
  'discards the partial cache when fetch rejects after cache reuse (reuse failed: %s)',
  async (reuseFails) => {
    const sw = harness()
    sw.oldStore.set(asset, new Response('previous'))
    if (reuseFails) sw.caches.keys.mockRejectedValue(typeError(sw, 'old cache unavailable'))
    sw.fetch.mockImplementation(async (request) => {
      if (new URL(request.url).pathname === '/app/icon-192.png')
        throw new sw.realm.TypeError('offline')
      return new Response('static')
    })
    await expect(sw.lifecycle('install')).rejects.toThrow('offline')
    expect(await sw.store.get(asset)?.text()).toBe(reuseFails ? 'static' : 'previous')
    expect(sw.caches.delete).toHaveBeenCalledWith('hourmere-shell-current')
    expect(sw.skipWaiting).not.toHaveBeenCalled()
  },
)

it('injects failures as worker realm errors, which the worker sees as browsers would', async () => {
  const sw = harness()
  // The realm objects are the worker's own globals, not those of some other context.
  expect(sw.realm.Error).toBe(sw.global.Error)
  expect(sw.realm.TypeError).toBe(sw.global.TypeError)
  expect(sw.realm.DOMException).toBe(sw.global.DOMException)
  expect(sw.realm.QuotaExceededError).toBe(sw.global.QuotaExceededError)
  const network = new sw.realm.TypeError('offline')
  const storage = new sw.realm.DOMException('storage full', 'QuotaExceededError')
  expect(sw.realm.isTypeError(network)).toBe(true)
  expect(sw.realm.isError(network)).toBe(true)
  expect(sw.realm.isError(storage)).toBe(true)
  expect(sw.realm.isTypeError(storage)).toBe(false)
  expect(storage).toBeInstanceOf(sw.realm.DOMException)
  expect(storage.name).toBe('QuotaExceededError')
  expect(storage.code).toBe(22)
  expect(new sw.realm.DOMException('denied', 'SecurityError').code).toBe(18)
  const quota = new sw.realm.QuotaExceededError('storage full')
  expect(quota).toBeInstanceOf(sw.realm.DOMException)
  expect(sw.realm.isError(quota)).toBe(true)
  expect(quota.name).toBe('QuotaExceededError')
  expect(quota.code).toBe(22)
  expect([quota.quota, quota.requested]).toEqual([null, null])
  for (const [, make] of errorKinds) expect(sw.realm.isError(make(sw, 'any kind'))).toBe(true)
  // An error the worker itself throws shares the realm of the injected ones.
  sw.fetch.mockResolvedValue(new Response('secret', { headers: { 'Cache-Control': 'no-store' } }))
  const thrown: unknown = await sw.lifecycle('install').then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(thrown).toBeInstanceOf(sw.realm.Error)
  expect(Object.getPrototypeOf(thrown)).toBe(sw.realm.Error.prototype)
  // The harness shares no error constructors: test realm errors stay foreign to the worker.
  expect(sw.realm.isTypeError(new TypeError('offline'))).toBe(false)
  expect(sw.realm.isError(new Error('offline'))).toBe(false)
  expect(sw.realm.isError(new DOMException('storage full', 'QuotaExceededError'))).toBe(false)
})

// No active worker: a tolerated failure would install an incomplete cache and skip waiting.
it.each<[ReuseState, string, ErrorKind[1]]>(
  (['none', ...reuseFailures] as ReuseState[]).flatMap((failure) =>
    errorKinds.map(([kind, make]): [ReuseState, string, ErrorKind[1]] => [failure, kind, make]),
  ),
)(
  'fails installation when the hashed asset fetch itself rejects (reuse: %s, %s)',
  async (failure, _kind, make) => {
    const sw = harness()
    arrangeReuse(sw, failure, make)
    const error = make(sw, 'offline')
    answerAsset(sw, () => {
      throw error
    })
    await expect(sw.lifecycle('install')).rejects.toBe(error)
    expect(sw.store.has(asset)).toBe(false)
    expect(sw.caches.delete).toHaveBeenCalledWith('hourmere-shell-current')
    expect(sw.skipWaiting).not.toHaveBeenCalled()
  },
)

const unsafeResponses: [string, ResponseInit][] = [
  ['private', { headers: { 'cache-control': 'private' } }],
  ['no-store', { headers: { 'cache-control': 'no-store' } }],
  ['404', { status: 404 }],
  ['500', { status: 500 }],
]

it.each<[ReuseFailure, string, ResponseInit]>(
  (['open', 'match', 'copy'] as const).flatMap((failure) =>
    unsafeResponses.map(([label, init]): [ReuseFailure, string, ResponseInit] => [
      failure,
      label,
      init,
    ]),
  ),
)(
  'validates the fallback fetch after reuse %s fails (%s response)',
  async (failure, _label, init) => {
    const sw = harness()
    arrangeReuse(sw, failure)
    answerAsset(sw, () => new Response('unsafe', init))
    await expect(sw.lifecycle('install')).rejects.toThrow('Unsafe precache response')
    expect(sw.store.has(asset)).toBe(false)
    expect(sw.caches.delete).toHaveBeenCalledWith('hourmere-shell-current')
    expect(sw.skipWaiting).not.toHaveBeenCalled()
  },
)

it('fails installation when fetching the offline notice rejects', async () => {
  const sw = harness()
  sw.fetch
    .mockResolvedValueOnce(new Response('static'))
    .mockRejectedValueOnce(new sw.realm.TypeError('offline'))
  await expect(sw.lifecycle('install')).rejects.toThrow('offline')
  expect(sw.caches.delete).toHaveBeenCalledWith('hourmere-shell-current')
  expect(sw.skipWaiting).not.toHaveBeenCalled()
})

it.each(errorKinds)(
  'fails installation when the new shell cache cannot be opened (%s)',
  async (_kind, make) => {
    const sw = harness()
    const error = make(sw, 'storage unavailable')
    sw.caches.open.mockRejectedValue(error)
    await expect(sw.lifecycle('install')).rejects.toBe(error)
    expect(sw.fetch).not.toHaveBeenCalled()
    expect(sw.cache.put).not.toHaveBeenCalled()
    expect(sw.store.size).toBe(0)
    expect(sw.skipWaiting).not.toHaveBeenCalled()
  },
)

it.each(errorKinds)(
  'fails installation when storing a fresh asset fails after reuse fails (%s)',
  async (_kind, make) => {
    const sw = harness()
    sw.caches.keys.mockRejectedValue(make(sw, 'old cache unavailable'))
    const error = make(sw, 'storage full')
    sw.cache.put.mockRejectedValue(error)
    await expect(sw.lifecycle('install')).rejects.toBe(error)
    expect(sw.fetch).toHaveBeenCalledOnce()
    expect(sw.store.size).toBe(0)
    expect(sw.caches.delete).toHaveBeenCalledWith('hourmere-shell-current')
    expect(sw.skipWaiting).not.toHaveBeenCalled()
  },
)

it('detects source-copy mutations that make cache reuse errors abort installation', async () => {
  const listGuard = 'caches.keys().catch(() => [])'
  expect(source).toContain(listGuard)
  await expect(
    verifyReuseFailure('list', source.replace(listGuard, 'caches.keys()')),
  ).rejects.toThrow(/promise rejected/)
  const copyGuard = '} catch {\n                // Reuse is optional:'
  expect(source).toContain(copyGuard)
  const mutation = source.replace(
    copyGuard,
    '} catch (error) {\n                throw error\n                // Reuse is optional:',
  )
  for (const failure of ['open', 'match', 'copy'] as const) {
    await expect(verifyReuseFailure(failure, mutation)).rejects.toThrow(/promise rejected/)
  }
})

async function verifyDisabled(worker: string) {
  const sw = harness(true, worker)
  await sw.lifecycle('install')
  expect(sw.skipWaiting).toHaveBeenCalledOnce()
  await sw.lifecycle('activate')
  expect(sw.caches.delete.mock.calls).toEqual([['hourmere-shell-old'], ['hourmere-shell-current']])
  expect(sw.unregister).toHaveBeenCalledOnce()
  expect(sw.listeners.fetch).toBeUndefined()
  expect(sw.request('/app/bookings', {}, true)).toBeUndefined()
  expect(sw.fetch).not.toHaveBeenCalled()
  expect(sw.claim).not.toHaveBeenCalled()
}

it('ships a disabled-build worker that immediately retires installed workers without fetching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hourmere-pwa-disabled-build-'))
  try {
    await writeFile(join(root, 'index.html'), '<html><body>disabled shell</body></html>')
    await build({ root, configFile: false, logLevel: 'silent', plugins: [offlineShell(false)] })
    const worker = await readFile(join(root, 'dist/app/sw.js'), 'utf8')
    await verifyDisabled(worker)
    expect(existsSync(join(root, 'dist/app/offline.html'))).toBe(false)
    for (const [, make] of errorKinds) {
      const sw = harness(true, worker)
      const error = make(sw, 'storage denied')
      sw.caches.keys.mockRejectedValue(error)
      await expect(sw.lifecycle('activate')).rejects.toBe(error)
      expect(sw.unregister).toHaveBeenCalledOnce()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('detects source-copy mutations to disabled worker protections', async () => {
  const worker = readFileSync(new URL('../pwa/disabled-worker.js', import.meta.url), 'utf8')
  for (const [before, after] of [
    ['event.waitUntil(self.skipWaiting())', 'event.waitUntil(Promise.resolve())'],
    [".filter((name) => name.startsWith('hourmere-shell-'))", '.filter(() => true)'],
    ['.map((name) => caches.delete(name))', '.map(() => Promise.resolve())'],
    ['await self.registration.unregister()', 'await Promise.resolve()'],
    ['// No fetch listener:', "self.addEventListener('fetch', () => {})\n// No fetch listener:"],
  ] as const) {
    expect(worker).toContain(before)
    await expect(verifyDisabled(worker.replace(before, after))).rejects.toThrow()
  }
})

it('detects source-copy mutations to hashed URL reuse and mutable-file refresh', async () => {
  for (const [before, after] of [
    ['if (reused) continue', 'if (false) continue'],
    ['if (/^\\/assets\\/[^/]+-[\\w-]+\\.(js|css|woff2?)$/.test(path))', 'if (true)'],
  ] as const) {
    expect(source).toContain(before)
    await expect(verifyReuse(source.replace(before, after))).rejects.toThrow()
  }
})

it('detects source-copy mutations to reused cache ownership and response validation', async () => {
  for (const [before, after] of [
    ['name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,', 'name !== CACHE_NAME,'],
    ['if (!cached || !cacheable(cached)) continue', 'if (!cached) continue'],
  ] as const) {
    expect(source).toContain(before)
    await expect(verifyReuseIsolation(source.replace(before, after))).rejects.toThrow()
  }
})
