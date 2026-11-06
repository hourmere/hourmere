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

function harness(active = false) {
  const listeners: Record<string, (event: unknown) => void> = {}
  const store = new Map<string, Response>()
  const cache = {
    put: vi.fn(async (path: string, response: Response) => store.set(path, response)),
    match: vi.fn(async (request: string | Request) => {
      const path = typeof request === 'string' ? request : new URL(request.url).pathname
      return store.get(path)
    }),
  }
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ['hourmere-shell-old', 'hourmere-shell-current', 'other-app-cache']),
    delete: vi.fn(async () => true),
  }
  const fetch = vi.fn(async (_request: Request) => new Response('static'))
  const skipWaiting = vi.fn(async () => {})
  const claim = vi.fn()
  const postMessage = vi.fn()
  const registration = { active: active ? {} : null, waiting: { postMessage } }
  runInNewContext(source, {
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
  })
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
    postMessage,
    listeners,
  }
}

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
    sw.fetch.mockRejectedValueOnce(new TypeError('offline'))
    expect(await (await sw.request('/app/bookings', {}, true))?.text()).toBe('offline notice')
    expect(sw.request('/manage/token', {}, true)).toBeUndefined()
    expect(sw.request('/alice/intro', {}, true)).toBeUndefined()
  })

  it('obtains the offline response before update activation can delete the old cache', async () => {
    const sw = harness(true)
    sw.store.set('/app/offline.html', new Response('offline notice'))
    sw.fetch.mockRejectedValue(new TypeError('offline'))
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
    rejectSlow?.(new TypeError('offline'))
    expect(await (await slow)?.text()).toBe('offline notice')
  })

  it('keeps online navigation and static files working when storage is unavailable', async () => {
    const sw = harness()
    sw.caches.open.mockRejectedValue(new Error('storage denied'))
    expect(await (await sw.request('/app/bookings', {}, true))?.text()).toBe('static')
    expect(await (await sw.request('/assets/main-abc123.js'))?.text()).toBe('static')
    expect(sw.fetch).toHaveBeenCalledTimes(2)
  })

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
