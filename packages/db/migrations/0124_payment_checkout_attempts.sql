-- Retain the price and provider operation for one Checkout Session per hold.
-- Keep the booking link until the payment operation can be safely retired.
CREATE TABLE payment_checkout_attempts (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings (id) ON DELETE RESTRICT,
  account_id text NOT NULL,
  mode text NOT NULL,
  amount_minor integer NOT NULL,
  currency text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  started_at timestamptz,
  session_id text UNIQUE,
  CONSTRAINT payment_checkout_attempts_positive_amount CHECK (amount_minor > 0),
  CONSTRAINT payment_checkout_attempts_currency CHECK (currency ~ '^[a-z]{3}$'),
  CONSTRAINT payment_checkout_attempts_mode CHECK (mode IN ('test', 'live')),
  CONSTRAINT payment_checkout_attempts_session_started CHECK (session_id IS NULL OR started_at IS NOT NULL)
);
