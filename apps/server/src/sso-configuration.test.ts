import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { encryptCredential } from '@hourmere/calendars'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as configuration from './sso-configuration.ts'

type Module = typeof configuration

const key = randomBytes(32)
const plaintext = JSON.stringify({
  issuer: 'https://login.example.test/tenant/v2.0',
  clientSecret: 'synthetic-client-secret-never-logged',
})

/** A copy of the module with one source edit, to show the binding checks catch it. */
async function sourceCopy(mutation: [string, string]): Promise<Module> {
  const location = new URL('./sso-configuration.ts', import.meta.url)
  const source = readFileSync(location, 'utf8')
  expect(source.split(mutation[0])).toHaveLength(2)
  const javascript = stripTypeScriptTypes(source.replace(...mutation)).replace(
    /((?:from|import)\s*)'([^']+)'/g,
    (_, prefix: string, specifier: string) => `${prefix}'${import.meta.resolve(specifier)}'`,
  )
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)
}

/** Ciphertext opens only for its own organization, provider, revision and purpose. */
function expectBound(module: Module) {
  const at = { organizationId: randomUUID(), providerId: randomUUID(), revision: 4 }
  const sealed = module.sealSsoProviderConfiguration(key, at, plaintext)
  expect(module.openSsoProviderConfiguration(key, at, sealed)).toBe(plaintext)
  // The database reads UUIDs in lowercase; the same IDs in uppercase are the same revision.
  expect(
    module.openSsoProviderConfiguration(
      key,
      { ...at, organizationId: at.organizationId.toUpperCase() },
      sealed,
    ),
  ).toBe(plaintext)
  // Another SSO purpose (a later SP signing key) for the same revision never opens as this.
  const otherPurpose = encryptCredential(
    key,
    JSON.stringify([
      'hourmere-sso-v1',
      'sp-private-key',
      at.organizationId,
      at.providerId,
      at.revision,
    ]),
    plaintext,
  )
  expect(() => module.openSsoProviderConfiguration(key, at, otherPurpose)).toThrow(
    'SSO provider configuration could not be decrypted',
  )
  for (const moved of [
    { ...at, organizationId: randomUUID() },
    { ...at, providerId: randomUUID() },
    { ...at, revision: 5 },
    { ...at, revision: 3 },
    { organizationId: at.providerId, providerId: at.organizationId, revision: 4 },
  ])
    expect(() => module.openSsoProviderConfiguration(key, moved, sealed)).toThrow(
      'SSO provider configuration could not be decrypted',
    )
}

