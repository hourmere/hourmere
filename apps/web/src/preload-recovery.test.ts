import { afterEach, describe, expect, it, vi } from 'vitest'
import * as browser from './browser.ts'
import { installPreloadRecovery } from './preload-recovery.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  sessionStorage.clear()
})
function install() {
  const remove = installPreloadRecovery()
  cleanups.push(remove)
  return remove
}
function preloadError() {
  const event = new Event('vite:preloadError', { cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe('deployment chunk recovery', () => {
  it('automatically reloads once and suppresses errors while the reload starts', () => {
    const reload = vi.spyOn(browser, 'reloadPage').mockImplementation(() => {})
    install()
    expect(preloadError().defaultPrevented).toBe(true)
    expect(preloadError().defaultPrevented).toBe(true)
    expect(reload).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem('hourmere-preload-reloaded')).toBe('1')
  })

  it('keeps the session guard across page loads and lets repeated failures reach the boundary', () => {
    const reload = vi.spyOn(browser, 'reloadPage').mockImplementation(() => {})
    const remove = install()
    preloadError()
    remove()
    install()
    expect(preloadError().defaultPrevented).toBe(false)
    expect(reload).toHaveBeenCalledOnce()
  })

  it.each(['getItem', 'setItem'] as const)(
    'leaves recovery to the boundary if sessionStorage.%s is denied',
    (operation) => {
      const reload = vi.spyOn(browser, 'reloadPage').mockImplementation(() => {})
      vi.spyOn(Storage.prototype, operation).mockImplementation(() => {
        throw new Error('Storage denied')
      })
      install()
      expect(preloadError().defaultPrevented).toBe(false)
      expect(reload).not.toHaveBeenCalled()
    },
  )

  it('removes the listener when disposed', () => {
    const reload = vi.spyOn(browser, 'reloadPage').mockImplementation(() => {})
    install()()
    expect(preloadError().defaultPrevented).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
