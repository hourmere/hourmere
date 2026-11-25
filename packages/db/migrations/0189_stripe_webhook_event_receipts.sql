-- Keep the deduplication key without storing the event payload or its personal data.
CREATE TABLE payment_stripe_events (
  event_id text PRIMARY KEY
);
