import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Schemas } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import { useMounted } from '../../hooks.ts'
import type { UiText } from '../../i18n/translate.ts'
import {
  bulkContextKey,
  bulkData,
  bulkIssue,
  readBulkDeadline,
  saveBulkDeadline,
  useBulkBackoff,
} from './bulk-cancellation-api.ts'

type Receipt = { id: string; expiresAt: string }
export type BulkResult = Exclude<
  Schemas['BulkCancellationStatus'],
  { state: 'awaiting_confirmation' }
>

const POLL_INTERVAL = 3_000
const REQUEST_TIMEOUT = 15_000
const receiptPath = '/api/v1/team/bookings/bulk-cancellations/{id}'
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

function readReceipt(key: string): Receipt | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (
      typeof stored?.id === 'string' &&
      uuid.test(stored.id) &&
      typeof stored.expiresAt === 'string' &&
      Number.isFinite(Date.parse(stored.expiresAt))
    ) {
      return { id: stored.id, expiresAt: stored.expiresAt }
    }
  } catch {
    // Storage can be unavailable. Status recovery still works in the open view.
  }
  return null
}

function storeReceipt(key: string, receipt: Receipt | null) {
  try {
    if (receipt) sessionStorage.setItem(key, JSON.stringify(receipt))
    else sessionStorage.removeItem(key)
  } catch {
    // The current view retains the receipt in memory in this case.
  }
}

