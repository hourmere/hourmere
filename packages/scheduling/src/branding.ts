import { createHash } from 'node:crypto'
import { brandContrast } from '@hourmere/core'
import type { Db } from '@hourmere/db'
import sharp from 'sharp'
import { z } from 'zod'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'

export const BRAND_LOGO_MAX_BYTES = 512 * 1024
export const BrandingUpdateInput = z.strictObject({
  brandLogo: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .optional(),
  brandPrimaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
})
export interface BrandingContext extends ServiceContext {
  prepareOrganizationWrite?: ((trx: Db) => Promise<void>) | undefined
}
const denied = () =>
  new DomainError(
    'forbidden',
    'insufficient_role',
    'Only the personal owner or team owners and admins can manage branding',
  )
const invalidLogo = () =>
  new DomainError(
    'invalid',
    'invalid_brand_logo',
    'Choose a non-animated PNG, JPEG or WebP image up to 2048 pixels on each side',
  )
const tooLarge = () =>
  new DomainError(
    'invalid',
    'brand_logo_too_large',
    'The logo must be at most 512 KB before and after conversion',
  )

async function authorize(db: Db, ctx: ServiceContext, lock = false) {
  let query = db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .innerJoin('auth.organization as o', 'o.id', 'm.organizationId')
    .leftJoin('personal_organizations as p', 'p.organization_id', 'o.id')
    .select(['m.role', 'p.user_id'])
    .where('m.organizationId', '=', ctx.principal.organization.id)
    .where('m.userId', '=', ctx.principal.user.id)
    .where('u.emailVerified', '=', true)
  if (lock) query = query.forShare('m')
  const row = await query.executeTakeFirst()
  const roles = row?.role.split(',').map((role) => role.trim()) ?? []
  if (
    !row ||
    (row.user_id
      ? row.user_id !== ctx.principal.user.id || !roles.includes('owner')
      : !roles.some((role) => role === 'owner' || role === 'admin'))
  )
    throw denied()
}
function view(row: { brand_logo: string | null; brand_primary_color: string | null }) {
  return {
    brandLogo: row.brand_logo,
    brandPrimaryColor: row.brand_primary_color,
    ...(row.brand_primary_color
      ? brandContrast(row.brand_primary_color)
      : { buttonTextColor: null, backgroundContrast: null, buttonTextContrast: null }),
  }
}
async function read(db: Db, organizationId: string) {
  return view(
    await db
      .selectFrom('auth.organization')
      .select(['brand_logo', 'brand_primary_color'])
      .where('id', '=', organizationId)
      .executeTakeFirstOrThrow(),
  )
}
export async function getBranding(ctx: ServiceContext) {
  await authorize(ctx.db, ctx)
  return read(ctx.db, ctx.principal.organization.id)
}
async function write<T>(ctx: BrandingContext, action: (trx: Db) => Promise<T>) {
  return ctx.db.transaction().execute(async (trx) => {
    await ctx.prepareOrganizationWrite?.(trx)
    const user = await trx
      .selectFrom('auth.user')
      .select('id')
      .where('id', '=', ctx.principal.user.id)
      .where('emailVerified', '=', true)
      .forShare()
      .executeTakeFirst()
    if (!user) throw denied()
    const org = await trx
      .selectFrom('auth.organization')
      .select('id')
      .where('id', '=', ctx.principal.organization.id)
      .forUpdate()
      .executeTakeFirst()
    if (!org) throw denied()
    await ctx.authorizeOrganizationWrite?.(trx, org.id)
    await authorize(trx, ctx, true)
    return action(trx)
  })
}
export async function setBranding(ctx: BrandingContext, input: unknown) {
  const parsed = BrandingUpdateInput.safeParse(input)
  if (!parsed.success)
    throw new DomainError(
      'invalid',
      'invalid_brand_color',
      'Use a primary colour in #RRGGBB format and a valid uploaded logo reference',
    )
  return write(ctx, async (trx) => {
    const org = ctx.principal.organization.id
    const { brandLogo, brandPrimaryColor } = parsed.data
    if (
      brandLogo &&
      !(await trx
        .selectFrom('organization_brand_logos')
        .select('hash')
        .where('organization_id', '=', org)
        .where('hash', '=', brandLogo)
        .executeTakeFirst())
    )
      throw new DomainError('not_found', 'brand_logo_not_found')
    if (brandLogo !== undefined || brandPrimaryColor !== undefined)
      await trx
        .updateTable('auth.organization')
        .set({
          ...(brandLogo !== undefined ? { brand_logo: brandLogo } : {}),
          ...(brandPrimaryColor !== undefined
            ? { brand_primary_color: brandPrimaryColor?.toUpperCase() ?? null }
            : {}),
        })
        .where('id', '=', org)
        .execute()
    if (brandLogo === null)
      await trx.deleteFrom('organization_brand_logos').where('organization_id', '=', org).execute()
    return read(trx, org)
  })
}
/** Decode pixels and re-encode: metadata and appended HTML/scripts never survive. */
export async function normalizeBrandLogo(data: Buffer, contentType: string) {
  if (data.length > BRAND_LOGO_MAX_BYTES) throw tooLarge()
  const formats: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/webp': 'webp',
  }
  const format = formats[contentType.toLowerCase()]
  if (!format || data.length === 0) throw invalidLogo()
  try {
    // libvips reports APNG as a single PNG, so inspect its framed chunk table explicitly.
    if (format === 'png') {
      for (let offset = 8; offset + 12 <= data.length; ) {
        const length = data.readUInt32BE(offset)
        if (length > data.length - offset - 12) throw invalidLogo()
        const chunk = data.toString('ascii', offset + 4, offset + 8)
        if (chunk === 'acTL') throw invalidLogo()
        if (chunk === 'IEND') break
        offset += length + 12
      }
    }
    const image = sharp(data, { limitInputPixels: 2048 * 2048, failOn: 'warning', animated: true })
    const metadata = await image.metadata()
    if (
      metadata.format !== format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 2048 ||
      metadata.height > 2048 ||
      (metadata.pages ?? 1) !== 1
    )
      throw invalidLogo()
    const normalized = await image.rotate().png().toBuffer()
    if (normalized.length > BRAND_LOGO_MAX_BYTES) throw tooLarge()
    return normalized
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw invalidLogo()
  }
}
export async function uploadBrandLogo(ctx: BrandingContext, data: Buffer, contentType: string) {
  await authorize(ctx.db, ctx)
  const normalized = await normalizeBrandLogo(data, contentType)
  const hash = createHash('sha256').update(normalized).digest('hex')
  return write(ctx, async (trx) => {
    const org = ctx.principal.organization.id
    await trx
      .insertInto('organization_brand_logos')
      .values({ organization_id: org, hash, data: normalized })
      .onConflict((oc) => oc.column('organization_id').doUpdateSet({ hash, data: normalized }))
      .execute()
    await trx
      .updateTable('auth.organization')
      .set({ brand_logo: hash })
      .where('id', '=', org)
      .execute()
    return read(trx, org)
  })
}
export async function getBrandLogo(ctx: ServiceContext, hash: string) {
  await authorize(ctx.db, ctx)
  const row = await ctx.db
    .selectFrom('organization_brand_logos')
    .select('data')
    .where('organization_id', '=', ctx.principal.organization.id)
    .where('hash', '=', hash)
    .executeTakeFirst()
  if (!row) throw new DomainError('not_found', 'brand_logo_not_found')
  return row.data
}
