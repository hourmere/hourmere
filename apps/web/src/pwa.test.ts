import { afterEach, expect, it, vi } from 'vitest'
import { installAdminPwa } from './pwa.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  Reflect.deleteProperty(navigator, 'serviceWorker')
  vi.unstubAllEnvs()
})
function setup(
  path = '/app/event-types',
  production = true,
  enabled = true,
  url = 'https://example.test',
) {
  const register = vi.fn().mockResolvedValue({})
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } })
  cleanups.push(installAdminPwa(path, production, enabled, new URL(url)))
  return register
}

it.each([
  'https://example.test',
  'http://localhost',
  'http://127.0.0.1',
  'http://[::1]',
  'http://dev.localhost',
])('registers an admin-only worker on a secure production origin: %s', (url) => {
  const register = setup('/app/settings', true, true, url)
  expect(register).toHaveBeenCalledWith('/app/sw.js', { scope: '/app/', updateViaCache: 'none' })
  expect(document.querySelector('link[rel="manifest"]')?.getAttribute('href')).toBe(
    '/app/manifest.webmanifest',
  )
  expect(
    document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content'),
  ).toBe('yes')
})
it.each([
  '/alice/chat',
  '/team/acme/demo',
  '/book/token',
  '/booking',
  '/embed/alice/chat',
  '/sign-in',
  '/application',
])('does not offer admin installation on public path %s', (path) => {
  expect(setup(path)).not.toHaveBeenCalled()
  expect(document.querySelector('link[rel="manifest"]')).toBeNull()
})
it.each([
  [false, true],
  [true, false],
])('disables registration and metadata with production=%s enabled=%s', (production, enabled) => {
  expect(setup('/app/', production, enabled)).not.toHaveBeenCalled()
  expect(document.querySelector('link[rel="manifest"]')).toBeNull()
})
it.each(['http://example.test', 'http://localhost.evil.test', 'ftp://localhost'])(
  'does not register on insecure origin %s',
  (url) => {
    expect(setup('/app/', true, true, url)).not.toHaveBeenCalled()
  },
)
it('removes installation metadata when navigating away from the admin surface', () => {
  setup()
  for (const cleanup of cleanups.splice(0)) cleanup()
  expect(document.querySelector('link[rel="manifest"]')).toBeNull()
  expect(document.querySelector('meta[name="apple-mobile-web-app-capable"]')).toBeNull()
})
it('handles unsupported browsers and rejected registration without disrupting the app', async () => {
  cleanups.push(installAdminPwa('/app/', true, true, new URL('https://example.test')))
  const register = setup()
  register.mockRejectedValue(new Error('storage unavailable'))
  cleanups.push(installAdminPwa('/app/', true, true, new URL('https://example.test')))
  await Promise.resolve()
})

it('uses the production build flags by default', () => {
  const register = vi.fn().mockResolvedValue({})
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } })
  vi.stubEnv('PROD', false)
  cleanups.push(installAdminPwa('/app/'))
  expect(register).not.toHaveBeenCalled()
  vi.stubEnv('PROD', true)
  vi.stubEnv('VITE_PWA_ENABLED', 'false')
  cleanups.push(installAdminPwa('/app/'))
  expect(register).not.toHaveBeenCalled()
  vi.stubEnv('VITE_PWA_ENABLED', 'true')
  cleanups.push(installAdminPwa('/app/', undefined, undefined, new URL('https://example.test')))
  expect(register).toHaveBeenCalledOnce()
})
