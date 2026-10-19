import { createHash } from 'node:crypto'
import { createRoute, z } from '@hono/zod-openapi'
import {
  type Auth,
  MCP_OAUTH_SCOPE,
  MCP_OAUTH_SCOPES,
  mcpOAuthUrls,
  type Principal,
  withMcpOAuthIntent,
} from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import { defineJob } from '@hourmere/jobs'
import { DomainError } from '@hourmere/scheduling'
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import { sql } from 'kysely'
import type { CallerEnv } from '../caller.ts'
import { withClientIpHeader } from '../client-ip.ts'
import { type CallerMiddleware, errorResponses, json, type RouteModule } from '../openapi.ts'
import { createRateLimiter, rateLimit } from '../rate-limit.ts'

const prefix = '/api/v1/mcp-oauth'
const invalid = () => new DomainError('invalid', 'invalid_oauth_request')
const expired = () => new DomainError('conflict', 'oauth_request_expired')
const forbidden = () => new DomainError('forbidden', 'oauth_organization_forbidden')
const stableKeys = [
  'client_id',
  'redirect_uri',
  'response_type',
  'resource',
  'scope',
  'code_challenge',
  'code_challenge_method',
  'state',
  'nonce',
  'dpop_jkt',
]
const Query = z.string().min(1).max(16000)
const Input = z.strictObject({ oauthQuery: Query })
const IntentInput = Input.extend({ intentId: z.uuid() })
const Organization = z.object({ id: z.uuid(), name: z.string(), slug: z.string() })
const Info = z.object({
  clientName: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  scopes: z.array(z.string()),
  organizations: z.array(Organization),
  selectedOrganization: Organization.nullable(),
})
const Redirect = z.object({ redirectUrl: z.string() })

type Deps = { auth?: Pick<Auth, 'handler'> | undefined; db: Db; publicUrl: string }
type Session = Extract<Principal, { kind: 'session' }>
function session(principal: Principal): Session {
  if (principal.kind !== 'session') throw new DomainError('forbidden', 'session_required')
  return principal
}
const hash = (q: URLSearchParams) =>
  createHash('sha256')
    .update(JSON.stringify(stableKeys.map((k) => [k, q.get(k)])))
    .digest()
