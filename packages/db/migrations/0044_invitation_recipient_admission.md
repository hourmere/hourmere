# Invitation recipient admission accounting

Invitation admission now records its recipient HMAC on `invitation_email_requests`
instead of reserving `notification_email_sends`, the ledger for actual shared mail
capacity. A future invitation sender must debit ordinary, non-reserved capacity at
send time. The migration preserves every existing row and column value.

Existing request rows do not contain a recipient identity, so the new nullable column
cannot be backfilled. Existing inviter/team counts remain effective. The separate
recipient admission windows fill within 24 hours of the upgrade. Existing shared mail
ledger rows remain unchanged and expire under their existing rolling/retention policy.

Follow the normal stop-all-roles, backup and upgrade procedure. Once any new process
has applied migrations, rollback uses the documented database backup restore procedure.
