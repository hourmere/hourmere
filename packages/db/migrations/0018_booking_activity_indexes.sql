-- Reports are bounded by operation time, independently of the meeting's scheduled start.
CREATE INDEX bookings_organization_created ON bookings (organization_id, created_at);
CREATE INDEX bookings_organization_cancelled ON bookings (organization_id, cancelled_at)
  WHERE status = 'cancelled';
