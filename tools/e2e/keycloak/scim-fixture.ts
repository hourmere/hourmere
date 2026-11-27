import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { isDeepStrictEqual } from 'node:util'
import { getRequestListener } from '@hono/node-server'
import {
  createAuth,
  createAuthPool,
  createBrowserSession,
  createCallerResolver,
  scimClaimCompletion,
} from '@hourmere/auth'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase } from '@hourmere/db/testing'
import { createFixtures } from '@hourmere/scheduling/testing'
import { test as base, expect } from '@playwright/test'
import { createApp } from '../../../apps/server/src/app.ts'
import { provisioningTokenRoutes } from '../../../apps/server/src/routes/provisioning-tokens.ts'
import { scimResourceHandlers } from '../../../apps/server/src/scim-resources.ts'
import type { ScimMappingNoticeQueue } from '../../../apps/server/src/scim-team-mapping-notices.ts'
import { listenOwned } from '../listeners.ts'
import { startKeycloak } from './keycloak.ts'
import { createScimCapture } from './scim-capture.ts'
import type { ScimTargetOptions } from './scim-plugin.ts'

type Keycloak = Awaited<ReturnType<typeof startKeycloak>>
type Realm = Awaited<ReturnType<Keycloak['createScimRealm']>>
type Notice = Parameters<ScimMappingNoticeQueue['enqueue']>[1]

const signup = { mode: 'closed', allowedDomains: ['example.test'] } as const
type Session = { id: string; cookie: string }

export interface ScimScenario {
  db: Db
  realm: Realm
  organizationId: string
  childId: string
  childOwnerId: string
  ownerId: string
  ownerSession: Session
  tokenId: string
  credential: string
  connectionId: string
  capture: ReturnType<typeof createScimCapture>
  notices: Notice[]
  noticeQueue: ScimMappingNoticeQueue
  configureTarget: (options?: ScimTargetOptions) => Promise<void>
  request: (path: string, init?: RequestInit) => Promise<Response>
  requestAs: (
    organizationId: string,
    credential: string | null,
    path: string,
    init?: RequestInit,
  ) => Promise<Response>
  signIn: (userId: string, organizationId: string) => Promise<Session>
  sessionRequest: (session: Session, path: string, init?: RequestInit) => Promise<Response>
  readIssuedCredential: (
    response: Response,
    status: number,
  ) => Promise<{
    token: { id: string; previousValidUntil: string | null }
    secret: string
  }>
  seen: (entry: Record<string, unknown>, since?: number) => Promise<void>
}

export const test = base.extend<object, { keycloak: Keycloak }>({
  keycloak: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructuring fixture dependencies.
    async ({}, use) => {
      const container = await startKeycloak({ scim: true })
      try {
        await use(container)
      } finally {
        await container.close()
      }
    },
    { scope: 'worker' },
  ],
})

