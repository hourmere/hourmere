import { z } from '@hono/zod-openapi'

export const PublicBranding = z
  .object({
    name: z.string().openapi({ description: 'Organization name for logo alternative text' }),
    primaryColor: z
      .string()
      .regex(/^#[0-9A-F]{6}$/)
      .nullable(),
    logoDataUrl: z.string().nullable().openapi({
      description: 'Bounded normalized PNG data URL; no remote image request is needed',
    }),
  })
  .openapi('PublicBranding')
