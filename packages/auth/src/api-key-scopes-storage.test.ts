import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_KEY_ORGANIZATION_MEMBERSHIP_MESSAGE } from './api-key-errors.ts'
import { type ApiKeyScope, parsePersistedApiKeyMetadata } from './api-key-metadata.ts'
import { requireActiveApiKey } from './api-key-principal.ts'
import { createCallerResolver } from './caller.ts'
import { beforeHook } from './hooks.ts'
import { type Auth, createAuth, createAuthPool, ensurePersonalOrganization } from './index.ts'

const serverUrl = process.env.DATABASE_URL
const signup = { mode: 'open', allowedDomains: [] } as const
const secret = 'synthetic-scoped-key-storage-test-secret-at-least-32-characters'
const origin = 'http://localhost:43829'
const scopes: ApiKeyScope[] = ['full', 'read', 'bookings']
const configIds = [undefined, '', 'bogus'] as const

function moduleUrl(source: string, location: URL, replacements: Record<string, string> = {}) {
  const javascript = stripTypeScriptTypes(source).replace(
    /from '([^']+)'/g,
    (_, specifier: string) => {
      const resolved =
        replacements[specifier] ??
        (specifier.startsWith('.')
          ? new URL(specifier, location).href
          : pathToFileURL(createRequire(location).resolve(specifier)).href)
      return `from '${resolved}'`
    },
  )
  return `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`
}

it('strictly parses persisted scopes and permits retained legacy properties', () => {
  for (const value of [
    null,
    '{}',
    'null',
    '[]',
    '{broken',
    '{"scope":null}',
    '{"scope":"READ"}',
    '{"scope":3}',
    '{"scope":"full","organizationId":"invalid"}',
  ]) {
    expect(parsePersistedApiKeyMetadata(value)).toBeNull()
  }
  expect(parsePersistedApiKeyMetadata('{"scope":"full","organizationId":null}')).toEqual({
    scope: 'full',
  })
  for (const scope of scopes)
    expect(parsePersistedApiKeyMetadata(JSON.stringify({ scope, retained: true }))).toEqual({
      scope,
    })
})

