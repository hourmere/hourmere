import { randomUUID } from 'node:crypto'
import type { Principal } from '@hourmere/auth'
import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  freshProofValues,
  type IdentityFixture,
  identityFixture,
  link,
  linkAttemptValues,
  proofValues,
  proveMailbox,
  seeded,
  session,
} from '../../../packages/db/src/sso-identity-fixtures.ts'
import { at, insert, oidcProviderValues } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { createApp } from './app.ts'
import { bindingCookieName, sha256 } from './sso-mailbox-proof.ts'
import { LINK_SSO_ACCOUNT, OIDC_COMPLETE_LINK } from './sso-oidc-link.ts'
import type { SsoTeamReadDeps } from './sso-team-reads.ts'

const publicUrl = 'https://hourmere.example.test'
const browser = 'a'.repeat(43)
const otherBrowser = 'b'.repeat(43)
const withoutSso = {
  kind: 'session',
  sessionId: 'f571ac9b-a4d9-40e8-9500-8d2071a68077',
  user: {
    id: '585d1355-b239-486c-bf76-e7867a1f43ca',
    name: 'Original User',
    email: 'original@example.test',
  },
  personalOrganizationId: 'af514911-7ccb-4db0-8f77-d310b1cb225d',
  organization: {
    id: 'b86334d0-238b-4a2a-8c48-af0dacd2f57b',
    name: 'Example Team',
    slug: 'example-team',
    personal: false,
  },
} satisfies Principal

function me(principal: Principal, ssoTeamReads: SsoTeamReadDeps, headers?: Record<string, string>) {
  const app = createApp({
    checkDb: async () => {},
    authHandler: async () => new Response(null, { status: 404 }),
    resolveCaller: async () => ({ ok: true, principal, setCookie: [] }),
    publicUrl,
    ssoTeamReads,
  })
  return app.request('/api/v1/me', headers ? { headers } : undefined)
}

