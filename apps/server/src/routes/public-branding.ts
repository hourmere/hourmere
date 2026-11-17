import { z } from '@hono/zod-openapi'

export const PublicBranding = z
  .object({
    name: z.string().openapi({ description: 'Organization name for logo alternative text' }),
    primaryColor: z
      .string()
      .regex(/^#[0-9A-F]{6}$/)
      .nullable(),
    logoUrl: z.string().nullable().openapi({
      description: 'Organization-scoped content-hash PNG URL; immutable cacheable response',
    }),
    logoDataUrl: z.string().nullable().openapi({
      description: 'Deprecated; always null. Use logoUrl for the cacheable PNG',
    }),
  })
  .openapi('PublicBranding')
