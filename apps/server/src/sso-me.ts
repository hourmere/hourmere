import { z } from '@hono/zod-openapi'
import type { Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { parse } from 'hono/utils/cookie'
import { sql } from 'kysely'
import type { SsoCapabilities } from './sso.ts'
import { bindingCookieName, browserBindingDigest } from './sso-mailbox-proof.ts'
import { LINK_SSO_ACCOUNT, OIDC_COMPLETE_LINK } from './sso-oidc-link.ts'

export const MeSso = z
  .object({
    requireSso: z.boolean(),
    providers: z.array(
      z.object({ id: z.uuid(), revision: z.int().positive(), displayName: z.string() }),
    ),
    attempts: z.array(
      z.object({
        id: z.uuid(),
        providerId: z.uuid().nullable(),
        phase: z.string().openapi({
          description: 'Current phases are fresh_proof, authorization and completion.',
        }),
        mailboxProven: z.boolean(),
        expiresAt: z.iso.datetime(),
      }),
    ),
    links: z.array(z.object({ id: z.uuid(), providerId: z.uuid() })),
    proofs: z.array(z.object({ providerId: z.uuid(), expiresAt: z.iso.datetime() })),
  })
  .openapi('MeSso', {
    description: 'The caller’s own SSO status in the active team, when available to this session.',
  })

export interface SsoMeDeps {
  capabilities: SsoCapabilities
  db: Db
}

/** The projection reads only current-team identifiers and status, in one database snapshot. */
export async function readSsoMe(
  { capabilities, db }: SsoMeDeps,
  principal: Principal,
  headers: Headers,
  publicUrl: string,
): Promise<z.infer<typeof MeSso> | undefined> {
  if (
    !capabilities.ssoOidcEnabled ||
    principal.kind !== 'session' ||
    principal.organization.personal ||
    headers.has('authorization')
  )
    return
  const cookieName = bindingCookieName(publicUrl)
  const binding = browserBindingDigest(parse(headers.get('cookie') ?? '', cookieName)[cookieName])
  const { rows } = await sql<z.infer<typeof MeSso>>`
    WITH caller AS (
      SELECT m.id AS member_id, m."userId" AS user_id, m."organizationId" AS organization_id,
        s.id AS session_id, s."expiresAt" AS session_expiry,
        coalesce(policy.require_sso, false) AS require_sso,
        coalesce(policy.trust_generation, 1) AS trust_generation,
        statement_timestamp() AS observed_at
      FROM auth.session s
      JOIN auth.member m ON m."userId" = s."userId"
        AND m."organizationId"::text = lower(s."activeOrganizationId")
      LEFT JOIN sso_policies policy ON policy.organization_id = m."organizationId"
      WHERE s.id = ${principal.sessionId}::uuid AND m."userId" = ${principal.user.id}::uuid
        AND m."organizationId" = ${principal.organization.id}::uuid
        AND s."expiresAt" > statement_timestamp()
    )
    SELECT c.require_sso AS "requireSso",
      to_json(ARRAY(
        SELECT json_build_object('id', p.id, 'revision', p.revision, 'displayName', p.display_name)
        FROM sso_providers p
        WHERE p.organization_id = c.organization_id
          AND p.protocol = 'oidc' AND p.enabled AND p.retired_at IS NULL
        ORDER BY p.id
      )) AS providers,
      to_json(ARRAY(
        SELECT json_build_object(
          'id', a.id, 'providerId', a.provider_id,
          'phase', CASE
            WHEN a.kind = 'fresh_proof' THEN 'fresh_proof'
            WHEN a.operation = ${OIDC_COMPLETE_LINK} THEN 'completion'
            ELSE 'authorization'
          END,
          'mailboxProven', a.kind = 'link' OR a.mailbox_proven_at IS NOT NULL,
          'expiresAt', a.expires_at
        )
        FROM sso_attempts a
        LEFT JOIN sso_providers p ON p.id = a.provider_id
        WHERE a.organization_id = c.organization_id AND a.user_id = c.user_id
          AND a.session_id = c.session_id AND a.browser_binding_digest = ${binding}
          AND a.consumed_at IS NULL AND a.expires_at > c.observed_at
          AND (a.mailbox_proven_at IS NULL OR a.mailbox_proof_expires_at > c.observed_at)
          AND (
            (a.kind = 'fresh_proof' AND a.operation = ${LINK_SSO_ACCOUNT})
            OR (a.kind = 'link' AND a.operation IN (${LINK_SSO_ACCOUNT}, ${OIDC_COMPLETE_LINK})
              AND p.organization_id = c.organization_id AND p.protocol = 'oidc'
              AND p.enabled AND p.retired_at IS NULL AND p.revision = a.provider_revision)
          )
        ORDER BY a.id
      )) AS attempts,
      to_json(ARRAY(
        SELECT json_build_object('id', l.id, 'providerId', l.provider_id)
        FROM sso_identity_links l
        JOIN sso_providers p ON p.id = l.provider_id AND p.organization_id = l.organization_id
        WHERE l.user_id = c.user_id AND l.organization_id = c.organization_id
          AND l.retired_at IS NULL AND p.protocol = 'oidc'
        ORDER BY l.id
      )) AS links,
      to_json(ARRAY(
        SELECT json_build_object(
          'providerId', b.provider_id,
          'expiresAt', least(b.expires_at, c.session_expiry, d.verification_expires_at)
        )
        FROM sso_browser_proofs b
        JOIN sso_identity_links l ON l.id = b.link_id AND l.generation = b.link_generation
        JOIN sso_providers p ON p.id = b.provider_id AND p.organization_id = b.organization_id
        JOIN sso_domains d ON d.id = b.domain_id AND d.organization_id = b.organization_id
          AND d.generation = b.domain_generation
        JOIN sso_provider_domains pd ON pd.organization_id = b.organization_id
          AND pd.domain_id = b.domain_id AND pd.provider_id = b.provider_id
        WHERE b.session_id = c.session_id AND b.user_id = c.user_id AND b.member_id = c.member_id
          AND b.organization_id = c.organization_id AND b.trust_generation = c.trust_generation
          AND b.expires_at > c.observed_at AND l.retired_at IS NULL
          AND p.protocol = 'oidc' AND p.enabled AND p.retired_at IS NULL
          AND d.retired_at IS NULL AND d.verified_at IS NOT NULL
          AND d.verification_expires_at > c.observed_at
        ORDER BY b.id
      )) AS proofs
    FROM caller c
  `.execute(db)
  const summary = rows[0]
  if (!summary) return
  return {
    ...summary,
    attempts: summary.attempts.map((a) => ({
      ...a,
      expiresAt: new Date(a.expiresAt).toISOString(),
    })),
    proofs: summary.proofs.map((p) => ({ ...p, expiresAt: new Date(p.expiresAt).toISOString() })),
  }
}
