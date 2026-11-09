-- One normalized image per organization bounds storage; hashes address immutable content.
CREATE TABLE organization_brand_logos (
  organization_id uuid PRIMARY KEY REFERENCES auth.organization(id) ON DELETE CASCADE,
  hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 524288),
  UNIQUE (organization_id, hash)
);
-- Keep product settings outside Better Auth's native organization response boundary.
CREATE TABLE organization_branding (
  organization_id uuid PRIMARY KEY REFERENCES auth.organization(id) ON DELETE CASCADE,
  brand_logo text,
  brand_primary_color text CHECK (brand_primary_color ~ '^#[0-9A-F]{6}$'),
  CONSTRAINT organization_brand_logo_fk FOREIGN KEY (organization_id, brand_logo)
    REFERENCES organization_brand_logos(organization_id, hash) DEFERRABLE INITIALLY DEFERRED
);
