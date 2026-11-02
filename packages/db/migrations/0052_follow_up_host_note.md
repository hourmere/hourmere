Migration `0052_follow_up_host_note.sql` extends the JSON validation function introduced
by migration 0049.
No columns, defaults, stored policies, booking snapshots, scheduled messages, receipts,
jobs or mail-budget entries are rewritten or created.

An optional `hostNote` belongs only to a follow-up rule. It is plain text, at most 2000
UTF-16 code units: supplementary Unicode characters count as two, matching JavaScript
`string.length`. Empty text, literal HTML, line endings and tabs are accepted. Other
C0/C1 controls, bidi embedding/isolate controls and malformed Unicode are rejected. PostgreSQL JSON/text already rejects
NUL and malformed Unicode; the SQL function enforces the remaining controls and counts
UTF-16 units explicitly. Rendering defensively normalizes CRLF/CR and Unicode line separators to LF, strips controls,
repairs malformed Unicode and bounds the note again before escaping it for HTML.

The upgrade replaces a function, without scanning or rewriting the tables whose CHECK
constraints call it. Existing supported 0049 policies remain valid and byte-for-byte
unchanged, including null legacy booking snapshots. The predecessor test starts at 0049
with realistic related data, default/custom/disabled policies, scheduled follow-ups,
receipts and ledger history; it checks tuple preservation, fresh schema equivalence and
no-op migration reruns. Old processes cannot read the new optional field, so stop all
old application roles before configuring notes and restart matching upgraded roles.
