-- Generated OAuth/JWT plugin tables for Better Auth 1.7.10.
SET LOCAL search_path TO auth, public;

create table "jwks" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz, "alg" text, "crv" text);

create table "oauthClient" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "clientCredentialsScopes" jsonb, "userId" uuid references "user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" boolean, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" jsonb, "responseTypes" jsonb, "requirePKCE" boolean, "dpopBoundAccessTokens" boolean, "referenceId" text, "metadata" jsonb);

create table "oauthResource" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb);

create table "oauthClientResource" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz);

create table "oauthRefreshToken" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" uuid references "session" ("id") on delete set null, "userId" uuid not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table "oauthAccessToken" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" uuid references "session" ("id") on delete set null, "userId" uuid references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" uuid references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table "oauthConsent" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" uuid references "user" ("id") on delete cascade, "referenceId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);

create table "oauthClientAssertion" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expiresAt" timestamptz not null);

create index "oauthClient_userId_idx" on "oauthClient" ("userId");

create index "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");

create index "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");

create index "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId");

create index "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId");

create index "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId");

create index "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");

create index "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");

create index "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId");

create index "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");

create index "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");

create index "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId");

create index "oauthConsent_clientId_idx" on "oauthConsent" ("clientId");

create index "oauthConsent_userId_idx" on "oauthConsent" ("userId");

create unique index "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");

-- One consent per client/user/organization, including the legacy null reference scope.
CREATE UNIQUE INDEX "oauthConsent_client_user_reference_uidx"
  ON "oauthConsent" ("clientId", "userId", "referenceId") NULLS NOT DISTINCT;

SET LOCAL search_path TO public;

-- A short-lived, immutable organization choice for one signed OAuth request/session.
-- Current session and membership are checked before use. These correlation ids have no
-- cascading foreign keys: the broker holds the intent while the auth pool runs OAuth.
-- A new grant identifier on reconnection prevents old JWTs/codes reviving after revocation.
CREATE TABLE mcp_oauth_grants (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  client_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id, client_id)
);
CREATE TABLE mcp_oauth_intents (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_oauth_intents_expiry ON mcp_oauth_intents (expires_at);

-- Keep OAuth consent identifiers for audit just as API key identifiers are retained after
-- deletion. The two credential kinds must never share idempotency or attribution scope.
ALTER TABLE bookings
  ADD COLUMN oauth_consent_id uuid,
  ADD COLUMN cancelled_oauth_consent_id uuid,
  ADD CONSTRAINT bookings_oauth_origin CHECK (
    oauth_consent_id IS NULL OR (source = 'mcp' AND api_key_id IS NULL)
  ),
  ADD CONSTRAINT bookings_cancelled_oauth_origin CHECK (
    cancelled_oauth_consent_id IS NULL OR
    (status = 'cancelled' AND cancelled_source = 'mcp' AND cancelled_api_key_id IS NULL)
  );
DROP INDEX bookings_idempotency;
CREATE UNIQUE INDEX bookings_idempotency
  ON bookings (organization_id, api_key_id, oauth_consent_id, idempotency_key) NULLS NOT DISTINCT
  WHERE idempotency_key IS NOT NULL;
