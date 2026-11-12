import { readFileSync } from 'node:fs'
import { z } from 'zod'

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional())
const sid = (name: string, prefix: string) =>
  optional(
    z.string().regex(new RegExp(`^${prefix}[a-fA-F0-9]{32}$`), `${name} must be a ${prefix} SID`),
  )
const secret = (name: string) =>
  optional(
    z
      .string()
      .regex(
        /^[\x21-\x7e]{16,1024}$/,
        `${name} must contain 16–1024 printable non-whitespace characters`,
      ),
  )
const limit = (name: string, fallback: number) =>
  z
    .preprocess(
      (value) => (value === '' ? undefined : value),
      z.coerce.number().int().min(1).max(2147483647).default(fallback),
    )
    .describe(name)

export const smsConfigSchema = z.object({
  SMS_PROVIDER: optional(z.enum(['twilio'])),
  TWILIO_ACCOUNT_SID: sid('TWILIO_ACCOUNT_SID', 'AC'),
  TWILIO_AUTH_TOKEN: secret('TWILIO_AUTH_TOKEN'),
  TWILIO_API_KEY_SID: sid('TWILIO_API_KEY_SID', 'SK'),
  TWILIO_API_KEY_SECRET: secret('TWILIO_API_KEY_SECRET'),
  TWILIO_MESSAGING_SERVICE_SID: sid('TWILIO_MESSAGING_SERVICE_SID', 'MG'),
  TWILIO_FROM: optional(
    z.string().regex(/^\+[1-9]\d{7,14}$/, 'TWILIO_FROM must be an E.164 phone number'),
  ),
  SMS_HASH_KEY: optional(
    z.string().refine((value) => {
      const bytes = Buffer.from(value, 'base64')
      return bytes.length === 32 && bytes.toString('base64') === value
    }, 'SMS_HASH_KEY must be 32 random bytes encoded as base64'),
  ),
  SMS_RECIPIENT_MAX_PER_HOUR: limit('SMS_RECIPIENT_MAX_PER_HOUR', 3),
  SMS_RECIPIENT_MAX_PER_DAY: limit('SMS_RECIPIENT_MAX_PER_DAY', 10),
  SMS_MAX_PER_HOUR: limit('SMS_MAX_PER_HOUR', 100),
  SMS_ORGANIZATION_MAX_PER_DAY: limit('SMS_ORGANIZATION_MAX_PER_DAY', 50),
})

export function validateSmsConfig(c: z.infer<typeof smsConfigSchema>, ctx: z.RefinementCtx) {
  const issue = (message: string) =>
    ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message })
  const settings = [
    c.TWILIO_ACCOUNT_SID,
    c.TWILIO_AUTH_TOKEN,
    c.TWILIO_API_KEY_SID,
    c.TWILIO_API_KEY_SECRET,
    c.TWILIO_MESSAGING_SERVICE_SID,
    c.TWILIO_FROM,
    c.SMS_HASH_KEY,
  ]
  if (!c.SMS_PROVIDER) {
    if (settings.some(Boolean))
      issue('SMS_PROVIDER=twilio is required when SMS credentials or sender settings are supplied')
    return
  }
  if (!c.TWILIO_ACCOUNT_SID || !c.SMS_HASH_KEY)
    issue('SMS requires TWILIO_ACCOUNT_SID and an independent SMS_HASH_KEY')
  const apiKey = Boolean(c.TWILIO_API_KEY_SID && c.TWILIO_API_KEY_SECRET)
  if (
    Boolean(c.TWILIO_API_KEY_SID) !== Boolean(c.TWILIO_API_KEY_SECRET) ||
    Boolean(c.TWILIO_AUTH_TOKEN) === apiKey
  ) {
    issue(
      'SMS requires exactly one authentication method: TWILIO_AUTH_TOKEN or TWILIO_API_KEY_SID with TWILIO_API_KEY_SECRET',
    )
  }
  if (Boolean(c.TWILIO_MESSAGING_SERVICE_SID) === Boolean(c.TWILIO_FROM)) {
    issue('SMS requires exactly one sender: TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM')
  }
}

/** Resolve only SMS secrets, without including paths, contents or OS errors in diagnostics. */
export function resolveSmsSecretFiles(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let resolved = env
  for (const name of ['TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SECRET', 'SMS_HASH_KEY'] as const) {
    const path = env[`${name}_FILE`]
    if (!path) continue
    if (env[name]) throw new Error(`invalid configuration: set only ${name} or ${name}_FILE`)
    if (resolved === env) resolved = { ...env }
    try {
      resolved[name] = readFileSync(path, 'utf8').replace(/\r?\n$/, '')
    } catch {
      throw new Error(`invalid configuration: cannot read ${name}_FILE`)
    }
    if (!resolved[name]) throw new Error(`invalid configuration: ${name}_FILE must not be empty`)
  }
  return resolved
}
