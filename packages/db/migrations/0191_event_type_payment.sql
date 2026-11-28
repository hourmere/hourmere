-- Existing event types remain free. Holds keep their own independent price snapshot.
ALTER TABLE event_types
  ADD COLUMN payment jsonb,
  ADD CONSTRAINT event_types_payment_check CHECK (
    CASE
      WHEN payment IS NULL THEN true
      WHEN jsonb_typeof(payment) = 'object'
        AND jsonb_typeof(payment->'prices') = 'array'
        AND jsonb_typeof(payment->'currency') = 'string'
      THEN owner_user_id IS NOT NULL
        AND scheduling_type = 'individual'
        AND booking_mode = 'individual'
        AND NOT allow_guests
        AND recurrence IS NULL
        AND payment - ARRAY['currency', 'prices'] = '{}'::jsonb
        AND payment->>'currency' IN ('usd', 'eur', 'gbp', 'cad', 'aud', 'jpy')
        AND jsonb_array_length(payment->'prices') = cardinality(allowed_durations_minutes)
        AND jsonb_path_query_array(payment, '$.prices[*].durationMinutes') = to_jsonb(allowed_durations_minutes)
        AND NOT jsonb_path_exists(
          payment,
          '$.prices[*] ? (@.type() != "object" || !exists(@.amountMinor) ||
            @.amountMinor.type() != "number" || @.amountMinor != @.amountMinor.floor() ||
            @.amountMinor < $minimum || @.amountMinor > 99999999)',
          jsonb_build_object('minimum', CASE WHEN payment->>'currency' = 'gbp' THEN 30 ELSE 50 END)
        )
      ELSE false
    END
  );