const lock = (db: Db, userId: string, organizationId: string, clientId: string) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['mcp-oauth', userId, organizationId, clientId])}, 0))`.execute(
    db,
  )

async function recordConsent(db: Db, clientId: string) {
  const now = new Date()
  await db
    .insertInto('mcp_oauth_client_activity')
    .values({ client_id: clientId, consented_at: now, last_used_at: now })
    .onConflict((oc) => oc.column('client_id').doUpdateSet({ last_used_at: now }))
    .execute()
}

export function mcpOAuthBroker({ auth, db, publicUrl }: Deps) {
  const origin = new URL(publicUrl).origin
  const { resource } = mcpOAuthUrls(publicUrl)
  async function native(path: string, body: object, headers: Headers, clientIp?: string) {
    // The provider requires a real Request, and checks the signed query itself. Never pass
    // bearer credentials, caller-supplied Origin/Host, or a caller-supplied endpoint URL.
    const h = new Headers({
      origin,
      accept: 'application/json',
      'content-type': 'application/json',
    })
    const cookie = headers.get('cookie')
    if (cookie) h.set('cookie', cookie)
    if (!auth) throw new DomainError('conflict', 'mcp_oauth_disabled')
    const response = await auth.handler(
      new Request(`${origin}/api/auth/oauth2/${path}`, {
        method: 'POST',
        headers: withClientIpHeader(h, clientIp),
        body: JSON.stringify(body),
      }),
    )
    if (response.status >= 500) throw new Error('MCP authorization provider failed')
    if (!response.ok) throw invalid()
    return {
      value: (await response.json()) as Record<string, unknown>,
      cookies: response.headers.getSetCookie(),
    }
  }
  async function validated(oauthQuery: string, headers: Headers, clientIp?: string) {
    const q = new URLSearchParams(oauthQuery)
    for (const key of new Set(q.keys()))
      if (key !== 'ba_param' && q.getAll(key).length !== 1) throw invalid()
    if (
      !q.has('sig') ||
      !q.has('exp') ||
      q.get('resource') !== resource ||
      q.get('response_type') !== 'code' ||
      q.get('code_challenge_method') !== 'S256' ||
      !q.get('code_challenge')
    )
      throw invalid()
    const scopes = q.get('scope')?.split(' ') ?? []
    if (!scopes.includes(MCP_OAUTH_SCOPE) || scopes.some((s) => !MCP_OAUTH_SCOPES.includes(s)))
      throw invalid()
    const clientId = q.get('client_id'),
      redirectUri = q.get('redirect_uri')
    if (!clientId || !redirectUri) throw invalid()
    // The signature covers exactly the same client, redirect, resource and scopes we show.
    const { value } = await native(
      'public-client-prelogin',
      { client_id: clientId, oauth_query: oauthQuery },
      headers,
      clientIp,
    )
    if (value.client_id !== clientId) throw invalid()
    return {
      q,
      scopes,
      clientId,
      redirectUri,
      clientName:
        typeof value.client_name === 'string'
          ? value.client_name.slice(0, 200)
          : clientId.slice(0, 200),
    }
  }
  async function organizations(p: Session) {
    return db
      .selectFrom('auth.member as m')
      .innerJoin('auth.organization as o', 'o.id', 'm.organizationId')
      .innerJoin('auth.user as u', 'u.id', 'm.userId')
      .select(['o.id', 'o.name', 'o.slug'])
      .where('m.userId', '=', p.user.id)
      .where('u.emailVerified', '=', true)
      .orderBy('o.name')
      .execute()
  }
  async function current(p: Session) {
    const row = await db
      .selectFrom('auth.session')
      .select('id')
      .where('id', '=', p.sessionId)
      .where('userId', '=', p.user.id)
      .where('expiresAt', '>', new Date())
      .executeTakeFirst()
    if (!row) throw expired()
  }
  async function bound(trx: Db, p: Session, intentId: string, q: URLSearchParams) {
    const row = await trx
      .selectFrom('mcp_oauth_intents')
      .selectAll()
      .where('id', '=', intentId)
      .where('user_id', '=', p.user.id)
      .where('session_id', '=', p.sessionId)
      .forUpdate()
      .executeTakeFirst()
    if (
      !row ||
      row.used_at ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      !row.request_hash.equals(hash(q))
    )
      throw expired()
    await lock(trx, p.user.id, row.organization_id, q.get('client_id') as string)
    await current(p)
    const orgs = await organizations(p)
    if (!orgs.some((o) => o.id === row.organization_id)) throw forbidden()
    const grant = await trx
      .selectFrom('mcp_oauth_grants')
      .select('id')
      .where('id', '=', row.grant_id)
      .where('user_id', '=', p.user.id)
      .where('organization_id', '=', row.organization_id)
      .where('client_id', '=', q.get('client_id') as string)
      .executeTakeFirst()
    if (!grant) throw expired()
    return row
  }
  function redirect(value: Record<string, unknown>, intentId: string) {
    const raw = value.url ?? value.redirect_uri
    if (typeof raw !== 'string') throw new Error('Missing MCP authorization redirect')
    const url = new URL(raw, origin)
    const consent = url.origin === origin && url.pathname === '/oauth/consent'
    if (consent) url.hash = new URLSearchParams({ intent: intentId }).toString()
    return { redirectUrl: url.href, consent }
  }
  return {
    async info(
      principal: Principal,
      oauthQuery: string,
      headers: Headers,
      intentId?: string,
      clientIp?: string,
    ) {
      const p = session(principal),
        v = await validated(oauthQuery, headers, clientIp)
      await current(p)
      const orgs = await organizations(p)
      const selected = intentId
        ? await db.transaction().execute(async (trx) => {
            const row = await bound(trx, p, intentId, v.q)
            return orgs.find((o) => o.id === row.organization_id) ?? null
          })
        : null
      return {
        clientName: v.clientName,
        clientId: v.clientId,
        redirectUri: v.redirectUri,
        scopes: v.scopes,
        organizations: orgs,
        selectedOrganization: selected,
      }
    },
    async select(
      principal: Principal,
      oauthQuery: string,
      organizationId: string,
      headers: Headers,
      clientIp?: string,
    ) {
      const p = session(principal),
        v = await validated(oauthQuery, headers, clientIp)
      return db.transaction().execute(async (trx) => {
        await lock(trx, p.user.id, organizationId, v.clientId)
        await current(p)
        if (!(await organizations(p)).some((o) => o.id === organizationId)) throw forbidden()
        const previous = await trx
          .selectFrom('mcp_oauth_grants as g')
          .innerJoin('auth.oauthConsent as c', (j) =>
            j.on(sql<boolean>`c."referenceId" = g.id::text`),
          )
          .select('g.id')
          .where('g.user_id', '=', p.user.id)
          .where('g.organization_id', '=', organizationId)
          .where('g.client_id', '=', v.clientId)
          .where('c.createdAt', '<=', new Date(Date.now() - 30 * 86400000))
          .executeTakeFirst()
        // A new explicit approval starts a new lifetime and grant generation. Keeping the
        // old reference would reuse expired consent and leave every new token unusable.
        if (previous) {
          await trx
            .updateTable('auth.oauthRefreshToken')
            .set({ revoked: new Date(), rotationReplayResponse: null })
            .where('userId', '=', p.user.id)
            .where('clientId', '=', v.clientId)
            .where('referenceId', '=', previous.id)
            .execute()
          await trx
            .deleteFrom('auth.oauthConsent')
            .where('userId', '=', p.user.id)
            .where('clientId', '=', v.clientId)
            .where('referenceId', '=', previous.id)
            .execute()
          await trx.deleteFrom('mcp_oauth_grants').where('id', '=', previous.id).execute()
        }
        const grant = await trx
          .insertInto('mcp_oauth_grants')
          .values({ user_id: p.user.id, organization_id: organizationId, client_id: v.clientId })
          .onConflict((oc) =>
            oc
              .columns(['user_id', 'organization_id', 'client_id'])
              .doUpdateSet({ client_id: v.clientId }),
          )
          .returning('id')
          .executeTakeFirstOrThrow()
        const intent = await trx
          .insertInto('mcp_oauth_intents')
          .values({
            user_id: p.user.id,
            session_id: p.sessionId,
            grant_id: grant.id,
            organization_id: organizationId,
            request_hash: hash(v.q),
            expires_at: new Date(Math.min(Date.now() + 300000, Number(v.q.get('exp')) * 1000)),
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        const nativeResult = await withMcpOAuthIntent(
          {
            id: intent.id,
            userId: p.user.id,
            sessionId: p.sessionId,
            organizationId,
            grantId: grant.id,
          },
          () => native('continue', { postLogin: true, oauth_query: oauthQuery }, headers, clientIp),
        )
        const result = redirect(nativeResult.value, intent.id)
        if (!result.consent) {
          await trx
            .updateTable('mcp_oauth_intents')
            .set({ used_at: new Date() })
            .where('id', '=', intent.id)
            .execute()
          await recordConsent(trx, v.clientId)
        }
        return { redirectUrl: result.redirectUrl, cookies: nativeResult.cookies }
      })
    },
    async consent(
      principal: Principal,
      oauthQuery: string,
      intentId: string,
      accept: boolean,
      headers: Headers,
      clientIp?: string,
    ) {
      const p = session(principal),
        v = await validated(oauthQuery, headers, clientIp)
      return db.transaction().execute(async (trx) => {
        const row = await bound(trx, p, intentId, v.q)
        const nativeResult = await withMcpOAuthIntent(
          {
            id: intentId,
            userId: p.user.id,
            sessionId: p.sessionId,
            organizationId: row.organization_id,
            grantId: row.grant_id,
          },
          () => native('consent', { accept, oauth_query: oauthQuery }, headers, clientIp),
        )
        const result = redirect(nativeResult.value, intentId)
        if (result.consent) throw invalid()
        await trx
          .updateTable('mcp_oauth_intents')
          .set({ used_at: new Date() })
          .where('id', '=', intentId)
          .execute()
        if (accept) await recordConsent(trx, v.clientId)
        return { redirectUrl: result.redirectUrl, cookies: nativeResult.cookies }
      })
    },
    async list(principal: Principal) {
      const p = session(principal)
      const rows = await db
        .selectFrom('mcp_oauth_grants as g')
        .innerJoin('auth.oauthConsent as c', (j) =>
          j.on(sql<boolean>`c."referenceId" = g.id::text`),
        )
        .innerJoin('auth.oauthClient as a', 'a.clientId', 'g.client_id')
        .innerJoin('auth.organization as o', 'o.id', 'g.organization_id')
        .select([
          'c.id',
          'a.name as clientName',
          'g.client_id as clientId',
          'o.name as organizationName',
          'c.createdAt',
        ])
        .where('g.user_id', '=', p.user.id)
        .whereRef('c.userId', '=', 'g.user_id')
        .whereRef('c.clientId', '=', 'g.client_id')
        .orderBy('c.createdAt', 'desc')
        .execute()
      return {
        data: rows.map((r) => ({
          ...r,
          clientName: r.clientName?.slice(0, 200) ?? r.clientId.slice(0, 200),
          createdAt: new Date(r.createdAt).toISOString(),
        })),
      }
    },
    async revoke(principal: Principal, id: string) {
      const p = session(principal)
      await db.transaction().execute(async (trx) => {
        const c = await trx
          .selectFrom('auth.oauthConsent as c')
          .innerJoin('mcp_oauth_grants as g', (j) =>
            j.on(sql<boolean>`c."referenceId" = g.id::text`),
          )
          .select(['g.id', 'g.organization_id', 'g.client_id'])
          .where('c.id', '=', id)
          .where('g.user_id', '=', p.user.id)
          .whereRef('c.userId', '=', 'g.user_id')
          .whereRef('c.clientId', '=', 'g.client_id')
          .executeTakeFirst()
        if (!c) throw new DomainError('not_found', 'oauth_connection_not_found')
        await lock(trx, p.user.id, c.organization_id, c.client_id)
        await trx
          .updateTable('auth.oauthRefreshToken')
          .set({ revoked: new Date(), rotationReplayResponse: null })
          .where('userId', '=', p.user.id)
          .where('clientId', '=', c.client_id)
          .where('referenceId', '=', c.id)
          .execute()
        await trx
          .deleteFrom('auth.oauthConsent')
          .where('userId', '=', p.user.id)
          .where('referenceId', '=', c.id)
          .where('clientId', '=', c.client_id)
          .execute()
        await trx.deleteFrom('mcp_oauth_grants').where('id', '=', c.id).execute()
      })
      return { success: true }
    },
  }
}

export function mcpOAuthRoutes(deps: Deps): RouteModule {
  const broker = mcpOAuthBroker(deps)
  const limit = rateLimit(createRateLimiter({ limit: 30, windowSeconds: 60 }))
  const onlySession = createMiddleware<CallerEnv>(async (c, next) => {
    if (!deps.auth) throw new DomainError('conflict', 'mcp_oauth_disabled')
    session(c.var.principal)
    await next()
  })
  return ({ app, caller }) => {
    const middleware: [
      CallerMiddleware,
      MiddlewareHandler<CallerEnv>,
      MiddlewareHandler<CallerEnv>,
    ] = [caller, onlySession, limit]
    const common = { tags: ['MCP OAuth'], security: [{ session: [] }], middleware }
    const responses = (schema: z.ZodType) => ({
      200: { description: 'MCP connection result', content: json(schema) },
      ...errorResponses({
        400: 'invalid_oauth_request',
        403: 'session_required or oauth_organization_forbidden',
        409: 'oauth_request_expired',
      }),
    })
    app.openapi(
      createRoute({
        ...common,
        method: 'post',
        path: `${prefix}/request`,
        request: {
          body: { required: true, content: json(Input.extend({ intentId: z.uuid().optional() })) },
        },
        responses: responses(Info),
      }),
      async (c) => {
        const b = c.req.valid('json')
        return c.json(
          await broker.info(
            c.var.principal,
            b.oauthQuery,
            c.req.raw.headers,
            b.intentId,
            c.var.clientIp,
          ),
          200,
        )
      },
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'post',
        path: `${prefix}/select`,
        request: {
          body: { required: true, content: json(Input.extend({ organizationId: z.uuid() })) },
        },
        responses: responses(Redirect),
      }),
      async (c) => {
        const b = c.req.valid('json')
        const r = await broker.select(
          c.var.principal,
          b.oauthQuery,
          b.organizationId,
          c.req.raw.headers,
          c.var.clientIp,
        )
        for (const cookie of r.cookies) c.header('Set-Cookie', cookie, { append: true })
        return c.json({ redirectUrl: r.redirectUrl }, 200)
      },
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'post',
        path: `${prefix}/consent`,
        request: {
          body: { required: true, content: json(IntentInput.extend({ accept: z.boolean() })) },
        },
        responses: responses(Redirect),
      }),
      async (c) => {
        const b = c.req.valid('json')
        const r = await broker.consent(
          c.var.principal,
          b.oauthQuery,
          b.intentId,
          b.accept,
          c.req.raw.headers,
          c.var.clientIp,
        )
        for (const cookie of r.cookies) c.header('Set-Cookie', cookie, { append: true })
        return c.json({ redirectUrl: r.redirectUrl }, 200)
      },
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'get',
        path: `${prefix}/connections`,
        responses: responses(
          z.object({
            data: z.array(
              z.object({
                id: z.uuid(),
                clientName: z.string(),
                clientId: z.string(),
                organizationName: z.string(),
                createdAt: z.iso.datetime(),
              }),
            ),
          }),
        ),
      }),
      async (c) => c.json(await broker.list(c.var.principal), 200),
    )
    app.openapi(
      createRoute({
        ...common,
        method: 'delete',
        path: `${prefix}/connections/{id}`,
        request: { params: z.object({ id: z.uuid() }) },
        responses: responses(z.object({ success: z.boolean() })),
      }),
      async (c) => c.json(await broker.revoke(c.var.principal, c.req.valid('param').id), 200),
    )
  }
}

/** TTL cleanup is safe in worker-only deployments, without constructing an auth server. */
export function mcpOAuthCleanupJob(db: Db) {
  return defineJob({
    name: 'mcp-oauth-cleanup',
    payload: z.strictObject({}),
    schedule: { cron: '*/15 * * * *', payload: {} },
    handler: async () => {
      // DCR remains available to older connectors. Only retire dynamically registered,
      // unowned clients; discovered/managed clients have a separate lifecycle. A durable
      // completion record survives revocation so those clients get the 90-day window.
      // Daily activity writes need one day of grace to guarantee 90 full idle days.
      await db
        .deleteFrom('auth.oauthClient as a')
        .where('a.clientDiscoveryId', 'is', null)
        .where('a.userId', 'is', null)
        .where((eb) =>
          eb.or([
            eb.and([
              eb('a.createdAt', '<', new Date(Date.now() - 86400000)),
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('mcp_oauth_client_activity as activity')
                    .select('activity.client_id')
                    .whereRef('activity.client_id', '=', 'a.clientId'),
                ),
              ),
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('auth.oauthConsent as c')
                    .select('c.id')
                    .whereRef('c.clientId', '=', 'a.clientId'),
                ),
              ),
            ]),
            sql<boolean>`greatest(a."createdAt",
              (select activity.last_used_at from mcp_oauth_client_activity as activity
                where activity.client_id = a."clientId"),
              (select max(c."updatedAt") from auth."oauthConsent" as c
                where c."clientId" = a."clientId")) < ${new Date(Date.now() - 91 * 86400000)}`,
          ]),
        )
        .execute()
      await db.deleteFrom('mcp_oauth_intents').where('expires_at', '<', new Date()).execute()
      await db.deleteFrom('auth.oauthClientAssertion').where('expiresAt', '<', new Date()).execute()
      await db
        .deleteFrom('auth.oauthRefreshToken')
        .where('expiresAt', '<', new Date(Date.now() - 86400000))
        .execute()
      await db
        .deleteFrom('auth.oauthAccessToken')
        .where('expiresAt', '<', new Date(Date.now() - 86400000))
        .execute()
      await db
        .deleteFrom('mcp_oauth_grants as g')
        .where('created_at', '<', new Date(Date.now() - 86400000))
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('auth.oauthConsent as c')
                .select('c.id')
                .where(sql<boolean>`c."referenceId" = g.id::text`),
            ),
          ),
        )
        .execute()
    },
  })
}
