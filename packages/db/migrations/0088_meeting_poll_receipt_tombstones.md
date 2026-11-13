# Meeting poll receipt tombstones

Redefines `retain_meeting_poll_tombstones()`, the `BEFORE DELETE` trigger function on
`meeting_polls`. When a poll is deleted (host deletion, terminal cleanup, deletion of its
linked booking, or organization deletion), its receipts already lost their poll and booking
references and received a purge instant 90 days later. Now every receipt except `create` also
has its `request_fingerprint` replaced by 32 zero bytes. An invitation's fingerprint is an
unkeyed SHA-256 over the poll ID and the invitees' names and mailboxes, so anyone holding the
poll ID could confirm a guessed invitee for 90 days after a privacy deletion.

Only a create replay reads a tombstone; its fingerprint covers the event, candidate starts,
duration, deadline, display zone, admission mode and visibility, none of it person-derived.
Invite, resend, rotate-link and finalize lock the poll before their receipt and answer
`poll_not_found` once it is gone, so their fingerprints have no replay use. The rows stay
until their purge instant, so reusing such a key for another request still gets
`idempotency_key_reused`: the constant never equals a request digest.

The migration also clears the fingerprints of non-`create` tombstones written before it. It
is safe while the previous version runs: that version never reads a tombstone's fingerprint
outside create replay. `meeting-poll-receipt-tombstones-migration.test.ts` upgrades a
populated database, checks that only those fingerprints change, compares the schema with a
fresh installation and reruns the migrations as a no-op.
`meeting-poll-receipt-tombstones-coverage.test.ts` drops the trigger through
`checkConstraintCoverage` and requires a protection assertion to fail.
