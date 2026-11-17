import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { crc32 } from 'node:zlib'
import { brandContrast } from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { auditActor, writeAuditEvent } from '@hourmere/db/audit'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { sql } from 'kysely'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  BRAND_LOGO_MAX_BYTES,
  BRAND_LOGO_OUTPUT_MAX_BYTES,
  getBranding,
  getBrandLogo,
  getEmailBranding,
  getPublicBranding,
  getPublicBrandLogo,
  normalizeBrandLogo,
  setBranding,
  uploadBrandLogo,
} from './branding.ts'
import { DomainError } from './errors.ts'
import { createTestTeam, createTestUser, testContext } from './testing.ts'

const png = () =>
  sharp({ create: { width: 4, height: 4, channels: 3, background: '#abcdef' } })
    .png()
    .toBuffer()
describe('logo normalization', () => {
  it('rejects oversize, SVG, magic confusion, malformed and excessive dimensions', async () => {
    for (const [data, type] of [
      [Buffer.alloc(BRAND_LOGO_MAX_BYTES + 1), 'image/png'],
      [Buffer.from('<svg/>'), 'image/svg+xml'],
      [await png(), 'image/jpeg'],
      [Buffer.from('not an image'), 'image/png'],
      [
        await sharp({ create: { width: 2049, height: 1, channels: 3, background: 'white' } })
          .png()
          .toBuffer(),
        'image/png',
      ],
      [
        await sharp({ create: { width: 1, height: 2049, channels: 3, background: 'white' } })
          .png()
          .toBuffer(),
        'image/png',
      ],
    ] as const)
      await expect(normalizeBrandLogo(data, type)).rejects.toMatchObject({ kind: 'invalid' })
  })
  it('rejects APNG even when the decoder reports no page count', async () => {
    const a = await png(),
      b = await sharp(a).negate().png().toBuffer()
    const parts = (data: Buffer) => {
      const result: { type: string; data: Buffer }[] = []
      for (let i = 8; i + 12 <= data.length; ) {
        const length = data.readUInt32BE(i)
        result.push({
          type: data.toString('ascii', i + 4, i + 8),
          data: data.subarray(i + 8, i + 8 + length),
        })
        i += length + 12
      }
      return result
    }
    const chunk = (type: string, data: Buffer) => {
      const size = Buffer.alloc(4),
        crc = Buffer.alloc(4),
        body = Buffer.concat([Buffer.from(type), data])
      size.writeUInt32BE(data.length)
      crc.writeUInt32BE(crc32(body))
      return Buffer.concat([size, body, crc])
    }
    const control = Buffer.alloc(8)
    control.writeUInt32BE(2)
    const frame = (seq: number) => {
      const data = Buffer.alloc(26)
      data.writeUInt32BE(seq)
      data.writeUInt32BE(4, 4)
      data.writeUInt32BE(4, 8)
      data.writeUInt16BE(1, 20)
      data.writeUInt16BE(10, 22)
      return chunk('fcTL', data)
    }
    const sequence = Buffer.alloc(4)
    sequence.writeUInt32BE(2)
    const chunks = parts(a)
    const animated = Buffer.concat([
      a.subarray(0, 8),
      chunk('IHDR', chunks[0]?.data as Buffer),
      chunk('acTL', control),
      frame(0),
      ...chunks.filter((c) => c.type === 'IDAT').map((c) => chunk(c.type, c.data)),
      frame(1),
      chunk(
        'fdAT',
        Buffer.concat([
          sequence,
          ...parts(b)
            .filter((c) => c.type === 'IDAT')
            .map((c) => c.data),
        ]),
      ),
      chunk('IEND', Buffer.alloc(0)),
    ])
    expect((await sharp(animated).metadata()).pages).toBeUndefined()
    const verify = async (m: ReturnType<typeof serviceCopy>) => {
      await expect(m.normalizeBrandLogo(animated, 'image/png')).rejects.toMatchObject({
        code: 'invalid_brand_logo',
      })
    }
    await verify(serviceCopy())
    await expect(
      verify(serviceCopy(["if (chunk === 'acTL') throw invalidLogo()", '// removed APNG guard'])),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(serviceCopy())
  })
  it('rejects animated WebP and reduces noisy input to the output byte budget', async () => {
    const animated = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
      raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer()
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2)
    const compressed = await sharp(randomBytes(512 * 512 * 3), {
      raw: { width: 512, height: 512, channels: 3 },
    })
      .jpeg({ quality: 80 })
      .toBuffer()
    expect(compressed.length).toBeLessThan(BRAND_LOGO_MAX_BYTES)
    await expect(normalizeBrandLogo(animated, 'image/webp')).rejects.toMatchObject({
      code: 'invalid_brand_logo',
    })
    const verify = async (m: ReturnType<typeof serviceCopy>) => {
      const normalized = await m.normalizeBrandLogo(compressed, 'image/jpeg')
      expect(normalized.length).toBeLessThanOrEqual(BRAND_LOGO_OUTPUT_MAX_BYTES)
    }
    await verify(serviceCopy())
    await expect(
      verify(
        serviceCopy([
          'if (normalized.length <= BRAND_LOGO_OUTPUT_MAX_BYTES) return normalized',
          'return normalized',
        ]),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(serviceCopy())
  })
  it('bounds the longest side without enlarging small uploads', async () => {
    for (const [width, height, expectedWidth, expectedHeight] of [
      [1800, 900, 512, 256],
      [4, 2, 4, 2],
    ]) {
      const bytes = await sharp({
        create: {
          width: width as number,
          height: height as number,
          channels: 4,
          background: '#aabbcc80',
        },
      })
        .png()
        .toBuffer()
      const result = await normalizeBrandLogo(bytes, 'image/png')
      expect(result.length).toBeLessThanOrEqual(BRAND_LOGO_OUTPUT_MAX_BYTES)
      expect(await sharp(result).metadata()).toMatchObject({
        format: 'png',
        width: expectedWidth,
        height: expectedHeight,
        hasAlpha: true,
      })
    }
  })
  it('strips appended polyglot content and metadata from decoded pixels', async () => {
    const image = await png()
    const result = await normalizeBrandLogo(
      Buffer.concat([image, Buffer.from('<script>alert(1)</script>')]),
      'image/png',
    )
    expect(result.includes(Buffer.from('<script>'))).toBe(false)
    expect(await sharp(result).metadata()).toMatchObject({ format: 'png', width: 4, height: 4 })
    for (const format of ['jpeg', 'webp'] as const) {
      const bytes = await sharp(image)[format]().toBuffer()
      expect(
        (await sharp(await normalizeBrandLogo(bytes, `image/${format}`)).metadata()).format,
      ).toBe('png')
    }
  })
})
describe.skipIf(!process.env.DATABASE_URL)('organization branding', () => {
  let database: TestDatabase
  let db: Db
  beforeAll(async () => {
    database = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(database.pool)
  })
  afterAll(async () => {
    await database?.drop()
  })
  it('allows personal owners and team owners/admins; refuses members and stale or foreign principals', async () => {
    const owner = await createTestUser(db),
      admin = await createTestUser(db),
      member = await createTestUser(db),
      outsider = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    for (const principal of [owner.principal, team.as(owner), team.as(admin)])
      expect(
        (await setBranding(testContext(db, principal), { brandPrimaryColor: '#aabbcc' }))
          .brandPrimaryColor,
      ).toBe('#AABBCC')
    for (const principal of [
      team.as(member),
      team.as(outsider),
      { ...outsider.principal, organization: owner.principal.organization },
    ]) {
      await expect(getBranding(testContext(db, principal))).rejects.toMatchObject({
        code: 'insufficient_role',
      })
      await expect(setBranding(testContext(db, principal), {})).rejects.toMatchObject({
        code: 'insufficient_role',
      })
      await expect(
        uploadBrandLogo(testContext(db, principal), await png(), 'image/png'),
      ).rejects.toMatchObject({ code: 'insufficient_role' })
    }
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    await expect(setBranding(testContext(db, team.as(admin)), {})).rejects.toMatchObject({
      code: 'insufficient_role',
    })
  })
  it('refuses members and demoted admins reading an existing logo and kills the role bypass', async () => {
    const owner = await createTestUser(db),
      admin = await createTestUser(db),
      member = await createTestUser(db)
    const team = await createTestTeam(db, [
      { user: owner, role: 'owner' },
      { user: admin, role: 'admin' },
      { user: member, role: 'member' },
    ])
    const logo = await uploadBrandLogo(testContext(db, team.as(owner)), await png(), 'image/png')
    const hash = logo.brandLogo as string
    expect(await getBrandLogo(testContext(db, team.as(admin)), hash)).toBeInstanceOf(Buffer)
    await db
      .updateTable('auth.member')
      .set({ role: 'member' })
      .where('organizationId', '=', team.id)
      .where('userId', '=', admin.id)
      .execute()
    for (const user of [member, admin]) {
      const verify = async (module: ReturnType<typeof serviceCopy>) => {
        await expect(
          module.getBrandLogo(testContext(db, team.as(user)), hash),
        ).rejects.toMatchObject({ code: 'insufficient_role' })
      }
      await verify(serviceCopy())
      await expect(
        verify(
          serviceCopy([
            'export async function getBrandLogo(ctx: ServiceContext, hash: string) {\n  await authorize(ctx.db, ctx)',
            'export async function getBrandLogo(ctx: ServiceContext, hash: string) {',
          ]),
        ),
      ).rejects.toMatchObject({ name: 'AssertionError' })
      await verify(serviceCopy())
    }
  })
  it.each(['api_key', 'oauth'] as const)(
    'refuses a %s member without requesting the organization lock and kills the pre-check bypass',
    async (kind) => {
      const member = await createTestUser(db)
      const team = await createTestTeam(db, [{ user: member, role: 'member' }])
      const principal = team.as(member)
      const ctx = testContext(
        db,
        kind === 'api_key'
          ? principal
          : {
              user: principal.user,
              organization: principal.organization,
              kind: 'oauth',
              oauthConsentId: 'test-consent',
              clientId: 'test-client',
              scopes: ['full'],
            },
      )
      const verify = async (module: ReturnType<typeof serviceCopy>) => {
        const holder = await database.pool.connect()
        let pending: Promise<unknown> | undefined
        let outcome: unknown
        try {
          await holder.query('BEGIN')
          // Booking FK checks hold KEY SHARE: an unauthorized FOR UPDATE must never wait here.
          await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR KEY SHARE', [
            team.id,
          ])
          const {
            rows: [backend],
          } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          pending = module.setBranding(ctx, { brandPrimaryColor: '#112233' }).then(
            (value) => {
              outcome = value
            },
            (error: unknown) => {
              outcome = error
            },
          )
          let blocked: number[] = []
          await vi.waitFor(
            async () => {
              const { rows } = await database.pool.query<{ pid: number }>(
                `SELECT DISTINCT pid FROM pg_locks
               WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))`,
                [backend?.pid],
              )
              blocked = rows.map((row) => row.pid)
              expect(outcome !== undefined || blocked.length > 0).toBe(true)
            },
            { timeout: 3000, interval: 10 },
          )
          expect(blocked).toEqual([])
          expect(outcome).toMatchObject({ code: 'insufficient_role' })
        } finally {
          await holder.query('ROLLBACK')
          holder.release()
          await pending
        }
      }
      await verify(serviceCopy())
      await expect(
        verify(serviceCopy(['      await authorize(trx, ctx)', '      void 0'])),
      ).rejects.toMatchObject({ name: 'AssertionError' })
      await verify(serviceCopy())
    },
  )
  it('rechecks demotion after waiting for the organization lock and kills its bypass', async () => {
    const owner = await createTestUser(db)
    const team = await createTestTeam(db, [{ user: owner, role: 'admin' }])
    const ctx = testContext(db, team.as(owner))
    const verify = async (module: ReturnType<typeof serviceCopy>) => {
      await db
        .updateTable('auth.member')
        .set({ role: 'admin' })
        .where('organizationId', '=', team.id)
        .execute()
      await expect(
        module.setBranding(
          {
            ...ctx,
            authorizeOrganizationWrite: async (trx: Db) => {
              await trx
                .updateTable('auth.member')
                .set({ role: 'member' })
                .where('organizationId', '=', team.id)
                .execute()
            },
          },
          { brandPrimaryColor: '#112233' },
        ),
      ).rejects.toMatchObject({ code: 'insufficient_role' })
    }
    await verify(serviceCopy())
    await expect(
      verify(
        serviceCopy([
          'await authorize(trx, ctx, true)',
          '// removed final membership authorization',
        ]),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verify(serviceCopy())
  })
  it('bounds retained storage, fences cross-org references and preserves omitted values under concurrent writes', async () => {
    const user = await createTestUser(db),
      other = await createTestUser(db),
      ctx = testContext(db, user.principal)
    const image = await png()
    const first = await uploadBrandLogo(ctx, image, 'image/png')
    expect(first.brandLogo).toBe(
      createHash('sha256')
        .update(await normalizeBrandLogo(image, 'image/png'))
        .digest('hex'),
    )
    expect(await getBrandLogo(ctx, first.brandLogo as string)).toEqual(
      await normalizeBrandLogo(image, 'image/png'),
    )
    expect(await uploadBrandLogo(ctx, image, 'image/png')).toEqual(first)
    await expect(
      setBranding(testContext(db, other.principal), { brandLogo: first.brandLogo }),
    ).rejects.toMatchObject({ code: 'brand_logo_not_found' })
    await Promise.all([
      setBranding(ctx, { brandPrimaryColor: '#000000' }),
      uploadBrandLogo(ctx, await sharp(image).negate().png().toBuffer(), 'image/png'),
    ])
    expect(await getBranding(ctx)).toMatchObject({
      brandPrimaryColor: '#000000',
      buttonTextColor: '#FFFFFF',
    })
    expect(
      await db
        .selectFrom('organization_brand_logos')
        .select('hash')
        .where('organization_id', '=', user.principal.organization.id)
        .execute(),
    ).toHaveLength(1)
    await expect(getBrandLogo(ctx, first.brandLogo as string)).rejects.toMatchObject({
      code: 'brand_logo_not_found',
    })
    await setBranding(ctx, { brandLogo: null })
    expect(await getBranding(ctx)).toMatchObject({ brandLogo: null, brandPrimaryColor: '#000000' })
    expect(
      await db
        .selectFrom('organization_brand_logos')
        .select('hash')
        .where('organization_id', '=', user.principal.organization.id)
        .execute(),
    ).toHaveLength(0)
    for (const color of ['red', '#fff', '#FFFFFF00'])
      await expect(setBranding(ctx, { brandPrimaryColor: color })).rejects.toMatchObject({
        code: 'invalid_brand_color',
      })
  })
  it('normalizes legacy stored logos for public delivery and bounded CID email without rewriting references', async () => {
    const user = await createTestUser(db)
    const org = user.principal.organization.id
    const legacy = await sharp({
      create: { width: 1600, height: 800, channels: 4, background: '#abc' },
    })
      .png()
      .toBuffer()
    const hash = createHash('sha256').update(legacy).digest('hex')
    await db
      .insertInto('organization_brand_logos')
      .values({ organization_id: org, hash, data: legacy })
      .execute()
    await db
      .insertInto('organization_branding')
      .values({ organization_id: org, brand_logo: hash })
      .execute()
    const brand = await getPublicBranding(db, org)
    expect(brand?.logoDataUrl).toBeNull()
    const publicHash = brand?.logoUrl?.split('/').at(-1) as string
    const publicBytes = await getPublicBrandLogo(db, org, publicHash)
    expect(publicHash).toBe(createHash('sha256').update(publicBytes).digest('hex'))
    expect(await sharp(publicBytes).metadata()).toMatchObject({ width: 512, height: 256 })
    expect(publicBytes.length).toBeLessThanOrEqual(BRAND_LOGO_OUTPUT_MAX_BYTES)
    const email = await getEmailBranding(db, org)
    expect(email?.logoDataUrl).toBe(`data:image/png;base64,${publicBytes.toString('base64')}`)
    expect((await getBranding(testContext(db, user.principal))).brandLogo).toBe(hash)
    expect(await getBrandLogo(testContext(db, user.principal), hash)).toEqual(publicBytes)
    const other = await createTestUser(db)
    const verifyIsolation = async (module: ReturnType<typeof serviceCopy>) => {
      await expect(
        module.getPublicBrandLogo(db, other.principal.organization.id, publicHash),
      ).rejects.toMatchObject({ code: 'brand_logo_not_found' })
    }
    await verifyIsolation(serviceCopy())
    await expect(
      verifyIsolation(
        serviceCopy([
          ".where('b.organization_id', '=', organizationId)",
          `.where('b.organization_id', '=', '${org}')`,
        ]),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await verifyIsolation(serviceCopy())
    for (const [organization, requestedHash] of [
      [org, 'f'.repeat(64)],
      [other.principal.organization.id, publicHash],
    ]) {
      await expect(
        getPublicBrandLogo(db, organization as string, requestedHash as string),
      ).rejects.toMatchObject({ code: 'brand_logo_not_found' })
    }
  })
  it('records each branding change with what changed, never the image, hash or colour', async () => {
    const user = await createTestUser(db),
      ctx = testContext(db, user.principal),
      organizationId = user.principal.organization.id,
      keyId = user.principal.kind === 'api_key' ? user.principal.apiKeyId : ''
    const journal = () =>
      db
        .selectFrom('audit_events')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .orderBy('id')
        .execute()
    const uploaded = await uploadBrandLogo(ctx, await png(), 'image/png')
    await setBranding(ctx, { brandPrimaryColor: '#12ab34' })
    await setBranding(ctx, { brandLogo: uploaded.brandLogo, brandPrimaryColor: null })
    // Refused and empty updates change nothing and record nothing.
    await setBranding(ctx, {})
    await expect(setBranding(ctx, { brandLogo: 'f'.repeat(64) })).rejects.toMatchObject({
      code: 'brand_logo_not_found',
    })
    await setBranding(ctx, { brandLogo: null })
    const rows = await journal()
    expect(
      rows.map((row) => [row.action, row.details]),
      'branding audit',
    ).toEqual([
      ['organization.branding_updated', { logo: 'uploaded' }],
      ['organization.branding_updated', { primaryColor: 'set' }],
      ['organization.branding_updated', { logo: 'selected', primaryColor: 'cleared' }],
      ['organization.branding_updated', { logo: 'removed' }],
    ])
    for (const row of rows)
      expect(row, 'branding audit').toMatchObject({
        actor_type: 'api_key',
        actor_id: keyId,
        credential_type: 'api_key',
        credential_id: keyId,
        credential_scope: 'full',
        target_type: 'organization',
        target_id: organizationId,
      })
    const text = JSON.stringify(rows).toLowerCase()
    for (const value of [uploaded.brandLogo as string, '#12ab34', user.email.toLowerCase()])
      expect(text, 'branding audit privacy').not.toContain(value)
    // The change and its event commit or roll back together.
    await sql`CREATE FUNCTION reject_branding_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='organization.branding_updated' THEN RAISE EXCEPTION 'synthetic branding audit failure'; END IF;
      RETURN NEW; END $$`.execute(db)
    await sql`CREATE TRIGGER reject_branding_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_branding_audit()`.execute(
      db,
    )
    try {
      await expect(setBranding(ctx, { brandPrimaryColor: '#654321' })).rejects.toThrow(
        /synthetic branding audit failure/,
      )
      await expect(uploadBrandLogo(ctx, await png(), 'image/png')).rejects.toThrow(
        /synthetic branding audit failure/,
      )
    } finally {
      await sql`DROP TRIGGER reject_branding_audit ON audit_events`.execute(db)
      await sql`DROP FUNCTION reject_branding_audit()`.execute(db)
    }
    expect(await getBranding(ctx), 'branding audit rollback').toMatchObject({
      brandLogo: null,
      brandPrimaryColor: null,
    })
    expect(await journal()).toHaveLength(4)
  })
})

// Each trial runs a transformed copy; production source is never temporarily broken.
function serviceCopy(replacement?: readonly [string, string]) {
  let source = readFileSync(new URL('./branding.ts', import.meta.url), 'utf8')
  if (replacement) {
    expect(source).toContain(replacement[0])
    source = source.replace(...replacement)
  }
  const script = stripTypeScriptTypes(
    source.replace(/^import\b[\s\S]*?from\s+['"][^'"]+['"]\n/gm, ''),
  ).replace(/\bexport /g, '')
  return new Function(
    'createHash',
    'brandContrast',
    'sharp',
    'z',
    'DomainError',
    'auditActor',
    'writeAuditEvent',
    `${script}; return {normalizeBrandLogo,getBranding,setBranding,uploadBrandLogo,getBrandLogo,getPublicBranding,getPublicBrandLogo,getEmailBranding}`,
  )(
    createHash,
    brandContrast,
    sharp,
    z,
    DomainError,
    auditActor,
    writeAuditEvent,
  ) as typeof import('./branding.ts')
}
describe('logo source-copy mutations', () => {
  it('kills input limit, declared type, dimension and re-encoding bypasses', async () => {
    const image = await png()
    const cases: [string, string, (module: ReturnType<typeof serviceCopy>) => Promise<void>][] = [
      [
        'if (data.length > BRAND_LOGO_MAX_BYTES) throw tooLarge()',
        'if (false) throw tooLarge()',
        async (m) => {
          await expect(
            m.normalizeBrandLogo(
              Buffer.concat([image, Buffer.alloc(BRAND_LOGO_MAX_BYTES)]),
              'image/png',
            ),
          ).rejects.toMatchObject({ code: 'brand_logo_too_large' })
        },
      ],
      [
        'metadata.format !== format',
        'false',
        async (m) => {
          await expect(m.normalizeBrandLogo(image, 'image/jpeg')).rejects.toMatchObject({
            code: 'invalid_brand_logo',
          })
        },
      ],
      [
        'metadata.width > 2048',
        'false',
        async (m) => {
          await expect(
            m.normalizeBrandLogo(
              await sharp({ create: { width: 2049, height: 1, channels: 3, background: 'white' } })
                .png()
                .toBuffer(),
              'image/png',
            ),
          ).rejects.toMatchObject({ code: 'invalid_brand_logo' })
        },
      ],
      [
        'metadata.height > 2048',
        'false',
        async (m) => {
          await expect(
            m.normalizeBrandLogo(
              await sharp({ create: { width: 1, height: 2049, channels: 3, background: 'white' } })
                .png()
                .toBuffer(),
              'image/png',
            ),
          ).rejects.toMatchObject({ code: 'invalid_brand_logo' })
        },
      ],
      [
        'return normalized',
        'return data',
        async (m) => {
          const result = await m.normalizeBrandLogo(
            Buffer.concat([image, Buffer.from('<script>bad()</script>')]),
            'image/png',
          )
          expect(result.includes(Buffer.from('<script>'))).toBe(false)
        },
      ],
    ]
    for (const [before, after, verify] of cases) {
      await verify(serviceCopy())
      await expect(verify(serviceCopy([before, after]))).rejects.toMatchObject({
        name: 'AssertionError',
      })
      await verify(serviceCopy())
    }
  })
})
