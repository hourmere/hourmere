-- Reconciliation scans pending deliveries in ID order, skipping locked rows.
-- Keep terminal history out of that ordered scan. Retention has no status predicate
-- and uses created_at; endpoint delivery pages use the existing (webhook_id,id) index.
CREATE INDEX IF NOT EXISTS webhook_deliveries_pending ON webhook_deliveries (id) WHERE status = 'pending';
