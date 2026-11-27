import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { RequestError } from '../../api/errors.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey } from '../../i18n/translate.ts'
import {
  EndpointIdentity,
  usePanelHeading,
  type WebhookEndpoint,
  webhookEventLabel,
} from './WebhookViews.tsx'
import { readWebhookDeliveries, type WebhookDelivery } from './webhook-requests.ts'

const STATUS_LABELS = {
  pending: 'webhook.delivery.pending',
  delivered: 'Delivered',
  failed: 'Failed',
  skipped: 'Skipped',
} as const satisfies Record<WebhookDelivery['status'], MessageKey>

type History = {
  rows: WebhookDelivery[]
  nextAfter: string | null
  status: 'loading' | 'loading-older' | 'ready' | 'error' | 'older-error' | 'invalid-cursor'
}

const loadingFirst: History = { rows: [], nextAfter: null, status: 'loading' }
const ERROR_LABELS: Partial<Record<History['status'], MessageKey>> = {
  error: 'Could not load webhook deliveries.',
  'older-error': 'Could not load older deliveries.',
  'invalid-cursor':
    'This delivery history page is no longer available. Refresh history to start again.',
}

export function WebhookHistory({
  endpoint,
  onClose,
  onBoundaryError,
}: {
  endpoint: WebhookEndpoint
  onClose: () => void
  onBoundaryError: (error: unknown) => boolean
}) {
  const { t, formatLocale } = useI18n()
  const heading = usePanelHeading()
  const [history, setHistory] = useState<History>(loadingFirst)
  const request = useRef<AbortController | null>(null)
  const focusAfterLoad = useRef<{ control: HTMLButtonElement; index: number | null } | null>(null)
  const deliveryList = useRef<HTMLOListElement>(null)
  const refresh = useRef<HTMLButtonElement>(null)
  const { id, organizationId } = endpoint

  const load = useCallback(
    async (after: string | null) => {
      if (request.current) return
      const controller = new AbortController()
      const { signal } = controller
      request.current = controller
      setHistory((current) =>
        after === null ? loadingFirst : { ...current, status: 'loading-older' },
      )
      try {
        const page = await readWebhookDeliveries(organizationId, id, after, signal)
        if (signal.aborted) return
        setHistory((current) => ({
          rows: after === null ? page.rows : [...current.rows, ...page.rows],
          nextAfter: page.nextAfter,
          status: 'ready',
        }))
      } catch (error) {
        if (signal.aborted || onBoundaryError(error)) return
        if (
          error instanceof RequestError &&
          error.status === 400 &&
          error.code === 'invalid_cursor'
        ) {
          setHistory((current) => ({ ...current, nextAfter: null, status: 'invalid-cursor' }))
        } else {
          setHistory((current) => ({
            ...current,
            status: after === null ? 'error' : 'older-error',
          }))
        }
      } finally {
        if (request.current === controller) request.current = null
      }
    },
    [id, onBoundaryError, organizationId],
  )

  useLayoutEffect(() => {
    void load(null)
    return () => {
      request.current?.abort()
      request.current = null
    }
  }, [load])

  const { rows, nextAfter, status } = history
  const loading = status === 'loading' || status === 'loading-older'
  useLayoutEffect(() => {
    if (loading) return
    const pending = focusAfterLoad.current
    focusAfterLoad.current = null
    if (!pending) return
    if (document.activeElement !== pending.control && document.activeElement !== document.body)
      return
    const newRow =
      pending.index === null ? null : deliveryList.current?.children.item(pending.index)
    if (status === 'ready' && newRow instanceof HTMLElement) newRow.focus()
    else if (!pending.control.isConnected) refresh.current?.focus()
  }, [loading, status])

  function fromControl(control: HTMLButtonElement, after: string | null) {
    if (loading || request.current) return
    focusAfterLoad.current =
      document.activeElement === control
        ? { control, index: after === null ? null : rows.length }
        : null
    void load(after)
  }

  const date = new Intl.DateTimeFormat(formatLocale, { dateStyle: 'medium', timeStyle: 'medium' })
  const number = new Intl.NumberFormat(formatLocale)
  const unavailable = (
    <>
      <span aria-hidden="true">—</span>
      <span className="visually-hidden">{t('Not available')}</span>
    </>
  )
  const time = (value: string | null) =>
    value === null ? unavailable : <time dateTime={value}>{date.format(new Date(value))}</time>
  const error = ERROR_LABELS[status]

  return (
    <section className="webhook-history webhook-subpanel stack" aria-labelledby={heading.id}>
      <h4 {...heading}>{t('Delivery history')}</h4>
      <dl className="details webhook-history-details">
        <EndpointIdentity endpoint={endpoint} prefix={heading.id} />
      </dl>
      <div className="webhook-actions form-actions">
        <button
          className="button button-wrap"
          type="button"
          ref={refresh}
          aria-disabled={loading || undefined}
          onClick={(event) => fromControl(event.currentTarget, null)}
        >
          {t('Refresh history')}
        </button>
        <button
          className="button button-wrap"
          type="button"
          onClick={() => {
            request.current?.abort()
            onClose()
          }}
        >
          {t('Close')}
        </button>
      </div>

      {rows.length > 0 && (
        // biome-ignore lint/a11y/noRedundantRoles: WebKit can omit unstyled lists from the accessibility tree.
        <ol className="webhook-endpoints" role="list" ref={deliveryList}>
          {rows.map((row) => (
            <li className="webhook-delivery webhook-subpanel" key={row.id} tabIndex={-1}>
              <h5>{t(webhookEventLabel(row.eventType))}</h5>
              <dl className="details webhook-delivery-details">
                <div>
                  <dt>{t('Status')}</dt>
                  <dd>
                    {t(
                      Object.hasOwn(STATUS_LABELS, row.status)
                        ? STATUS_LABELS[row.status]
                        : 'Unknown status',
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t('Attempts')}</dt>
                  <dd>{number.format(row.attempts)}</dd>
                </div>
                <div>
                  <dt>{t('HTTP status')}</dt>
                  <dd>{row.httpStatus ?? unavailable}</dd>
                </div>
                <div>
                  <dt>{t('Created at')}</dt>
                  <dd>{time(row.createdAt)}</dd>
                </div>
                <div>
                  <dt>{t('Last attempted at')}</dt>
                  <dd>{time(row.lastAttemptAt)}</dd>
                </div>
                <div>
                  <dt>{t('Delivered at')}</dt>
                  <dd>{time(row.deliveredAt)}</dd>
                </div>
                {row.lastErrorLabel && (
                  <div>
                    <dt>{t('Last error')}</dt>
                    <dd>{t(row.lastErrorLabel)}</dd>
                  </div>
                )}
                <div>
                  <dt>{t('Delivery ID')}</dt>
                  <dd className="user-content" data-private>
                    <code>{row.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t('Event ID')}</dt>
                  <dd className="user-content" data-private>
                    <code>{row.eventId}</code>
                  </dd>
                </div>
                <div>
                  <dt>{t('Booking ID')}</dt>
                  <dd className="user-content" data-private>
                    <code>{row.bookingId}</code>
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      )}

      <div role="status" aria-atomic="true">
        {status === 'loading' && t('Loading deliveries…')}
        {status === 'loading-older' && t('Loading older deliveries…')}
        {status === 'ready' &&
          (rows.length === 0
            ? t('No deliveries retained in the last 30 days.')
            : t('{count} deliveries shown.', { count: number.format(rows.length) }))}
      </div>
      {error && (
        <p className="alert alert-error" role="alert">
          {t(error)}
        </p>
      )}
      {(nextAfter !== null || status === 'error') && (
        <div className="webhook-actions form-actions">
          <button
            className="button button-wrap"
            type="button"
            aria-disabled={loading || undefined}
            onClick={(event) => {
              if (status === 'error' && document.activeElement === event.currentTarget)
                refresh.current?.focus()
              fromControl(event.currentTarget, nextAfter)
            }}
          >
            {t(
              status === 'error' || status === 'older-error'
                ? 'Try again'
                : 'Load older deliveries',
            )}
          </button>
        </div>
      )}
    </section>
  )
}
