CREATE TABLE webhooks (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
    url text NOT NULL CHECK (octet_length(url) BETWEEN 1 AND 2048),
    events text[] NOT NULL CHECK (
        cardinality(events) BETWEEN 1 AND 3 AND
        events <@ ARRAY['booking.created', 'booking.rescheduled', 'booking.cancelled']::text[]
    ),
    is_active boolean NOT NULL DEFAULT true,
    secret_ciphertext bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, organization_id)
);
CREATE INDEX webhooks_organization ON webhooks(organization_id, id);

CREATE TABLE webhook_deliveries (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    webhook_id uuid NOT NULL,
    organization_id uuid NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
    booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    event_id uuid NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('booking.created', 'booking.rescheduled', 'booking.cancelled')),
    payload text NOT NULL CHECK (octet_length(payload) <= 8192),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'skipped')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 13),
    http_status integer CHECK (http_status BETWEEN 100 AND 599),
    last_error text CHECK (last_error IN ('transport_error', 'http_error', 'disabled', 'expired', 'secret_unavailable')),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_attempt_at timestamptz,
    delivered_at timestamptz,
    FOREIGN KEY (webhook_id, organization_id) REFERENCES webhooks(id, organization_id) ON DELETE CASCADE,
    UNIQUE (webhook_id, booking_id, event_type)
);
CREATE INDEX webhook_deliveries_endpoint ON webhook_deliveries(webhook_id, id);
CREATE INDEX webhook_deliveries_retention ON webhook_deliveries(created_at);
