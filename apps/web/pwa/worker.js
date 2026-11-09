// Replaced by the build plugin; only build-owned public files enter this list.
const PRECACHE = __PRECACHE__
const CACHE_NAME = __CACHE_NAME__
const CACHE_PREFIX = 'hourmere-shell-'
const OFFLINE = '/app/offline.html'
const allowed = new Set(PRECACHE)

function staticRequest(request) {
  const url = new URL(request.url)
  return (
    request.method === 'GET' &&
    url.origin === self.location.origin &&
    !url.search &&
    !request.headers.has('authorization') &&
    request.mode !== 'navigate' &&
    allowed.has(url.pathname)
  )
}

function cacheable(response) {
  return (
    response.status === 200 &&
    !response.redirected &&
    !/\b(no-store|private)\b/i.test(response.headers.get('cache-control') || '') &&
    // Browsers hide Set-Cookie: this is not a security boundary. Safety comes from
    // the build-owned allowlist, omitted credentials and zero runtime cache writes.
    !response.headers.has('set-cookie') &&
    response.type !== 'opaque'
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      try {
        const previous = (await caches.keys()).filter(
          (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,
        )
        for (const path of PRECACHE) {
          // Only content-hashed assets are immutable by URL. Refresh HTML, icons and
          // the offline notice every deploy, and never reuse another application's cache.
          if (/^\/assets\/[^/]+-[\w-]+\.(js|css|woff2?)$/.test(path)) {
            let reused = false
            for (const name of previous) {
              const cached = await (await caches.open(name)).match(path)
              if (!cached || !cacheable(cached)) continue
              await cache.put(path, cached)
              reused = true
              break
            }
            if (reused) continue
          }
          // Static files do not need cookies; do not persist authenticated variants.
          const response = await fetch(
            new Request(new URL(path, self.location.origin), {
              credentials: 'omit',
              cache: 'reload',
              redirect: 'error',
            }),
          )
          if (!cacheable(response)) throw new Error('Unsafe precache response')
          await cache.put(path, response)
        }
        if (!self.registration.active) await self.skipWaiting()
      } catch (error) {
        await caches.delete(CACHE_NAME)
        throw error
      }
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE') event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name)
      }
      // No clients.claim(): first installation does not take over uncontrolled pages.
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (request.mode === 'navigate' && url.pathname.startsWith('/app/')) {
    event.respondWith(
      (async () => {
        // Capture the notice before another tab can activate an update and delete this cache.
        const fallback = await caches
          .open(CACHE_NAME)
          .then((cache) => cache.match(OFFLINE))
          .catch(() => undefined)
        const response = await fetch(request).catch(() => fallback || Response.error())
        self.registration.waiting?.postMessage({ type: 'ACTIVATE' })
        return response
      })(),
    )
    return
  }
  if (!staticRequest(request)) return
  event.respondWith(
    (async () => {
      const cached = await caches
        .open(CACHE_NAME)
        .then((cache) => cache.match(request))
        .catch(() => undefined)
      // Never write runtime responses, including API, auth, private or no-store data.
      return cached || fetch(request)
    })(),
  )
})
