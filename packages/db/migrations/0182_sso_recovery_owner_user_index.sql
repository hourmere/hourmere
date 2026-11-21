-- The runner applies each migration in a transaction, so index creation takes
-- a write-blocking lock. Bound both the wait for the lock and the index build.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';

CREATE INDEX sso_recovery_owners_user_id ON sso_recovery_owners (user_id);
