import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { resetLanguagePreference } from '../i18n/store.ts'
import { takeUnexpectedRequests } from './unexpected-requests.ts'

afterEach(() => {
  cleanup()
  try {
    localStorage.removeItem('hourmere-language')
    // biome-ignore lint/suspicious/noDocumentCookie: clear only the language preference created by this test
    document.cookie = 'hourmere-language=; Path=/; Max-Age=0'
  } catch {
    /* Storage denial tests restore their own mocks. */
  }
  resetLanguagePreference()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  const unexpected = takeUnexpectedRequests()
  if (unexpected.length) {
    throw new Error(`requests the test did not script: ${unexpected.join(', ')}`)
  }
})