describe.skipIf(!serverUrl)('scoped API key storage and lifecycle', () => {
  let owned: TestDatabase
  let db: Db
  let authPool: ReturnType<typeof createAuthPool>
  let auth: Auth

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    authPool = createAuthPool(owned.url, signup)
    auth = createAuth({
      pool: authPool,
      db,
      baseURL: origin,
      secret,
      signup,
      mailer: { send: async () => {} },
    })
  })
  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  async function owner(verified = true) {
    const userId = randomUUID()
    const token = randomUUID()
    await owned.pool.query(
      'INSERT INTO auth."user" (id,name,email,"emailVerified") VALUES ($1,$2,$3,$4)',
      [userId, 'Synthetic scope owner', `${userId}@example.test`, verified],
    )
    await owned.pool.query(
      'INSERT INTO auth.session ("userId",token,"expiresAt","updatedAt") VALUES ($1,$2,$3,now())',
      [userId, token, new Date(Date.now() + 3_600_000)],
    )
    const organizationId = await ensurePersonalOrganization(db, userId)
    const signature = createHmac('sha256', secret).update(token).digest('base64')
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
    return { userId, organizationId, cookie }
  }
  async function http(
    path: string,
    cookie?: string,
    body?: unknown,
    authorization?: string,
    selectedAuth = auth,
  ) {
    const headers = new Headers({ origin })
    if (cookie) headers.set('cookie', cookie)
    if (authorization !== undefined) headers.set('authorization', authorization)
    if (body !== undefined) headers.set('content-type', 'application/json')
    return selectedAuth.handler(
      new Request(`${origin}/api/auth/api-key/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  async function create(userId: string, scope: ApiKeyScope = 'full') {
    return auth.api.createApiKey({ body: { userId, name: 'Synthetic key', metadata: { scope } } })
  }
  const metadata = async (id: string) =>
    (await owned.pool.query('SELECT metadata::jsonb FROM auth.apikey WHERE id=$1', [id])).rows[0]
      ?.metadata
  const resolve = (key: string, selectedAuth = auth) =>
    createCallerResolver({ auth: selectedAuth, db })(
      new Headers({ authorization: `Bearer ${key}` }),
    )

  it.each(scopes)(
    'creates %s atomically through HTTP and trusted APIs, lists and resolves it',
    async (scope) => {
      const user = await owner()
      const response = await http('create', user.cookie, {
        name: 'Synthetic HTTP key',
        metadata: { scope },
      })
      expect(response.status).toBe(200)
      const key = (await response.json()) as { id: string; key: string; metadata: unknown }
      expect(key.metadata).toEqual({ organizationId: user.organizationId, scope })
      expect(await metadata(key.id)).toEqual(key.metadata)
      expect(await resolve(key.key)).toMatchObject({
        ok: true,
        principal: {
          kind: 'api_key',
          apiKeyScope: scope,
          organization: { id: user.organizationId },
        },
      })
      const trusted = await create(user.userId, scope)
      expect(await metadata(trusted.id)).toEqual({ organizationId: user.organizationId, scope })
      const list = await http('list', user.cookie)
      expect(list.status).toBe(200)
      expect(JSON.stringify(await list.json()).includes(`"scope":"${scope}"`)).toBe(true)
    },
  )

  it('defaults omitted/null/empty metadata and omitted metadata.scope to full', async () => {
    const user = await owner()
    for (const body of [
      {},
      { metadata: null },
      { metadata: {} },
      { metadata: { organizationId: user.organizationId } },
    ]) {
      const response = await http('create', user.cookie, { name: 'Legacy client', ...body })
      expect(response.status).toBe(200)
      const key = (await response.json()) as { id: string }
      expect(await metadata(key.id)).toEqual({ organizationId: user.organizationId, scope: 'full' })
    }
  })

  it('rejects unsupported create metadata and top-level scope fields without creating keys', async () => {
    const user = await owner()
    for (const scope of [null, 'READ', 'unknown', [], {}, 3]) {
      const response = await http('create', user.cookie, {
        name: 'Invalid input',
        metadata: { scope },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_METADATA' })
    }
    for (const body of [
      { metadata: { scope: 'read', organizationId: null } },
      { metadata: { scope: 'read', organizationId: 3 } },
      { metadata: { scope: 'read', organizationId: [] } },
      { scope: 'read' },
      { scopes: ['read'] },
      { metadata: [] },
      { metadata: { scope: 'read', extra: true } },
      { metadata: JSON.parse('{"__proto__":{}}') },
    ]) {
      const response = await http('create', user.cookie, { name: 'Invalid input', ...body })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_METADATA' })
    }
    await expect(
      auth.api.createApiKey({
        body: {
          userId: user.userId,
          name: 'Invalid prototype',
          metadata: Object.create({ scope: 'read' }),
        },
      }),
    ).rejects.toMatchObject({ body: { code: 'INVALID_METADATA' } })
    expect(
      (await owned.pool.query('SELECT id FROM auth.apikey WHERE "referenceId"=$1', [user.userId]))
        .rowCount,
    ).toBe(0)
  })

  it.each(['read', 'bookings'] as const)(
    'preserves %s through null/empty metadata replacement, retargeting, disable and reenable',
    async (scope) => {
      const user = await owner()
      const key = await create(user.userId, scope)
      const teamId = randomUUID()
      await owned.pool.query(
        'INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ($1,$2,$3,now())',
        [teamId, 'Synthetic team', `team-${teamId}`],
      )
      await owned.pool.query(
        'INSERT INTO auth.member ("organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,now())',
        [teamId, user.userId, 'member'],
      )
      for (const replacement of [null, {}, { organizationId: teamId }]) {
        const response = await http('update', user.cookie, { keyId: key.id, metadata: replacement })
        expect(response.status).toBe(200)
        expect(await metadata(key.id)).toEqual({
          organizationId: replacement?.organizationId ?? user.organizationId,
          scope,
        })
      }
      await auth.api.updateApiKey({ body: { keyId: key.id, userId: user.userId, metadata: {} } })
      for (const enabled of [false, true]) {
        const response = await http('update', user.cookie, { keyId: key.id, enabled })
        expect(response.status).toBe(200)
        expect((await metadata(key.id)).scope).toBe(scope)
      }
      await expect(
        auth.api.updateApiKey({
          body: { keyId: key.id, userId: user.userId, metadata: { scope } },
        }),
      ).rejects.toMatchObject({ body: { code: 'API_KEY_SCOPE_IMMUTABLE' } })
      const forbiddenTeam = randomUUID()
      const response = await http('update', user.cookie, {
        keyId: key.id,
        metadata: { organizationId: forbiddenTeam },
      })
      expect(response.status).toBe(403)
      expect(await metadata(key.id)).toEqual({ organizationId: user.organizationId, scope })
    },
  )

  it('rejects explicit scope updates only for the native owner; foreign and absent keys retain identical native errors', async () => {
    const user = await owner()
    const foreign = await owner()
    const key = await create(user.userId, 'read')
    for (const value of ['read', 'full', null, []]) {
      const response = await http('update', user.cookie, {
        keyId: key.id,
        metadata: { scope: value },
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'API_KEY_SCOPE_IMMUTABLE' })
    }
    for (const keyId of [key.id, randomUUID()]) {
      const response = await http('update', foreign.cookie, { keyId, metadata: { scope: 'full' } })
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ code: 'KEY_NOT_FOUND' })
    }
    expect((await metadata(key.id)).scope).toBe('read')
  })

  it.each(configIds)('validates owned updates with configId %j', async (configId) => {
    const user = await owner()
    const foreign = await owner()
    const key = await create(user.userId, 'read')
    for (const [replacement, status, error] of [
      [{ scope: 'full' }, 400, { code: 'API_KEY_SCOPE_IMMUTABLE' }],
      [
        { organizationId: foreign.organizationId },
        403,
        { message: API_KEY_ORGANIZATION_MEMBERSHIP_MESSAGE },
      ],
      [{ extra: { arbitrary: true } }, 400, { code: 'INVALID_METADATA' }],
    ] as const) {
      const response = await http('update', user.cookie, {
        keyId: key.id,
        configId,
        metadata: replacement,
      })
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject(error)
      expect(await metadata(key.id)).toEqual({ organizationId: user.organizationId, scope: 'read' })
    }
    const valid = await http('update', user.cookie, { keyId: key.id, configId, metadata: {} })
    expect(valid.status).toBe(200)
    expect(await metadata(key.id)).toEqual({ organizationId: user.organizationId, scope: 'read' })
  })

  async function unverifiedReenable(configId: string | undefined, selectedAuth = auth) {
    const user = await owner(false)
    const keyId = randomUUID()
    await owned.pool.query(
      'INSERT INTO auth.apikey (id,"configId","referenceId",key,"createdAt","updatedAt",metadata,enabled) VALUES ($1,$2,$3,$4,now(),now(),$5,true)',
      [
        keyId,
        'default',
        user.userId,
        `synthetic-unverified-${keyId}`,
        JSON.stringify({ scope: 'read', organizationId: user.organizationId }),
      ],
    )
    expect(
      (
        await http(
          'update',
          user.cookie,
          { keyId, configId, enabled: false },
          undefined,
          selectedAuth,
        )
      ).status,
    ).toBe(200)
    const response = await http(
      'update',
      user.cookie,
      { keyId, configId, enabled: true },
      undefined,
      selectedAuth,
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'EMAIL_NOT_VERIFIED' })
    expect(
      (await owned.pool.query('SELECT enabled FROM auth.apikey WHERE id=$1', [keyId])).rows,
    ).toEqual([{ enabled: false }])
  }

  it.each(configIds)('requires email proof to reenable with configId %j', async (configId) => {
    await unverifiedReenable(configId)
  })

  it.each(configIds)(
    'requires the loaded session to remain live with configId %j',
    async (configId) => {
      const user = await owner()
      const key = await create(user.userId, 'read')
      expect((await http('update', user.cookie, { keyId: key.id, enabled: false })).status).toBe(
        200,
      )
      const selected = createAuth({
        pool: authPool,
        db,
        baseURL: origin,
        secret,
        signup,
        mailer: { send: async () => {} },
      })
      const before = beforeHook(db, async () => {})
      selected.options.hooks = {
        before: createAuthMiddleware(async (ctx) => {
          // Revoke after Better Auth loads the cookie, before Hourmere's live-session check.
          const session = await getSessionFromCtx(ctx)
          expect(session?.user.id).toBe(user.userId)
          await owned.pool.query('DELETE FROM auth.session WHERE id=$1', [session?.session.id])
          return before(ctx)
        }),
      }
      const response = await http(
        'update',
        user.cookie,
        { keyId: key.id, configId, enabled: true },
        undefined,
        selected,
      )
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED_SESSION' })
      expect(
        (await owned.pool.query('SELECT enabled FROM auth.apikey WHERE id=$1', [key.id])).rows,
      ).toEqual([{ enabled: false }])
    },
  )

  it.each(configIds)(
    'preserves native get/update/delete ownership failures with configId %j',
    async (configId) => {
      const user = await owner()
      const foreign = await owner()
      const key = await create(user.userId, 'read')
      const query = configId === undefined ? '' : `&configId=${encodeURIComponent(configId)}`
      for (const keyId of [key.id, randomUUID()]) {
        for (const path of ['get', 'update', 'delete']) {
          const response = await http(
            path === 'get' ? `get?id=${keyId}${query}` : path,
            foreign.cookie,
            path === 'get' ? undefined : { keyId, configId, metadata: { scope: 'full' } },
          )
          expect(response.status).toBe(404)
          expect(await response.json()).toEqual({
            code: 'KEY_NOT_FOUND',
            message: 'API Key not found',
          })
        }
      }
      const get = await http(`get?id=${key.id}${query}`, user.cookie)
      expect(get.status).toBe(200)
      expect(((await get.json()) as { metadata: unknown }).metadata).toEqual({
        organizationId: user.organizationId,
        scope: 'read',
      })
      expect((await http('delete', user.cookie, { keyId: key.id, configId })).status).toBe(200)
      expect(await metadata(key.id)).toBeUndefined()
    },
  )

  it.each(['', 'bogus'])(
    'detects a source-copy configId %j ownership-filter regression',
    async (configId) => {
      const location = new URL('./api-keys.ts', import.meta.url)
      const source = readFileSync(location, 'utf8')
      const mutant = source.replace(
        ".where('referenceId', '=', userId)",
        ".where('referenceId', '=', userId)\n          .where('configId', '=', typeof body.configId === 'string' ? body.configId : 'default')",
      )
      expect(mutant).not.toBe(source)
      const hookLocation = new URL('./hooks.ts', import.meta.url)
      const copy = await import(
        moduleUrl(readFileSync(hookLocation, 'utf8'), hookLocation, {
          './api-keys.ts': moduleUrl(mutant, location),
        })
      )
      const selected = createAuth({
        pool: authPool,
        db,
        baseURL: origin,
        secret,
        signup,
        mailer: { send: async () => {} },
      })
      selected.options.hooks = { before: copy.beforeHook(db, async () => {}) }
      await unverifiedReenable(configId)
      await expect(unverifiedReenable(configId, selected)).rejects.toMatchObject({
        name: 'AssertionError',
        actual: 200,
        expected: 403,
      })
      await unverifiedReenable(configId)
    },
  )

  it.each(['create', 'get', 'list', 'update', 'delete'])(
    'refuses all Authorization values on native %s with and without a valid cookie',
    async (path) => {
      const user = await owner()
      const key = await create(user.userId, 'full')
      for (const cookie of [undefined, user.cookie]) {
        for (const authorization of ['', 'Bearer invalid', `Bearer ${key.key}`]) {
          const response = await http(
            path === 'get' ? `get?id=${key.id}` : path,
            cookie,
            ['get', 'list'].includes(path) ? undefined : { keyId: key.id, name: 'Synthetic' },
            authorization,
          )
          expect(response.status).toBe(403)
          expect(await response.json()).toEqual({
            code: 'SESSION_REQUIRED',
            message: 'API key management requires a browser session without Authorization',
          })
        }
      }
    },
  )

  it('permits an unverified owner to disable a restricted key without changing scope', async () => {
    const user = await owner(false)
    const keyId = randomUUID()
    await owned.pool.query(
      'INSERT INTO auth.apikey (id,"configId","referenceId",key,"createdAt","updatedAt",metadata,enabled) VALUES ($1,$2,$3,$4,now(),now(),$5,true)',
      [
        keyId,
        'default',
        user.userId,
        'synthetic-unverified-key',
        JSON.stringify({ scope: 'read', organizationId: user.organizationId }),
      ],
    )
    const response = await http('update', user.cookie, { keyId, enabled: false })
    expect(response.status).toBe(200)
    expect((await metadata(keyId)).scope).toBe('read')
    const reenable = await http('update', user.cookie, { keyId, enabled: true })
    expect(reenable.status).toBe(403)
  })

  it('does not trust stale plugin metadata or missing persisted scopes, even with a valid browser cookie', async () => {
    const user = await owner()
    const key = await create(user.userId, 'read')
    const staleResult = await auth.api.verifyApiKey({ body: { key: key.key } })
    const staleAuth = {
      ...auth,
      api: { ...auth.api, verifyApiKey: async () => staleResult },
    } as unknown as Auth
    expect(await resolve(key.key, staleAuth)).toMatchObject({
      ok: true,
      principal: { apiKeyScope: 'read' },
    })
    // Corruption is confined to this test's owned database; production writers cannot do this.
    await owned.pool.query('ALTER TABLE auth.apikey DISABLE TRIGGER api_key_scope_guard')
    try {
      for (const corrupt of ['{}', '{"scope":null}', '{"scope":"unknown"}', '[]', '{broken']) {
        await owned.pool.query('UPDATE auth.apikey SET metadata=$1 WHERE id=$2', [corrupt, key.id])
        const result = await createCallerResolver({ auth: staleAuth, db })(
          new Headers({ authorization: `Bearer ${key.key}`, cookie: user.cookie }),
        )
        expect(result).toMatchObject({ ok: false, error: 'unauthorized' })
      }
      await owned.pool.query('UPDATE auth.apikey SET metadata=$1 WHERE id=$2', [
        JSON.stringify({ organizationId: user.organizationId, scope: 'read' }),
        key.id,
      ])
    } finally {
      await owned.pool.query('ALTER TABLE auth.apikey ENABLE TRIGGER api_key_scope_guard')
    }
    for (const patch of ['enabled=false,"expiresAt"=null', 'enabled=true,"expiresAt"=now()']) {
      await owned.pool.query(`UPDATE auth.apikey SET ${patch} WHERE id=$1`, [key.id])
      expect(await resolve(key.key, staleAuth)).toMatchObject({ ok: false, error: 'unauthorized' })
    }
    await owned.pool.query('DELETE FROM auth.apikey WHERE id=$1', [key.id])
    expect(await resolve(key.key, staleAuth)).toMatchObject({ ok: false, error: 'unauthorized' })
  })

  it('uses fresh persisted organization and membership and checks restricted scope inside write transactions', async () => {
    const user = await owner()
    const key = await create(user.userId, 'bookings')
    const resolved = await resolve(key.key)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok || resolved.principal.kind !== 'api_key') throw new Error('Expected API key')
    const principal = resolved.principal
    await expect(requireActiveApiKey(db, principal, Date.now())).resolves.toBeUndefined()
    await expect(
      requireActiveApiKey(db, { ...principal, apiKeyScope: 'full' }, Date.now()),
    ).rejects.toMatchObject({ name: 'InvalidApiKeyError' })
    const teamId = randomUUID()
    await owned.pool.query(
      'INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ($1,$2,$3,now())',
      [teamId, 'Synthetic team', `team-${teamId}`],
    )
    await owned.pool.query(
      'INSERT INTO auth.member ("organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,now())',
      [teamId, user.userId, 'member'],
    )
    const staleResult = await auth.api.verifyApiKey({ body: { key: key.key } })
    const staleAuth = {
      ...auth,
      api: { ...auth.api, verifyApiKey: async () => staleResult },
    } as unknown as Auth
    await auth.api.updateApiKey({
      body: { keyId: key.id, userId: user.userId, metadata: { organizationId: teamId } },
    })
    expect(await resolve(key.key, staleAuth)).toMatchObject({
      ok: true,
      principal: { organization: { id: teamId }, apiKeyScope: 'bookings' },
    })
    await expect(requireActiveApiKey(db, principal, Date.now())).rejects.toMatchObject({
      name: 'InvalidApiKeyError',
    })
    await owned.pool.query('DELETE FROM auth.member WHERE "organizationId"=$1 AND "userId"=$2', [
      teamId,
      user.userId,
    ])
    expect(await resolve(key.key, staleAuth)).toMatchObject({ ok: false, error: 'unauthorized' })
  })
  it('retains personal fallback when persisted organization metadata is absent', async () => {
    const user = await owner()
    const key = await create(user.userId, 'read')
    for (const legacy of [
      { scope: 'read', retained: true },
      { scope: 'read', organizationId: null },
      { scope: 'read', organizationId: 3 },
      { scope: 'read', organizationId: [] },
    ]) {
      await owned.pool.query('UPDATE auth.apikey SET metadata=$1 WHERE id=$2', [
        JSON.stringify(legacy),
        key.id,
      ])
      expect(await resolve(key.key)).toMatchObject({
        ok: true,
        principal: { apiKeyScope: 'read', organization: { id: user.organizationId } },
      })
    }
  })

  it.each(scopes)(
    'checks fresh enabled, expiry, owner and revocation for %s despite stale verification',
    async (scope) => {
      const user = await owner()
      const key = await create(user.userId, scope)
      const staleResult = await auth.api.verifyApiKey({ body: { key: key.key } })
      const staleAuth = {
        ...auth,
        api: { ...auth.api, verifyApiKey: async () => staleResult },
      } as unknown as Auth
      for (const patch of [
        'enabled=false',
        '"expiresAt"=now()',
        `"expiresAt"=now()-interval '1 day'`,
        `"referenceId"='${randomUUID()}'`,
      ]) {
        await owned.pool.query(`UPDATE auth.apikey SET ${patch} WHERE id=$1`, [key.id])
        expect(await resolve(key.key, staleAuth)).toMatchObject({
          ok: false,
          error: 'unauthorized',
        })
        await owned.pool.query(
          'UPDATE auth.apikey SET enabled=true,"expiresAt"=null,"referenceId"=$1 WHERE id=$2',
          [user.userId, key.id],
        )
      }
      await owned.pool.query('DELETE FROM auth.apikey WHERE id=$1', [key.id])
      expect(await resolve(key.key, staleAuth)).toMatchObject({ ok: false, error: 'unauthorized' })
    },
  )

  it('allows cookie-only native get/delete and rejects invalid credentials without cookie fallback', async () => {
    const user = await owner()
    const key = await create(user.userId, 'bookings')
    const get = await http(`get?id=${key.id}`, user.cookie)
    expect(get.status).toBe(200)
    expect(((await get.json()) as { metadata: unknown }).metadata).toEqual({
      scope: 'bookings',
      organizationId: user.organizationId,
    })
    const resolver = createCallerResolver({ auth, db })
    expect(
      await resolver(new Headers({ authorization: 'Bearer invalid', cookie: user.cookie })),
    ).toMatchObject({ ok: false, error: 'unauthorized' })
    expect(await resolver(new Headers({ 'x-api-key': key.key }))).toMatchObject({
      ok: false,
      error: 'unauthorized',
    })
    expect((await http('delete', user.cookie, { keyId: key.id })).status).toBe(200)
    expect(await resolve(key.key)).toMatchObject({ ok: false, error: 'unauthorized' })
  })

  it.each([
    'create canonicalization',
    'update preservation',
    'scope update rejection',
    'native Authorization',
    'top-level scope',
  ] as const)(
    'detects the source-copy %s mutation with a real HTTP/trusted assertion',
    async (protection) => {
      const location = new URL('./api-keys.ts', import.meta.url)
      const source = readFileSync(location, 'utf8')
      let mutant = source
      if (protection === 'create canonicalization')
        mutant = source.replace("(metadata.scope ?? 'full')", "'full'")
      if (protection === 'update preservation')
        mutant = source.replace(
          'parsePersistedApiKeyMetadata(owned?.metadata ?? null)?.scope',
          "'full'",
        )
      if (protection === 'scope update rejection')
        mutant = source.replace(
          "if (!creating && isRecord(body.metadata) && Object.hasOwn(body.metadata, 'scope'))",
          'if (false)',
        )
      if (protection === 'native Authorization')
        mutant = source.replace("ctx.request?.headers.has('authorization')", 'false')
      if (protection === 'top-level scope')
        mutant = source.replace(
          "if ('scope' in body || 'scopes' in body) throw invalidMetadata()",
          '',
        )
      expect(mutant).not.toBe(source)
      const hookLocation = new URL('./hooks.ts', import.meta.url)
      const hookCopy = await import(
        moduleUrl(readFileSync(hookLocation, 'utf8'), hookLocation, {
          './api-keys.ts': moduleUrl(mutant, location),
        })
      )
      const selected = createAuth({
        pool: authPool,
        db,
        baseURL: origin,
        secret,
        signup,
        mailer: { send: async () => {} },
      })
      selected.options.hooks = { before: hookCopy.beforeHook(db, async () => {}) }
      const user = await owner()
      const key = await create(user.userId, 'read')
      const assertion = async (selectedAuth: Auth) => {
        if (protection === 'create canonicalization') {
          const response = await http(
            'create',
            user.cookie,
            { name: 'Scoped', metadata: { scope: 'read' } },
            undefined,
            selectedAuth,
          )
          expect(response.status).toBe(200)
          expect(((await response.json()) as { metadata: { scope: string } }).metadata.scope).toBe(
            'read',
          )
        } else if (protection === 'update preservation') {
          expect(
            (
              await http(
                'update',
                user.cookie,
                { keyId: key.id, metadata: {} },
                undefined,
                selectedAuth,
              )
            ).status,
          ).toBe(200)
          expect((await metadata(key.id)).scope).toBe('read')
        } else if (protection === 'scope update rejection') {
          const response = await http(
            'update',
            user.cookie,
            { keyId: key.id, metadata: { scope: 'read' } },
            undefined,
            selectedAuth,
          )
          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({ code: 'API_KEY_SCOPE_IMMUTABLE' })
        } else if (protection === 'native Authorization') {
          expect(
            (await http('list', user.cookie, undefined, `Bearer ${key.key}`, selectedAuth)).status,
          ).toBe(403)
        } else {
          const response = await http(
            'create',
            user.cookie,
            { name: 'Unsupported scope', scope: 'read' },
            undefined,
            selectedAuth,
          )
          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({ code: 'INVALID_METADATA' })
        }
      }
      await assertion(auth)
      await expect(assertion(selected)).rejects.toMatchObject({ name: 'AssertionError' })
      await assertion(auth)
    },
  )

  it('detects runtime missing-scope fallback and active-write scope bypass source-copy mutations', async () => {
    const user = await owner()
    const key = await create(user.userId, 'read')
    const result = await resolve(key.key)
    if (!result.ok || result.principal.kind !== 'api_key') throw new Error('Expected API key')
    const location = new URL('./api-key-principal.ts', import.meta.url)
    const source = readFileSync(location, 'utf8')
    const mutant = source.replace(
      '!metadata || metadata.scope !== principal.apiKeyScope',
      '!metadata',
    )
    expect(mutant).not.toBe(source)
    const copied = await import(moduleUrl(mutant, location))
    const assertion = async (guard: typeof requireActiveApiKey) => {
      await expect(
        guard(
          db,
          { ...result.principal, kind: 'api_key', apiKeyId: key.id, apiKeyScope: 'full' },
          Date.now(),
        ),
      ).rejects.toMatchObject({ name: 'InvalidApiKeyError' })
    }
    await assertion(requireActiveApiKey)
    await expect(assertion(copied.requireActiveApiKey)).rejects.toMatchObject({
      name: 'AssertionError',
    })
    await assertion(requireActiveApiKey)

    const parserLocation = new URL('./api-key-metadata.ts', import.meta.url)
    const parserSource = readFileSync(parserLocation, 'utf8')
    const parserMutant = parserSource.replace(
      'if (!isApiKeyScope(record.scope)) return null',
      "if (record.scope === undefined) record.scope = 'full'\n  if (!isApiKeyScope(record.scope)) return null",
    )
    expect(parserMutant).not.toBe(parserSource)
    const callerLocation = new URL('./caller.ts', import.meta.url)
    const callerCopy = await import(
      moduleUrl(readFileSync(callerLocation, 'utf8'), callerLocation, {
        './api-key-metadata.ts': moduleUrl(parserMutant, parserLocation),
      })
    )
    const staleResult = await auth.api.verifyApiKey({ body: { key: key.key } })
    const staleAuth = {
      ...auth,
      api: { ...auth.api, verifyApiKey: async () => staleResult },
    } as unknown as Auth
    await owned.pool.query('ALTER TABLE auth.apikey DISABLE TRIGGER api_key_scope_guard')
    try {
      await owned.pool.query('UPDATE auth.apikey SET metadata=$1 WHERE id=$2', [
        JSON.stringify({ organizationId: user.organizationId }),
        key.id,
      ])
      const check = async (factory: typeof createCallerResolver) =>
        expect(
          await factory({ auth: staleAuth, db })(
            new Headers({ authorization: `Bearer ${key.key}` }),
          ),
        ).toMatchObject({ ok: false, error: 'unauthorized' })
      await check(createCallerResolver)
      await expect(check(callerCopy.createCallerResolver)).rejects.toMatchObject({
        name: 'AssertionError',
      })
      await check(createCallerResolver)
      await owned.pool.query('UPDATE auth.apikey SET metadata=$1 WHERE id=$2', [
        JSON.stringify({ scope: 'read', organizationId: user.organizationId }),
        key.id,
      ])
    } finally {
      await owned.pool.query('ALTER TABLE auth.apikey ENABLE TRIGGER api_key_scope_guard')
    }
  })
  it.each(['enabled', 'expiry', 'membership'] as const)(
    'detects a source-copy fresh %s credential-check mutation',
    async (protection) => {
      const user = await owner()
      const key = await create(user.userId, 'read')
      const staleResult = await auth.api.verifyApiKey({ body: { key: key.key } })
      const staleAuth = {
        ...auth,
        api: { ...auth.api, verifyApiKey: async () => staleResult },
      } as unknown as Auth
      const location = new URL('./caller.ts', import.meta.url)
      const source = readFileSync(location, 'utf8')
      let mutant = source
      if (protection === 'enabled') {
        mutant = source.replace('.where(sql<boolean>`k.enabled IS DISTINCT FROM false`)', '')
        await owned.pool.query('UPDATE auth.apikey SET enabled=false WHERE id=$1', [key.id])
      } else if (protection === 'expiry') {
        mutant = source.replace(
          '(row.apiKeyExpiresAt !== null && row.apiKeyExpiresAt.getTime() <= Date.now())',
          'false',
        )
        await owned.pool.query('UPDATE auth.apikey SET "expiresAt"=now() WHERE id=$1', [key.id])
      } else {
        const teamId = randomUUID()
        await owned.pool.query(
          'INSERT INTO auth.organization (id,name,slug,"createdAt") VALUES ($1,$2,$3,now())',
          [teamId, 'Synthetic team', `team-${teamId}`],
        )
        await owned.pool.query('UPDATE auth.apikey SET metadata=$1 WHERE id=$2', [
          JSON.stringify({ scope: 'read', organizationId: teamId }),
          key.id,
        ])
        mutant = source.replace(".where('m.organizationId', '=', organizationId)", '')
      }
      expect(mutant).not.toBe(source)
      const copy = await import(moduleUrl(mutant, location))
      const assertion = async (factory: typeof createCallerResolver) =>
        expect(
          await factory({ auth: staleAuth, db })(
            new Headers({ authorization: `Bearer ${key.key}` }),
          ),
        ).toMatchObject({ ok: false, error: 'unauthorized' })
      await assertion(createCallerResolver)
      await expect(assertion(copy.createCallerResolver)).rejects.toMatchObject({
        name: 'AssertionError',
      })
      await assertion(createCallerResolver)
    },
  )
})