describe.skipIf(!process.env.DATABASE_URL)('SSO /me projection', () => {
  let owned: TestDatabase
  let fixture: IdentityFixture
  let deps: SsoTeamReadDeps
  let principal: Extract<Principal, { kind: 'session' }>
  let fresh: Record<string, unknown>
  let authorization: Record<string, unknown>
  let completion: Record<string, unknown>
  let proof: Record<string, unknown>
  let secondSession: string
  const browserHeaders = (value = browser) => ({
    cookie: `${bindingCookieName(publicUrl)}=${value}`,
  })

  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    deps = {
      db: createDb(owned.pool),
      capabilities: { ssoOidcEnabled: true, ssoSamlEnabled: false },
    }
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      fixture = await identityFixture(client)
      const f = fixture
      const sessionId = f.sessions[f.member] as string
      secondSession = await session(client, f.member)
      await client.query('UPDATE auth.session SET "activeOrganizationId"=$1 WHERE id=ANY($2)', [
        f.team.toUpperCase(),
        [sessionId, secondSession, f.sessions[f.admin], f.sessions[f.otherOwner]],
      ])
      await insert(client, 'sso_policies', { organization_id: f.team, require_sso: true })
      principal = {
        ...withoutSso,
        sessionId,
        user: { ...withoutSso.user, id: f.member },
        organization: { ...withoutSso.organization, id: f.team },
      }

      const attempt = {
        ...linkAttemptValues(f),
        operation: LINK_SSO_ACCOUNT,
        browser_binding_digest: sha256(browser),
      }
      fresh = await insert(client, 'sso_attempts', {
        ...freshProofValues(f),
        operation: LINK_SSO_ACCOUNT,
        user_id: f.member,
        session_id: sessionId,
        browser_binding_digest: sha256(browser),
      })
      await proveMailbox(client, fresh)
      authorization = await insert(client, 'sso_attempts', attempt)
      completion = await insert(client, 'sso_attempts', {
        ...attempt,
        operation: OIDC_COMPLETE_LINK,
      })
      await insert(client, 'sso_attempts', { ...attempt, session_id: secondSession })
      await insert(client, 'sso_attempts', {
        ...attempt,
        user_id: f.admin,
        session_id: f.sessions[f.admin],
      })
      await insert(client, 'sso_attempts', {
        ...attempt,
        browser_binding_digest: sha256(otherBrowser),
      })
      await insert(client, 'sso_attempts', {
        ...attempt,
        organization_id: f.otherTeam,
        provider_id: f.otherProvider.id,
        provider_revision: f.otherProvider.revision,
      })
      const consumed = await insert(client, 'sso_attempts', attempt)
      await client.query('UPDATE sso_attempts SET consumed_at=clock_timestamp() WHERE id=$1', [
        consumed.id,
      ])
      await seeded(client, 'sso_attempts', { ...attempt, created_at: at(-60), expires_at: at(-30) })
      await link(f, f.admin)
      await link(f, f.member, f.otherProvider)
      const retiredProvider = await insert(client, 'sso_providers', {
        ...oidcProviderValues(f.team),
        enabled: true,
      })
      await link(f, f.member, retiredProvider)
      await client.query(
        'UPDATE sso_providers SET retired_at=clock_timestamp(), enabled=false WHERE id=$1',
        [retiredProvider.id],
      )
      proof = await insert(client, 'sso_browser_proofs', proofValues(f))
      await insert(client, 'sso_browser_proofs', {
        ...proofValues(f),
        session_id: secondSession,
        expires_at: at(120),
      })
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    await owned?.drop()
  })

  it('pins the hard-off /me body byte-for-byte for a team without a policy', async () => {
    const response = await me(withoutSso, {
      db: deps.db,
      capabilities: { ssoOidcEnabled: false, ssoSamlEnabled: false },
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(
      '{"user":{"id":"585d1355-b239-486c-bf76-e7867a1f43ca","name":"Original User","email":"original@example.test"},' +
        '"personalOrganizationId":"af514911-7ccb-4db0-8f77-d310b1cb225d",' +
        '"organization":{"id":"b86334d0-238b-4a2a-8c48-af0dacd2f57b","name":"Example Team","slug":"example-team","personal":false},' +
        '"principal":{"kind":"session","apiKeyId":null}}',
    )
  })
  it('returns only the active team’s safe provider metadata and the caller’s current status', async () => {
    const response = await me(principal, deps, browserHeaders())
    expect(response.status).toBe(200)
    const f = fixture
    const pending = (row: Record<string, unknown>, phase: string, providerId: unknown) => ({
      id: row.id,
      providerId,
      phase,
      mailboxProven: true,
      expiresAt: (row.expires_at as Date).toISOString(),
    })
    expect(await response.json()).toEqual({
      user: principal.user,
      personalOrganizationId: principal.personalOrganizationId,
      organization: principal.organization,
      principal: { kind: 'session', apiKeyId: null },
      sso: {
        requireSso: true,
        providers: [
          {
            id: f.provider.id,
            revision: f.provider.revision,
            displayName: f.provider.display_name,
          },
        ],
        attempts: [
          pending(fresh, 'fresh_proof', null),
          pending(authorization, 'authorization', f.provider.id),
          pending(completion, 'completion', f.provider.id),
        ].toSorted((a, b) => String(a.id).localeCompare(String(b.id))),
        links: [
          { id: f.memberLink.id, providerId: f.provider.id, generation: f.memberLink.generation },
        ],
        proofs: [
          {
            providerId: f.provider.id,
            expiresAt: (proof.expires_at as Date).toISOString(),
          },
        ],
      },
    })
  })

  it('requires a current team session and its own browser for attempts', async () => {
    const noBinding = await me(principal, deps)
    expect(await noBinding.json()).toMatchObject({ sso: { attempts: [] } })
    const noMembership = await me(
      {
        ...principal,
        user: { ...principal.user, id: fixture.otherOwner },
        sessionId: fixture.sessions[fixture.otherOwner] as string,
      },
      deps,
      browserHeaders(),
    )
    expect(noMembership.status).toBe(200)
    expect(await noMembership.json()).not.toHaveProperty('sso')
    const personal = await me(
      { ...principal, organization: { ...principal.organization, personal: true } },
      deps,
      browserHeaders(),
    )
    expect(personal.status).toBe(200)
    expect(await personal.json()).not.toHaveProperty('sso')
  })

  it('limits the own-summary exception to browser sessions', async () => {
    const key = await me(
      { ...principal, kind: 'api_key', apiKeyId: randomUUID(), apiKeyScope: 'full' },
      deps,
      { ...browserHeaders(), authorization: 'Bearer hm_synthetic' },
    )
    expect(key.status).toBe(403)
    expect(await key.json()).toEqual({ error: 'sso_required' })
    const oauth = await me(
      {
        ...principal,
        kind: 'oauth',
        oauthConsentId: randomUUID(),
        clientId: 'synthetic',
        scopes: [],
      },
      deps,
      browserHeaders(),
    )
    expect(oauth.status).toBe(403)
    expect(await oauth.json()).toEqual({ error: 'sso_required' })
  })
})
