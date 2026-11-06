/** Installation metadata belongs only to the admin surface, including SPA transitions. */
export function installAdminPwa(
  pathname: string,
  production = import.meta.env.PROD,
  enabled = import.meta.env.VITE_PWA_ENABLED !== 'false',
  location: Pick<Location, 'protocol' | 'hostname'> = window.location,
) {
  const admin = pathname === '/app' || pathname.startsWith('/app/')
  if (!admin || !production || !enabled) return () => {}

  const manifest = document.createElement('link')
  manifest.rel = 'manifest'
  manifest.href = '/app/manifest.webmanifest'
  const capable = document.createElement('meta')
  capable.name = 'apple-mobile-web-app-capable'
  capable.content = 'yes'
  const title = document.createElement('meta')
  title.name = 'apple-mobile-web-app-title'
  title.content = 'Hourmere'
  const status = document.createElement('meta')
  status.name = 'apple-mobile-web-app-status-bar-style'
  status.content = 'default'
  const nodes = [manifest, capable, title, status]
  document.head.append(...nodes)

  const local =
    location.hostname === 'localhost' ||
    location.hostname.endsWith('.localhost') ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '[::1]'
  if (
    (location.protocol === 'https:' || (location.protocol === 'http:' && local)) &&
    'serviceWorker' in navigator
  ) {
    // Browsers check this URL for updates on navigation. Do not claim open pages or
    // reload an in-progress edit: an installed update takes effect on the next visit.
    void navigator.serviceWorker
      .register('/app/sw.js', {
        scope: '/app/',
        updateViaCache: 'none',
      })
      .catch(() => {
        // Installation is optional; ordinary online use must still work if it fails.
      })
  }
  return () => {
    for (const node of nodes) node.remove()
  }
}
