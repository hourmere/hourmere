import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Schemas } from '../../api/client.ts'
import { RequestError } from '../../api/errors.ts'
import { useMounted } from '../../hooks.ts'
import type { UiText } from '../../i18n/translate.ts'
import { bulkContextKey, bulkData, bulkIssue, useBulkBackoff } from './bulk-cancellation-api.ts'

export const MAX_BULK_SELECTION = 25

export function useBulkBookingSelection({
  organizationId,
  userId,
  onAccessError,
}: {
  organizationId: string
  userId: string
  onAccessError: (error: unknown) => boolean
}) {
  const mounted = useMounted()
  const request = useRef<AbortController | null>(null)
  const [ids, setIds] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [confirmation, setConfirmation] = useState<{
    preview: Schemas['BulkCancellationPreview']
    expiresLocallyAt: number
  } | null>(null)
  const [issue, setIssue] = useState<UiText | null>(null)
  const backoff = useBulkBackoff(`${bulkContextKey(userId, organizationId)}:preview`)

  useEffect(() => () => request.current?.abort(), [])

  const reset = useCallback(() => {
    request.current?.abort()
    request.current = null
    setIds([])
    setConfirmation(null)
    setLoading(false)
    setIssue(null)
  }, [])

  useEffect(() => {
    if (!confirmation) return
    const timer = window.setTimeout(
      () => {
        reset()
        setIssue('Selection expired or changed. Refresh the bookings and select again.')
      },
      Math.max(0, confirmation.expiresLocallyAt - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [confirmation, reset])

  async function review(pageToken: string, bookingIds: string[]) {
    if (!bookingIds.length || request.current || backoff.blocked) return
    setIssue(null)
    setLoading(true)
    const controller = new AbortController()
    request.current = controller
    try {
      const reply = await api.POST('/api/v1/team/bookings/bulk-cancellations/preview', {
        params: { header: { 'x-expected-organization-id': organizationId } },
        body: { pageToken, bookingIds },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      })
      if (!mounted.current || controller.signal.aborted) return
      const preview = bulkData(reply)
      const serverTime = Date.parse(reply.response.headers.get('Date') ?? '')
      const expiresAt = Date.parse(preview.expiresAt)
      setConfirmation({
        preview,
        expiresLocallyAt: Number.isFinite(serverTime)
          ? Date.now() + expiresAt - serverTime
          : expiresAt,
      })
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || onAccessError(error)) return
      if (error instanceof RequestError && error.code === 'bulk_selection_changed') {
        setIds([])
        setIssue('Selection expired or changed. Refresh the bookings and select again.')
      } else {
        if (error instanceof RequestError && error.status === 429) backoff.defer(error)
        setIssue(bulkIssue(error))
      }
    } finally {
      if (request.current === controller) request.current = null
      if (mounted.current && !controller.signal.aborted) setLoading(false)
    }
  }

  return {
    confirmation,
    ids,
    issue,
    loading,
    rateLimited: backoff.blocked,
    setIds,
    reset,
    review,
    close: () => setConfirmation(null),
  }
}
