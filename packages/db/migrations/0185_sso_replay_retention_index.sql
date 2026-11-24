-- Bound expired replay-cache scans by finding the oldest tombstones first.
CREATE INDEX sso_replay_cache_retain_until_idx ON sso_replay_cache (retain_until);