export function useBulkCancellationReceipt({
  enabled,
  organizationId,
  userId,
  onAccessError,
  refreshBookings,
}: {
  enabled: boolean
  organizationId: string
  userId: string
  onAccessError: (error: unknown) => boolean
  refreshBookings: () => void
}) {
  const key = bulkContextKey(userId, organizationId)
  const statusDeadlineKey = `${key}:status`
  const [receipt, setReceipt] = useState(() => readReceipt(key))
  const [result, setResult] = useState<BulkResult | null>(null)
  const [issue, setIssue] = useState<UiText | null>(null)
  const [stopped, setStopped] = useState(false)
  const [unconfirmed, setUnconfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [canRetry, setCanRetry] = useState(false)
  const backoff = useBulkBackoff(`${key}:confirm`)
  const originalReceipt = useRef<string | null>(null)
  const submission = useRef<AbortController | null>(null)
  const nextPoll = useRef(0)
  const mounted = useMounted()

  useEffect(() => () => submission.current?.abort(), [])

  const abandonRetry = useCallback(() => {
    originalReceipt.current = null
    setCanRetry(false)
  }, [])

  const endRecovery = useCallback(
    (message: UiText) => {
      abandonRetry()
      setIssue(message)
      storeReceipt(key, null)
      setReceipt(null)
      refreshBookings()
    },
    [abandonRetry, key, refreshBookings],
  )

  async function submit(target: Receipt, first: boolean) {
    if (
      !enabled ||
      submission.current ||
      backoff.blocked ||
      (!first && (target.id !== originalReceipt.current || !canRetry))
    )
      return

    if (first) {
      originalReceipt.current = target.id
      setResult(null)
      setStopped(false)
      storeReceipt(key, target)
      setReceipt(target)
    }
    setCanRetry(false)
    setUnconfirmed(false)
    setIssue(null)
    setSubmitting(true)
    const controller = new AbortController()
    submission.current = controller
    try {
      bulkData(
        await api.POST('/api/v1/team/bookings/bulk-cancellations/{id}/confirm', {
          params: {
            path: { id: target.id },
            header: { 'x-expected-organization-id': organizationId },
          },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
        }),
      )
      if (mounted.current && !controller.signal.aborted) originalReceipt.current = null
    } catch (error) {
      if (controller.signal.aborted || !mounted.current || onAccessError(error)) return
      if (error instanceof RequestError) {
        if (error.code === 'bulk_confirmation_expired') {
          endRecovery(
            'The confirmation expired. Select bookings again to start a new cancellation.',
          )
          return
        }
        if (error.status === 429) backoff.defer(error)
        if (error.code === 'bulk_no_eligible_bookings') {
          endRecovery(
            'No selected bookings are eligible for cancellation. Review a fresh selection.',
          )
          return
        }
        // The same account can read an unused receipt from a previous session, but
        // a new session cannot use it to submit. The 404 from confirm is definitive.
        if (error.status === 403 || error.status === 404) originalReceipt.current = null
        setIssue(bulkIssue(error))
      }
      // A network failure can follow a committed admission. Check this receipt before retrying.
    } finally {
      if (submission.current === controller) submission.current = null
      if (mounted.current && !controller.signal.aborted) setSubmitting(false)
    }
  }

  useEffect(() => {
    if (!enabled || !receipt || submitting || stopped || result?.state === 'completed') return
    const controller = new AbortController()
    let timer: number | undefined
    let request: AbortController | undefined
    let finished = false

    function schedule() {
      window.clearTimeout(timer)
      if (finished || document.hidden || controller.signal.aborted || request) return
      const deadline = Math.max(nextPoll.current, readBulkDeadline(statusDeadlineKey))
      timer = window.setTimeout(() => void poll(), Math.max(0, deadline - Date.now()))
    }

    async function poll() {
      if (document.hidden || controller.signal.aborted || !receipt) return
      const activeRequest = new AbortController()
      request = activeRequest
      nextPoll.current = Date.now() + POLL_INTERVAL
      saveBulkDeadline(statusDeadlineKey, nextPoll.current)
      const current = () =>
        mounted.current && !controller.signal.aborted && !activeRequest.signal.aborted
      let serverTime = Number.NaN
      try {
        const response = await api.GET(receiptPath, {
          params: {
            path: { id: receipt.id },
            header: { 'x-expected-organization-id': organizationId },
          },
          signal: AbortSignal.any([activeRequest.signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
        })
        if (!current()) return
        serverTime = Date.parse(response.response.headers.get('Date') ?? '')
        const data = bulkData(response)
        if (data.state === 'awaiting_confirmation') {
          setUnconfirmed(true)
          setCanRetry(originalReceipt.current === receipt.id)
        } else {
          abandonRetry()
          setUnconfirmed(false)
          setIssue(null)
          setResult(data)
          if (data.state === 'completed') {
            finished = true
            refreshBookings()
          }
        }
      } catch (error) {
        if (!current()) return
        if (onAccessError(error)) {
          finished = true
          abandonRetry()
          return
        }
        if (error instanceof RequestError) {
          if (error.code === 'bulk_confirmation_expired') {
            finished = true
            endRecovery(
              'The confirmation expired. Select bookings again to start a new cancellation.',
            )
            return
          }
          if (error.status === 404) {
            const unavailable =
              error.code !== 'bulk_cancellation_not_found' ||
              serverTime >= Date.parse(receipt.expiresAt)
            if (unavailable) {
              finished = true
              endRecovery(
                'This batch is no longer available. Refresh the bookings before starting again.',
              )
            } else {
              setUnconfirmed(true)
              setCanRetry(originalReceipt.current === receipt.id)
            }
            return
          }
          if (error.status === 403) {
            finished = true
            setStopped(true)
            abandonRetry()
          }
          if (error.status === 429) {
            nextPoll.current = Math.max(
              nextPoll.current,
              Date.now() + (error.retryAfterSeconds ?? 3) * 1000,
            )
            saveBulkDeadline(statusDeadlineKey, nextPoll.current)
          }
        }
        setIssue(bulkIssue(error))
      } finally {
        request = undefined
        schedule()
      }
    }

    function visibilityChanged() {
      if (document.hidden) request?.abort()
      schedule()
    }
    document.addEventListener('visibilitychange', visibilityChanged)
    schedule()
    return () => {
      controller.abort()
      request?.abort()
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [
    abandonRetry,
    enabled,
    endRecovery,
    mounted,
    onAccessError,
    organizationId,
    receipt,
    refreshBookings,
    result?.state,
    stopped,
    statusDeadlineKey,
    submitting,
  ])

  return {
    abandonRetry,
    canRetry,
    issue,
    receipt,
    result,
    retryBlocked: submitting || backoff.blocked,
    stopped,
    unconfirmed,
    submit,
  }
}
