import { type ReactNode, useId, useLayoutEffect, useRef } from 'react'
import type { Schemas } from '../../api/client.ts'
import type { zoned } from '../../format.ts'
import { useI18n } from '../../i18n/runtime.tsx'
import type { MessageKey, UiText } from '../../i18n/translate.ts'
import type { BulkResult } from './useBulkCancellationReceipt.ts'

export type BulkPreview = Schemas['BulkCancellationPreview']
type BulkItem = BulkPreview['items'][number] | BulkResult['items'][number]
type Booking = Schemas['TeamAdminBooking']

const outcomes = {
  eligible: 'Eligible to cancel',
  pending: 'Awaiting processing',
  cancelled: 'Cancelled',
  already_cancelled: 'Already cancelled',
  booking_started: 'Booking already started',
  booking_not_supported: 'Unsupported booking (including paid or imported bookings)',
  booking_unavailable: 'Booking unavailable',
  booking_host_departed: 'A required host left the team',
  authorization_lost: 'Team authority was lost',
  processing_failed: 'Could not process the booking',
} as const satisfies Record<BulkItem['code'], MessageKey>

export function BulkCancellationCounts({ result }: { result: BulkResult }) {
  const { t } = useI18n()
  const { cancelled, pending } = result.counts
  return t('{cancelled} cancelled, {pending} pending, {other} skipped or failed.', {
    cancelled,
    pending,
    other: result.items.length - cancelled - pending,
  })
}

export function bulkResultTitle(state: BulkResult['state']): MessageKey {
  if (state === 'completed') return 'Bulk cancellation completed'
  return state === 'queued' ? 'Bulk cancellation queued' : 'Bulk cancellation in progress'
}

export function BulkCancellationDialog({
  preview,
  result,
  issue,
  checking,
  unconfirmed,
  retry,
  retryBlocked,
  busy,
  rows,
  format,
  team,
  filters,
  close,
  confirm,
}: {
  preview: BulkPreview | null
  result: BulkResult | null
  issue: UiText | null
  checking: boolean
  unconfirmed: boolean
  retry?: (() => void) | undefined
  retryBlocked: boolean
  busy: boolean
  rows: ReadonlyMap<string, Booking>
  format: ReturnType<typeof zoned>
  team: string
  filters: [MessageKey, string][]
  close: () => void
  confirm: () => void
}) {
  const { t, ui } = useI18n()
  const eligible = preview?.items.filter((item) => item.code === 'eligible').length ?? 0
  const items = preview?.items ?? result?.items ?? []
  return (
    <BulkDialog
      title={preview ? 'Review bulk cancellation' : 'Bulk cancellation status'}
      close={close}
    >
      <dl className="details">
        <dt>{t('Team')}</dt>
        <dd className="user-content">
          <bdi>{team}</bdi>
        </dd>
        <dt>{t('Time zone')}</dt>
        <dd>{format.timeZone.replaceAll('_', ' ')}</dd>
      </dl>
      {preview && (
        <>
          <h3>{t('Filters applied')}</h3>
          <dl className="details">
            {filters.map(([label, value]) => (
              <FilterDetail key={label} label={t(label)} value={value} />
            ))}
          </dl>
          <p>
            {t('{count} selected. {eligible} eligible to cancel.', {
              count: preview.items.length,
              eligible,
            })}
          </p>
          <p>
            {t(
              'Cancellation is irreversible. Existing cancellation notifications will be queued as applicable. Some bookings may become ineligible before they are processed.',
            )}
          </p>
        </>
      )}
      {!preview && (
        <>
          <div role="status" aria-atomic="true">
            {result ? (
              <>
                <p>
                  <strong>{t(bulkResultTitle(result.state))}</strong>
                </p>
                <p>
                  <BulkCancellationCounts result={result} />
                </p>
              </>
            ) : checking && !retry ? (
              <p>
                {t(
                  unconfirmed
                    ? 'Submission could not be confirmed. This page will keep checking its status.'
                    : 'Checking whether your cancellation was accepted…',
                )}
              </p>
            ) : null}
          </div>
          {retry && (
            <p>
              {t(
                'Your cancellation has not been confirmed yet. You can safely retry this submission.',
              )}
            </p>
          )}
          {result?.state === 'completed'
            ? result.items.some(({ code }) => code !== 'cancelled') && (
                <p>
                  {t(
                    'To try an unsuccessful booking again, refresh the list and select it if it is still eligible.',
                  )}
                </p>
              )
            : (result || checking) && (
                <p>{t('Closing this view does not stop an accepted cancellation.')}</p>
              )}
        </>
      )}
      {issue && (
        <p className="alert alert-error" role="alert">
          {ui(issue)}
        </p>
      )}
      {items.length > 0 && (
        <ol className="team-bulk-items">
          {items.map(({ bookingId, code }) => {
            const booking = code === 'booking_unavailable' ? undefined : rows.get(bookingId)
            const invitee =
              booking?.attendees.find((person) => person.isBooker) ?? booking?.attendees[0]
            return (
              <li key={bookingId} className="team-bulk-item">
                {booking ? (
                  <>
                    <strong className="user-content">
                      <bdi>{booking.eventType?.title ?? t('Deleted event type')}</bdi>
                    </strong>
                    <div>{format.dateTime(booking.start)}</div>
                    {invitee && (
                      <div className="user-content">
                        <bdi>{invitee.name}</bdi>
                      </div>
                    )}
                  </>
                ) : (
                  <bdi>{bookingId}</bdi>
                )}
                <div>{t(outcomes[code])}</div>
              </li>
            )
          })}
        </ol>
      )}
      <div className="form-actions">
        <button type="button" className="button" onClick={close}>
          {t('Close')}
        </button>
        {preview && (
          <button
            type="button"
            className="button button-danger"
            onClick={confirm}
            disabled={busy || eligible === 0}
          >
            {t(eligible === 1 ? 'Cancel {count} booking' : 'Cancel {count} bookings', {
              count: eligible,
            })}
          </button>
        )}
        {retry && (
          <button type="button" className="button" onClick={retry} disabled={retryBlocked}>
            {t('Retry submission')}
          </button>
        )}
      </div>
    </BulkDialog>
  )
}

function FilterDetail({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  )
}

function BulkDialog({
  title,
  close,
  children,
}: {
  title: 'Review bulk cancellation' | 'Bulk cancellation status'
  close: () => void
  children: ReactNode
}) {
  const { t } = useI18n()
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    if (typeof element.showModal === 'function') element.showModal()
    else element.setAttribute('open', '')
    return () => {
      if (typeof element.close === 'function') element.close()
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus again when the dialog changes purpose.
  useLayoutEffect(() => {
    // The confirmation action disappears when the same dialog switches to progress.
    heading.current?.focus()
  }, [title])
  return (
    <dialog
      ref={dialog}
      className="one-time-link-dialog team-bulk-dialog"
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <h2 id={id} ref={heading} tabIndex={-1}>
        {t(title)}
      </h2>
      {children}
    </dialog>
  )
}
