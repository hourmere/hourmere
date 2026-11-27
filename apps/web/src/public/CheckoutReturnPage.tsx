import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { usePageTitle } from '../hooks.ts'
import { useI18n } from '../i18n/runtime.tsx'
import type { MessageKey } from '../i18n/translate.ts'
import {
  cancelPublicCheckout,
  codeOf,
  getPublicCheckoutStatus,
  type PublicCheckoutStatus,
} from './api.ts'
import { readCheckout } from './checkout-return.ts'
import { FocusHeading, PublicLayout } from './PublicLayout.tsx'

const headings = {
  pending_payment: 'Waiting for payment confirmation',
  expired: 'Reservation expired',
  cancelled: 'Reservation cancelled',
  paid: 'Booking confirmed',
} as const satisfies Record<string, MessageKey>

const refundMessages = {
  requested: 'A full refund has been requested.',
  pending: 'Stripe is processing the refund.',
  succeeded: 'Stripe has sent your refund. Your bank may take time to post it.',
  failed: 'The refund could not be completed. Contact the host for help.',
} as const satisfies Record<string, MessageKey>

function checkoutHeading(status: string) {
  return Object.hasOwn(headings, status) ? headings[status as keyof typeof headings] : undefined
}

function refundMessage(status: string | undefined) {
  if (status === undefined) return undefined
  return Object.hasOwn(refundMessages, status)
    ? refundMessages[status as keyof typeof refundMessages]
    : 'bookingPayment.unknown'
}

export function CheckoutReturnPage() {
  const { search, hash } = useLocation()
  // Both provider returns are fixed. A query-supplied Session ID must never select a hold.
  const validReturn = (!search || search === '?cancel=1') && !hash && window.self === window.top
  return <CheckoutOutcome key={`${search}${hash}`} validReturn={validReturn} />
}

function CheckoutOutcome({ validReturn }: { validReturn: boolean }) {
  const { t } = useI18n()
  const [checkout] = useState(() => validReturn && readCheckout())
  const token = checkout ? checkout.token : undefined
  const [result, setResult] = useState<PublicCheckoutStatus>()
  const [error, setError] = useState<'missing' | 'retry'>()
  const [version, setVersion] = useState(0)
  const [cancelling, setCancelling] = useState(false)
  const cancellation = useRef<AbortController | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => cancellation.current?.abort(), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the explicit retry trigger
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    request.current = controller
    let timer: ReturnType<typeof setTimeout>
    async function poll(statusToken: string) {
      try {
        const status = await getPublicCheckoutStatus(statusToken, controller.signal)
        if (controller.signal.aborted) return
        setResult(status)
        setError(undefined)
        // A charge can arrive after cancellation or expiry. Continue checking terminal
        // holds at a gentler interval while the return page is open.
        if (
          checkoutHeading(status.status) &&
          status.status !== 'paid' &&
          status.refundStatus !== 'succeeded' &&
          status.refundStatus !== 'failed'
        )
          timer = setTimeout(
            () => void poll(statusToken),
            status.status === 'pending_payment' ? 3000 : 10000,
          )
      } catch (error) {
        if (!controller.signal.aborted)
          setError(codeOf(error) === 'payment_checkout_not_found' ? 'missing' : 'retry')
      }
    }
    void poll(token)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [token, version])

  async function cancel() {
    if (!token || cancellation.current) return
    request.current?.abort()
    const controller = new AbortController()
    cancellation.current = controller
    setCancelling(true)
    try {
      const status = await cancelPublicCheckout(token, controller.signal)
      if (!controller.signal.aborted) setResult(status)
    } catch (error) {
      if (!controller.signal.aborted)
        setError(codeOf(error) === 'payment_checkout_not_found' ? 'missing' : 'retry')
    } finally {
      if (!controller.signal.aborted) {
        cancellation.current = null
        setCancelling(false)
        setVersion((value) => value + 1)
      }
    }
  }

  usePageTitle('Payment status')
  const unavailable = !token || error === 'missing'
  const knownHeading = result && checkoutHeading(result.status)
  const heading = unavailable
    ? 'We couldn’t find this payment attempt'
    : (knownHeading ?? 'Payment status')
  const refund = refundMessage(result?.refundStatus)
  return (
    <PublicLayout>
      <section className="card public-card stack" aria-labelledby="checkout-status-heading">
        <FocusHeading level={1} id="checkout-status-heading">
          {t(heading)}
        </FocusHeading>
        {unavailable ? (
          <p role="status">
            {t(
              'Return to the tab where you started payment. If your booking was confirmed, use the link in your confirmation email.',
            )}
          </p>
        ) : error === 'retry' || (result && !knownHeading) ? (
          <>
            <p role="alert">
              {t('We couldn’t check the payment. Try again before starting another booking.')}
            </p>
            <button
              type="button"
              className="button"
              onClick={() => setVersion((value) => value + 1)}
            >
              {t('Try again')}
            </button>
          </>
        ) : !result ? (
          <p role="status">{t('Loading…')}</p>
        ) : (
          <>
            {result.status === 'pending_payment' && (
              <>
                <p role="status">
                  {t(
                    'Your time is reserved for up to 30 minutes. Hourmere will confirm the booking after it receives the payment.',
                  )}
                </p>
                <button type="button" className="button" onClick={cancel} disabled={cancelling}>
                  {t('Release unpaid reservation')}
                </button>
              </>
            )}
            {result.latePayment && (
              <p role="status">
                {t('Payment arrived after the reservation ended. Your booking was not confirmed.')}
              </p>
            )}
            {refund && <p role="status">{t(refund)}</p>}
            {result.manageToken && (result.status === 'paid' || result.status === 'cancelled') && (
              <Link
                className="button"
                to={`/booking#token=${encodeURIComponent(result.manageToken)}`}
              >
                {t('Manage booking')}
              </Link>
            )}
            {result.status === 'paid' && result.successRedirect && (
              <a className="button" href={result.successRedirect.url} rel="noopener noreferrer">
                {t('Continue to {host}', { host: new URL(result.successRedirect.url).host })}
              </a>
            )}
            {checkout && (result.status === 'expired' || result.status === 'cancelled') && (
              <Link className="button" to={checkout.bookingPath}>
                {t('Choose another time')}
              </Link>
            )}
          </>
        )}
      </section>
    </PublicLayout>
  )
}
