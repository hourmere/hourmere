import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.url().optional(),
  // Self-hosted instances migrate on start; set to "false" to run `npm run db:migrate` yourself.
  AUTO_MIGRATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Built web app to serve; unset in development, where Vite serves it.
  WEB_DIST: z.string().optional(),
})

export type Config = z.infer<typeof schema> & { PUBLIC_URL: string }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`invalid configuration: ${z.prettifyError(parsed.error)}`)
  }
  const c = parsed.data
  return { ...c, PUBLIC_URL: c.PUBLIC_URL ?? `http://localhost:${c.PORT}` }
}
