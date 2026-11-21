-- Better Auth stores the reference as text, and existing UUIDs can use mixed case.
-- 0048 guarantees that non-null metadata can be parsed as a JSON object.
-- Exclude non-UUID lengths so arbitrary legacy metadata cannot exceed the btree key limit.
CREATE INDEX apikey_scim_revocation_idx ON auth.apikey
  (lower("referenceId"), lower(metadata::jsonb ->> 'organizationId'))
  WHERE length("referenceId") = 36 AND length(metadata::jsonb ->> 'organizationId') = 36;
