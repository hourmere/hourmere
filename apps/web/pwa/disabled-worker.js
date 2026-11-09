// Keep this URL available when PWA is disabled so existing registrations can update.
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        await Promise.all(
          (await caches.keys())
            .filter((name) => name.startsWith('hourmere-shell-'))
            .map((name) => caches.delete(name)),
        )
      } finally {
        await self.registration.unregister()
      }
    })(),
  )
})
// No fetch listener: even pages still controlled until they close use the network.
