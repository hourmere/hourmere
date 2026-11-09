import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { crc32 } from 'node:zlib'
import { brandContrast } from '@hourmere/core'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  BRAND_LOGO_MAX_BYTES,
  getBranding,
  getBrandLogo,
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
  it('rejects animated WebP and images whose normalized PNG exceeds storage limits', async () => {
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
    for (const [before, after, bytes, type, code] of [
      ['(metadata.pages ?? 1) !== 1', 'false', animated, 'image/webp', 'invalid_brand_logo'],
      [
        'if (normalized.length > BRAND_LOGO_MAX_BYTES) throw tooLarge()',
        'if (false) throw tooLarge()',
        compressed,
        'image/jpeg',
        'brand_logo_too_large',
      ],
    ] as const) {
      const verify = async (m: ReturnType<typeof serviceCopy>) => {
        await expect(m.normalizeBrandLogo(bytes, type)).rejects.toMatchObject({ code })
      }
      await verify(serviceCopy())
      await expect(verify(serviceCopy([before, after]))).rejects.toMatchObject({
        name: 'AssertionError',
      })
      await verify(serviceCopy())
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
    `${script}; return {normalizeBrandLogo,getBranding,setBranding,uploadBrandLogo,getBrandLogo}`,
  )(createHash, brandContrast, sharp, z, DomainError) as typeof import('./branding.ts')
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
        'const normalized = await image.rotate().png().toBuffer()',
        'const normalized = data',
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
