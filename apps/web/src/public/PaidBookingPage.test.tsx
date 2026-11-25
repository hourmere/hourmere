import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { chooseLanguage } from '../i18n/store.ts'
import { fakeApi, json, later, renderApp } from '../test/fake-api.tsx'
import { EVENT, eventRoutes } from '../test/public-fixtures.ts'
import type { PublicCheckoutStatus, PublicEventType } from './api.ts'
import { rememberCheckout } from './checkout-return.ts'

vi.mock('./env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./env.ts')>()),
  detectTimeZone: () => 'America/New_York',
  preferredLocale: () => 'en-US',
  now: () => Date.parse('2026-11-01T04:30:00Z'),
}))

beforeAll(async () => {
  await Promise.all([import('./BookingPage.tsx'), import('./CheckoutReturnPage.tsx')])
})

afterEach(() => sessionStorage.removeItem('hourmere:checkout'))

const statusRoute = 'POST /api/v1/public/checkout/status'
const checkoutRoute = 'POST /api/v1/public/ada/intro/checkout'
const returnPath = '/booking/payment'
const token = 'synthetic-status-capability'
const manageToken = 'synthetic-verified-manage-capability'
const selectedSlot = '2026-11-02T14:00:00Z'

const paidEvent: PublicEventType = {
  ...EVENT,
  payment: { currency: 'usd', prices: [{ durationMinutes: 30, amountMinor: 4242 }] },
  paymentAvailable: true,
}

function remember() {
  rememberCheckout({ token, bookingPath: '/ada/intro' })
}

describe('paid booking form', () => {
  it('shows the charged price and only submits one checkout while the form is in flight', async () => {
    const user = userEvent.setup()
    const pending = later()
    const api = fakeApi({
      ...eventRoutes({ ...paidEvent, smsRemindersEnabled: true }, [selectedSlot]),
      [checkoutRoute]: () => pending.response,
      [statusRoute]: () => json(200, { status: 'pending_payment' }),
    })
    renderApp('/ada/intro')
    expect(await screen.findByText(/Price: USD\s42\.42/)).toBeDefined()
    await user.click(await screen.findByRole('button', { name: /November 2, available/ }))
    await user.click(screen.getByRole('button', { name: '9:00 AM' }))
    await user.type(screen.getByLabelText('Your name'), 'Synthetic Visitor')
    await user.type(screen.getByLabelText('Email'), 'synthetic@example.invalid')
    await user.click(screen.getByRole('checkbox', { name: /I agree to SMS booking reminders/ }))
    await user.type(screen.getByLabelText('Your phone number'), '+1 415 555 2671')
    const form = screen.getByRole('button', { name: 'Continue to payment' }).closest('form')
    expect(form).not.toBeNull()
    act(() => {
      fireEvent.submit(form as HTMLFormElement)
      fireEvent.submit(form as HTMLFormElement)
    })
    await waitFor(() => expect(api.to(checkoutRoute)).toHaveLength(1))
    expect(api.to(checkoutRoute)[0]?.body).toMatchObject({
      expectedCurrency: 'usd',
      expectedAmountMinor: 4242,
      inviteePhone: '+14155552671',
      smsConsent: true,
      invitee: { email: 'synthetic@example.invalid' },
    })
    expect(api.to(checkoutRoute)[0]?.headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/)
    await pending.answer(json(200, { statusToken: token, expiresAt: selectedSlot }))
    await screen.findByRole('heading', { name: 'Waiting for payment confirmation' })
    expect(api.to(statusRoute)[0]?.body).toEqual({ token })
    expect(screen.queryByRole('link', { name: 'Manage booking' })).toBeNull()
    expect(screen.queryByText('synthetic@example.invalid')).toBeNull()
  })

  it('shows payment is unavailable without submitting or offering time', async () => {
    fakeApi(eventRoutes({ ...paidEvent, paymentAvailable: false }, [selectedSlot]))
    renderApp('/ada/intro')
    expect(
      await screen.findByText(
        'Online payment is temporarily unavailable. Please contact the host.',
      ),
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Confirm booking' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Continue to payment' })).toBeNull()
  })
})

