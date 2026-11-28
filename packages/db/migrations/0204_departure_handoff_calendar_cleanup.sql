-- The source booking keeps its pinned calendar targets through a disconnect.
-- Calendar and connection IDs are snapshots, so their removal cannot erase an
-- unresolved cleanup outcome. Automatic conference identities use their own state.
CREATE TABLE departure_handoff_calendar_cleanup (
  source_booking_id uuid NOT NULL,
  calendar_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT departure_handoff_calendar_cleanup_pkey PRIMARY KEY (source_booking_id, calendar_id),
  CONSTRAINT departure_handoff_calendar_cleanup_source_fk FOREIGN KEY (source_booking_id)
    REFERENCES bookings (id) ON DELETE CASCADE,
  CONSTRAINT departure_handoff_calendar_cleanup_provider_check CHECK (provider IN ('google', 'microsoft')),
  CONSTRAINT departure_handoff_calendar_cleanup_status_check CHECK (status IN ('pending', 'complete', 'unresolved'))
);
