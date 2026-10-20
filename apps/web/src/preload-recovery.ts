import { reloadPage } from './browser.ts'

const RELOAD_KEY = 'hourmere-preload-reloaded'

/** A stale deployment chunk gets one automatic retry for this tab's session. */
export function installPreloadRecovery() {
  let reloading = false
  const recover = (event: Event) => {
    if (reloading) {
      event.preventDefault()
      return
    }
    try {
      if (sessionStorage.getItem(RELOAD_KEY)) return
      sessionStorage.setItem(RELOAD_KEY, '1')
    } catch {
      // Without a durable guard, let the route boundary handle the failed import.
      return
    }
    reloading = true
    event.preventDefault()
    reloadPage()
  }
  window.addEventListener('vite:preloadError', recover)
  return () => window.removeEventListener('vite:preloadError', recover)
}