describe('SSO provider configuration encryption', () => {
  it('opens only for the organization, provider and revision it was sealed for', () => {
    expectBound(configuration)
  })

  it('uses the credential envelope and keeps secrets out of errors', () => {
    const at = { organizationId: randomUUID(), providerId: randomUUID(), revision: 1 }
    const sealed = configuration.sealSsoProviderConfiguration(key, at, plaintext)
    // Version 1, a 96-bit IV and a 128-bit tag, as the database's envelope check requires.
    expect(sealed[0]).toBe(1)
    expect(sealed.length).toBe(1 + 12 + 16 + Buffer.byteLength(plaintext))
    expect(sealed.includes(Buffer.from('synthetic-client-secret'))).toBe(false)
    // A new seal of the same revision never repeats the ciphertext.
    expect(configuration.sealSsoProviderConfiguration(key, at, plaintext).equals(sealed)).toBe(
      false,
    )
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1] = (tampered.at(-1) as number) ^ 1
    const otherPurpose = encryptCredential(key, JSON.stringify(['hourmere-other', at]), plaintext)
    for (const [usedKey, value] of [
      [key, tampered],
      [randomBytes(32), sealed],
      [key, otherPurpose],
      [key, sealed.subarray(0, 29)],
    ] as const) {
      let error: unknown
      try {
        configuration.openSsoProviderConfiguration(usedKey, at, value)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('SSO provider configuration could not be decrypted')
      expect((error as Error).cause).toBeUndefined()
      expect(String((error as Error).stack)).not.toContain('synthetic-client-secret')
    }
    for (const revision of [0, -1, 1.5, Number.NaN, 2 ** 53])
      expect(() => configuration.ssoProviderConfigurationAad({ ...at, revision })).toThrow(
        'SSO provider revision must be a positive integer',
      )
  })

  it.each([
    ['organization', '    organizationId.toLowerCase(),\n', ''],
    ['provider', '    providerId.toLowerCase(),\n', ''],
    ['revision', '    revision,\n  ])', '  ])'],
    ['purpose', "'provider-configuration',", "'sp-private-key',"],
  ])('detects authenticated data without its own %s', async (_, search, replacement) => {
    const mutant = await sourceCopy([search, replacement])
    expect(() => expectBound(mutant)).toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
})

const serverUrl = process.env.DATABASE_URL
describe.skipIf(!serverUrl)('SSO provider configuration storage', () => {
  let owned: TestDatabase
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'sso_sealed' })
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('fails to open ciphertext moved to another organization, provider or revision', async () => {
    const pool = owned.pool
    const [team, otherTeam] = (
      await pool.query<{ id: string }>(
        `INSERT INTO auth.organization (name,slug,"createdAt")
        VALUES ('Sealed team',$1,now()),('Other sealed team',$2,now()) RETURNING id`,
        [`sealed-${randomUUID()}`, `sealed-${randomUUID()}`],
      )
    ).rows.map(({ id }) => id) as [string, string]
    const insertProvider = async (organizationId: string) => {
      const providerId = randomUUID()
      await pool.query(
        `INSERT INTO sso_providers (id,organization_id,protocol,display_name,issuer,client_id,configuration)
        VALUES ($1,$2,'oidc','Synthetic IdP',$4,'client',$3)`,
        [
          providerId,
          organizationId,
          configuration.sealSsoProviderConfiguration(
            key,
            { organizationId, providerId, revision: 1 },
            plaintext,
          ),
          `https://login.example.test/${providerId}`,
        ],
      )
      return providerId
    }
    const source = await insertProvider(team)
    const sameTeam = await insertProvider(team)
    const otherTeamProvider = await insertProvider(otherTeam)
    // Reading a row always opens it with that row's own organization, provider and revision.
    const read = async (id: string) => {
      const row = (
        await pool.query<{
          organization_id: string
          id: string
          revision: number
          configuration: Buffer
        }>('SELECT organization_id,id,revision,configuration FROM sso_providers WHERE id=$1', [id])
      ).rows[0]
      if (!row) throw new Error('missing provider')
      return () =>
        configuration.openSsoProviderConfiguration(
          key,
          { organizationId: row.organization_id, providerId: row.id, revision: row.revision },
          row.configuration,
        )
    }
    expect((await read(source))()).toBe(plaintext)
    const original = (
      await pool.query<{ configuration: Buffer }>(
        'SELECT configuration FROM sso_providers WHERE id=$1',
        [source],
      )
    ).rows[0]?.configuration as Buffer
    // Another provider of the same team, and a provider of another team.
    for (const target of [sameTeam, otherTeamProvider]) {
      await pool.query('UPDATE sso_providers SET configuration=$1, revision=2 WHERE id=$2', [
        original,
        target,
      ])
      expect(await read(target)).toThrow('SSO provider configuration could not be decrypted')
    }
    // The database refuses a new revision that keeps the old ciphertext ...
    await expect(
      pool.query('UPDATE sso_providers SET revision=2 WHERE id=$1', [source]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'sso_providers_revision_sealed' })
    // ... and a revision-1 ciphertext replayed into a later revision does not open.
    await pool.query('UPDATE sso_providers SET configuration=$1, revision=2 WHERE id=$2', [
      configuration.sealSsoProviderConfiguration(
        key,
        { organizationId: team, providerId: source, revision: 2 },
        plaintext,
      ),
      source,
    ])
    expect((await read(source))()).toBe(plaintext)
    await pool.query('UPDATE sso_providers SET configuration=$1, revision=3 WHERE id=$2', [
      original,
      source,
    ])
    expect(await read(source)).toThrow('SSO provider configuration could not be decrypted')
    // Plaintext configuration is refused outright.
    await expect(
      pool.query('UPDATE sso_providers SET configuration=$1, revision=4 WHERE id=$2', [
        Buffer.from(plaintext),
        source,
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'sso_providers_configuration_envelope' })
    expect(pool.totalCount).toBeLessThanOrEqual(2)
  })
})