const locales = [
  [
    'en',
    'Waiting for payment confirmation',
    'Reservation expired',
    'Reservation cancelled',
    'Booking confirmed',
    'A full refund has been requested.',
  ],
  [
    'zh-CN',
    '正在等待付款确认',
    '时间保留已到期',
    '时间保留已取消',
    '预约已确认',
    '已申请全额退款。',
  ],
  [
    'de',
    'Zahlungsbestätigung ausstehend',
    'Reservierung abgelaufen',
    'Reservierung storniert',
    'Buchung bestätigt',
    'Eine vollständige Rückerstattung wurde veranlasst.',
  ],
  [
    'fr',
    'En attente de la confirmation du paiement',
    'Réservation expirée',
    'Réservation annulée',
    'Réservation confirmée',
    'Un remboursement intégral a été demandé.',
  ],
  [
    'es',
    'Esperando la confirmación del pago',
    'La reserva ha caducado',
    'Reserva cancelada',
    'Reserva confirmada',
    'Se ha solicitado un reembolso completo.',
  ],
  [
    'pt-BR',
    'Aguardando a confirmação do pagamento',
    'A reserva expirou',
    'Reserva cancelada',
    'Agendamento confirmado',
    'Foi solicitado um reembolso integral.',
  ],
] as const
const states: PublicCheckoutStatus[] = [
  { status: 'pending_payment' },
  { status: 'expired', latePayment: true, refundStatus: 'requested' },
  { status: 'cancelled' },
  { status: 'paid', manageToken },
]

describe('paid booking return', () => {
  it.each(locales)(
    'shows pending, expired, refunded, cancelled and confirmed states in %s',
    async (locale, pending, expired, cancelled, paid, refund) => {
      chooseLanguage(locale)
      remember()
      const headings = [pending, expired, cancelled, paid]
      for (const [index, status] of states.entries()) {
        const api = fakeApi({ [statusRoute]: () => json(200, status) })
        const rendered = renderApp(returnPath)
        await screen.findByRole('heading', { name: headings[index] })
        expect(api.to(statusRoute)[0]?.body).toEqual({ token })
        const link = rendered.container.querySelector('a[href*="#token="]')
        if (status.status === 'paid')
          expect(link?.getAttribute('href')).toBe(`/booking#token=${manageToken}`)
        else expect(link).toBeNull()
        if (status.latePayment) expect(screen.getByText(refund)).toBeDefined()
        rendered.unmount()
      }
    },
  )

  it('rejects an injected Stripe Session ID without querying payment state', async () => {
    remember()
    fakeApi({})
    renderApp(`${returnPath}?session_id=cs_synthetic_forged`)
    await screen.findByRole('heading', { name: 'We couldn’t find this payment attempt' })
    expect(screen.queryByText(manageToken)).toBeNull()
  })

  it('keeps unknown payment states neutral and withholds management and continuation links', async () => {
    remember()
    fakeApi({
      [statusRoute]: () =>
        json(200, {
          status: 'future-state',
          manageToken,
          successRedirect: { url: 'https://host.example.invalid/', allowEmbedParent: false },
        }),
    })
    renderApp(returnPath)
    await screen.findByText(
      'We couldn’t check the payment. Try again before starting another booking.',
    )
    expect(screen.queryByRole('link', { name: 'Manage booking' })).toBeNull()
    expect(screen.queryByRole('link', { name: /Continue to/ })).toBeNull()
  })

  it('requires an explicit release after cancelling Stripe Checkout', async () => {
    remember()
    const user = userEvent.setup()
    let status: PublicCheckoutStatus['status'] = 'pending_payment'
    const cancelRoute = 'POST /api/v1/public/checkout/cancel'
    const api = fakeApi({
      [statusRoute]: () => json(200, { status }),
      [cancelRoute]: () => {
        status = 'cancelled'
        return json(200, { status })
      },
    })
    renderApp(`${returnPath}?cancel=1`)
    const release = await screen.findByRole('button', { name: 'Release unpaid reservation' })
    expect(api.to(cancelRoute)).toHaveLength(0)
    await user.click(release)
    await screen.findByRole('heading', { name: 'Reservation cancelled' })
    expect(api.to(cancelRoute)[0]?.body).toEqual({ token })
  })
})
