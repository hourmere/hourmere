export const CHECKOUT_RETURN_PATH = '/booking/payment'
const STORAGE_KEY = 'hourmere:checkout'

interface CheckoutReturn {
  token: string
  bookingPath: string
}

export function rememberCheckout(value: CheckoutReturn) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
}

export function readCheckout(): CheckoutReturn | undefined {
  try {
    const value: CheckoutReturn = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null')
    if (typeof value?.token === 'string' && /^\/[a-z0-9-]+\/[a-z0-9-]+$/.test(value.bookingPath))
      return value
  } catch {
    // A blocked browser store or a stale entry cannot establish return authority.
  }
}
