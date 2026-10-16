import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { takeUnexpectedRequests } from './unexpected-requests.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  const unexpected = takeUnexpectedRequests()
  if (unexpected.length) {
    throw new Error(`requests the test did not script: ${unexpected.join(', ')}`)
  }
})
