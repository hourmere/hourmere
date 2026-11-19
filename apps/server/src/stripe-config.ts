import { readFileSync } from 'node:fs'
import type { PaymentMode } from '@hourmere/scheduling'

/** Credentials stay out of inspection, serialization and object spreads. */
export class StripeConfig {
  readonly accountId: string
  readonly mode: PaymentMode
  #apiKey: string
  #webhookSigningSecret: string

  constructor(accountId: string, mode: PaymentMode, apiKey: string, webhookSigningSecret: string) {
    this.accountId = accountId
    this.mode = mode
    this.#apiKey = apiKey
    this.#webhookSigningSecret = webhookSigningSecret
  }

  apiKey(): string {
    return this.#apiKey
  }

  webhookSigningSecret(): string {
    return this.#webhookSigningSecret
  }
}

function configurationError(message: string): Error {
  return new Error(`invalid configuration: ${message}`)
}

function readSecret(
  env: NodeJS.ProcessEnv,
  name: 'STRIPE_API_KEY' | 'STRIPE_WEBHOOK_SIGNING_SECRET',
): string {
  const value = env[name]
  const path = env[`${name}_FILE`]
  if (path && value) throw configurationError(`set only ${name} or ${name}_FILE`)
  if (value) return value
  if (!path) throw configurationError(`${name} or ${name}_FILE is required for Stripe`)
  try {
    return readFileSync(path, 'utf8').replace(/\r?\n$/, '')
  } catch {
    throw configurationError(`cannot read ${name}_FILE`)
  }
}

/** Loaded on startup for every server role, independently of the reserved paid-booking flag. */
export function loadStripeConfig(env: NodeJS.ProcessEnv): StripeConfig | undefined {
  const accountId = env.STRIPE_ACCOUNT_ID
  const selectedMode = env.STRIPE_MODE || undefined
  if (
    !accountId &&
    !selectedMode &&
    !env.STRIPE_API_KEY &&
    !env.STRIPE_API_KEY_FILE &&
    !env.STRIPE_WEBHOOK_SIGNING_SECRET &&
    !env.STRIPE_WEBHOOK_SIGNING_SECRET_FILE
  )
    return undefined

  if (!accountId || !/^acct_[A-Za-z0-9]{1,128}$/.test(accountId))
    throw configurationError('STRIPE_ACCOUNT_ID must be a Stripe account ID')
  if (!selectedMode && env.NODE_ENV === 'production')
    throw configurationError('STRIPE_MODE must be explicitly set to test or live in production')
  const mode = selectedMode ?? 'test'
  if (mode !== 'test' && mode !== 'live')
    throw configurationError('STRIPE_MODE must be test or live')
  const apiKey = readSecret(env, 'STRIPE_API_KEY')
  const webhookSigningSecret = readSecret(env, 'STRIPE_WEBHOOK_SIGNING_SECRET')
  if (!new RegExp(`^(sk|rk)_${mode}_[A-Za-z0-9]{1,240}$`).test(apiKey))
    throw configurationError(
      'STRIPE_API_KEY must be a secret or restricted key matching STRIPE_MODE',
    )
  if (!/^whsec_[A-Za-z0-9]{16,256}$/.test(webhookSigningSecret))
    throw configurationError(
      'STRIPE_WEBHOOK_SIGNING_SECRET must be a Stripe endpoint signing secret',
    )
  return new StripeConfig(accountId, mode, apiKey, webhookSigningSecret)
}
