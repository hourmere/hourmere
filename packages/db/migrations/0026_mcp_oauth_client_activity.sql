-- Keep consent completion after revocation, independently of browser sessions and
-- provider metadata, so abandoned DCR clients and inactive clients age out correctly.
CREATE TABLE mcp_oauth_client_activity (
  client_id text PRIMARY KEY REFERENCES auth."oauthClient" ("clientId") ON DELETE CASCADE,
  consented_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL
);

-- Existing consents and retained tokens prove a client completed authorization.
-- Preserve their latest known activity without changing any grant or credential.
INSERT INTO mcp_oauth_client_activity (client_id, consented_at, last_used_at)
SELECT client_id, min(consented_at), max(last_used_at)
FROM (
  SELECT "clientId" AS client_id, "createdAt" AS consented_at, "updatedAt" AS last_used_at
  FROM auth."oauthConsent"
  UNION ALL
  SELECT "clientId", "createdAt", "createdAt" FROM auth."oauthRefreshToken"
  UNION ALL
  SELECT "clientId", "createdAt", "createdAt" FROM auth."oauthAccessToken"
) AS activity
GROUP BY client_id;