export async function withScimScenario(
  keycloak: Keycloak,
  literals: readonly string[],
  run: (scenario: ScimScenario) => Promise<void>,
) {
  const bootstrap = process.env.HOURMERE_E2E_BOOTSTRAP_URL
  if (!bootstrap) throw new Error('Keycloak SCIM requires HOURMERE_E2E_BOOTSTRAP_URL')
  const owned = await createTestDatabase(bootstrap, undefined, { tag: 'keycloak_scim' })
  const capture = createScimCapture(literals)
  const privateValues = new Set<string>()
  const containsCredential = (value: string) =>
    [...privateValues].some((credential) => value.includes(credential))
  let authPool: ReturnType<typeof createAuthPool> | undefined
  try {
    const db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    const fixtures = createFixtures(db)
    const organizationId = await fixtures.organization()
    const childId = await fixtures.organization()
    const ownerId = await fixtures.user('SCIM fixture owner')
    await fixtures.member(ownerId, organizationId, 'owner')
    const childOwnerId = await fixtures.user('SCIM fixture child owner')
    await fixtures.member(childOwnerId, childId, 'owner')

    const listener = await listenOwned(createServer())
    try {
      const publicUrl = `http://${keycloak.scimTargetHost}:${listener.port}`
      const secret = randomBytes(32).toString('base64url')
      privateValues.add(secret)
      const notices: Notice[] = []
      const noticeQueue: ScimMappingNoticeQueue = {
        async enqueue(_job, notice, { transaction }) {
          if (
            !transaction ||
            !('isTransaction' in transaction) ||
            transaction.isTransaction !== true
          )
            throw new Error('Expected a transactional SCIM notice')
          notices.push(notice)
          return 'synthetic-scim-notice'
        },
      }
      const auth = createAuth({
        db,
        pool: authPool,
        baseURL: publicUrl,
        secret,
        signup,
        scimResourcesEnabled: true,
        scimClaims: scimClaimCompletion,
        mailer: {
          send: async () => {
            throw new Error('Unexpected SCIM fixture email')
          },
        },
      })
      const app = createApp({
        publicUrl,
        checkDb: async () => {},
        authHandler: auth.handler,
        resolveCaller: createCallerResolver({ auth, db, scimResourcesEnabled: true }),
        routes: [provisioningTokenRoutes({ db, enabled: true })],
        // Only the fixture's loopback client may emulate distinct client addresses.
        trustedProxies: ['127.0.0.1'],
        scim: {
          db,
          enabled: true,
          resources: scimResourceHandlers(db, { signup }, noticeQueue),
        },
      })
      listener.server.on(
        'request',
        getRequestListener(
          (request, bindings) => capture.fetch(request, (message) => app.fetch(message, bindings)),
          {
            hostname: keycloak.scimTargetHost,
          },
        ),
      )
      const signIn = async (userId: string, organizationId: string) => {
        const session = await db.transaction().execute((trx) =>
          createBrowserSession(
            trx,
            { publicUrl, secret },
            {
              userId,
              organizationId,
              now: new Date().toISOString(),
              headers: new Headers(),
            },
          ),
        )
        const cookie = session.cookie.split(';', 1)[0] as string
        const [token, signature] = decodeURIComponent(cookie.split('=')[1] ?? '').split('.')
        if (!token || !signature) throw new Error('Expected a signed fixture session')
        privateValues.add(token)
        privateValues.add(signature)
        return { id: session.id, cookie }
      }
      const sessionRequest: ScimScenario['sessionRequest'] = (session, path, init) => {
        const headers = new Headers(init?.headers)
        headers.set('cookie', session.cookie)
        headers.set('origin', publicUrl)
        headers.set('content-type', 'application/json')
        return fetch(`${listener.url}${path}`, { ...init, headers, redirect: 'error' })
      }
      const requestAs: ScimScenario['requestAs'] = (org, credential, path, init) => {
        const headers = new Headers(init?.headers)
        if (credential !== null) headers.set('authorization', `Bearer ${credential}`)
        headers.set('content-type', 'application/scim+json')
        return fetch(`${listener.url}/scim/v2/${org}${path}`, {
          ...init,
          headers,
          redirect: 'error',
        })
      }
      const readIssuedCredential: ScimScenario['readIssuedCredential'] = async (
        response,
        status,
      ) => {
        expect(response.status).toBe(status)
        expect(response.headers.get('cache-control')).toContain('no-store')
        const issued = await response.json()
        if (typeof issued.secret !== 'string' || !/^scim_[\w-]{43}$/.test(issued.secret))
          throw new Error('Expected a fixture provisioning bearer')
        privateValues.add(issued.secret)
        privateValues.add(createHash('sha256').update(issued.secret).digest('base64url'))
        return issued
      }
      const ownerSession = await signIn(ownerId, organizationId)
      const { token, secret: credential } = await readIssuedCredential(
        await sessionRequest(ownerSession, tokenPath(organizationId), {
          method: 'POST',
          headers: { 'x-expected-organization-id': organizationId },
          body: JSON.stringify({ name: 'Keycloak SCIM fixture' }),
        }),
        201,
      )
      const { connection_id: connectionId } = await db
        .selectFrom('scim_token_connections')
        .select('connection_id')
        .where('token_id', '=', token.id)
        .executeTakeFirstOrThrow()

      const realm = await keycloak.createScimRealm()
      try {
        await run({
          db,
          realm,
          organizationId,
          childId,
          childOwnerId,
          ownerId,
          ownerSession,
          tokenId: token.id,
          credential,
          connectionId,
          capture,
          notices,
          noticeQueue,
          signIn,
          sessionRequest,
          requestAs,
          readIssuedCredential,
          configureTarget: (options) =>
            realm.configureTarget(`${publicUrl}/scim/v2/${organizationId}`, credential, options),
          request: (path, init) => requestAs(organizationId, credential, path, init),
          seen: (entry, since = 0) =>
            expect
              .poll(() => {
                const entries = capture.entries.slice(since)
                if (containsCredential(JSON.stringify(entries)))
                  throw new Error('Protocol capture exposed fixture credential material')
                return entries
              })
              .toContainEqual(expect.objectContaining(entry)),
        })
        const audits = JSON.stringify(await db.selectFrom('audit_events').selectAll().execute())
        expect(
          containsCredential(audits),
          'Audit journal exposed fixture credential material',
        ).toBe(false)
        expect(
          containsCredential(JSON.stringify(capture.entries)),
          'Protocol capture exposed fixture credential material',
        ).toBe(false)
      } finally {
        await realm.close()
      }
    } finally {
      await listener.close()
    }
  } finally {
    let previous: string | undefined
    for (const entry of capture.entries) {
      const line = JSON.stringify(entry)
      if (line !== previous && !containsCredential(line)) console.log(line)
      previous = line
    }
    try {
      await authPool?.end()
    } finally {
      await owned.drop()
    }
  }
}

export function tokenPath(organizationId: string) {
  return `/api/v1/organizations/${organizationId}/provisioning-tokens`
}

export async function assertAudit(
  db: Db,
  {
    organizationId,
    targetId,
    actorType,
    actorId,
    credentialType = 'none',
    credentialId = null,
    targetType,
    actions,
  }: {
    organizationId: string
    targetId: string
    actorType: 'scim_token' | 'scim_connection' | 'system' | 'user'
    actorId: string
    credentialType?: 'none' | 'session'
    credentialId?: string | null
    targetType?: string
    actions: ReadonlyArray<string | { action: string; details: object }>
  },
) {
  const events = await db
    .selectFrom('audit_events')
    .select(['actor_id', 'credential_type', 'credential_id', 'target_type', 'action', 'details'])
    .where('organization_id', '=', organizationId)
    .where('target_id', '=', targetId)
    .where('actor_type', '=', actorType)
    .execute()
  const unmatched = [...events]
  for (const expected of actions) {
    const { action, details } =
      typeof expected === 'string' ? { action: expected, details: {} } : expected
    const index = unmatched.findIndex(
      (event) =>
        event.action === action &&
        event.actor_id === actorId &&
        event.credential_type === credentialType &&
        event.credential_id === credentialId &&
        (targetType === undefined || event.target_type === targetType) &&
        isDeepStrictEqual(event.details, details),
    )
    expect(
      index >= 0,
      `Expected a private ${action} audit event with the correct attribution`,
    ).toBe(true)
    unmatched.splice(index, 1)
  }
  expect(unmatched.length, 'Unexpected audit events for this target and actor type').toBe(0)
}
