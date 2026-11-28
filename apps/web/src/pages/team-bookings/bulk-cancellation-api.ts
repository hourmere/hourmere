import { useEffect, useState } from 'react'
import { errorMessage, RequestError, requestError } from '../../api/errors.ts'
import { msg, type UiText } from '../../i18n/translate.ts'

export function bulkData<T>({
  data,
  error,
  response,
}: {
  data?: T
  error?: unknown
  response: Response
}): T {
  if (!response.ok) {
    throw requestError(response.status, error, response.headers.get('Retry-After'))
  }
  return data as T
}

export function bulkIssue(error: unknown): UiText {
  if (error instanceof RequestError) {
    if (error.retryAfterSeconds)
      return msg('Try again in {seconds} seconds.', { seconds: error.retryAfterSeconds })
    if (error.code === 'bulk_queue_full')
      return 'The team has reached its bulk cancellation limit. Try again shortly.'
    if (error.code === 'sso_required') return 'Sign in with this team’s SSO to continue.'
  }
  return errorMessage(error)
}

export function bulkContextKey(userId: string, organizationId: string) {
  return `hourmere:team-bulk-cancellation:${userId}:${organizationId}`
}

// Account/team limits outlive a particular filtered list and its receipt.
export function readBulkDeadline(key: string): number {
  try {
    const deadline = Number(sessionStorage.getItem(key))
    if (Number.isFinite(deadline) && deadline > Date.now()) return deadline
  } catch {
    // The current view still enforces its own request schedule without storage.
  }
  return 0
}

export function saveBulkDeadline(key: string, deadline: number) {
  try {
    sessionStorage.setItem(key, String(deadline))
  } catch {
    // The current view still enforces its own request schedule without storage.
  }
}

export function useBulkBackoff(key: string) {
  const [deadline, setDeadline] = useState(() => readBulkDeadline(key))
  useEffect(() => {
    if (!deadline) return
    const timeout = window.setTimeout(() => setDeadline(0), Math.max(0, deadline - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [deadline])
  function defer(error: RequestError) {
    const until = Date.now() + (error.retryAfterSeconds ?? 3) * 1000
    saveBulkDeadline(key, until)
    setDeadline(until)
  }
  return { blocked: deadline > Date.now(), defer }
}
