import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { createTestDatabase } from '@hourmere/db/testing'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config.ts'
import { startServer } from './server.ts'

const base = {
  DATABASE_URL: 'postgres://unused@127.0.0.1:9/unused',
  BETTER_AUTH_SECRET: 'synthetic-stripe-test-secret-at-least-32-characters',
}
const apiKey = ['rk', 'test', 'synthetic'.repeat(4)].join('_')
const signingSecret = ['whsec', 'synthetic'.repeat(4)].join('_')
const configured = {
  ...base,
  STRIPE_ACCOUNT_ID: 'acct_hourmerefixture',
  STRIPE_API_KEY: apiKey,
  STRIPE_WEBHOOK_SIGNING_SECRET: signingSecret,
}

function expectRedacted(text: string) {
  expect(text.includes(apiKey), 'Stripe API key remains private').toBe(false)
  expect(text.includes(signingSecret), 'Stripe endpoint signing secret remains private').toBe(false)
}

describe('Stripe startup configuration', () => {
  it('is optional even when paid admission is requested and defaults to test outside production', () => {
    expect(
      loadConfig({ ...base, NODE_ENV: 'production', PAID_BOOKINGS_ENABLED: 'true' }).stripe,
    ).toBeUndefined()
    const config = loadConfig(configured)
    expect(config.stripe).toMatchObject({ accountId: configured.STRIPE_ACCOUNT_ID, mode: 'test' })
    expect(config.stripe?.apiKey() === apiKey).toBe(true)
    expect(config.stripe?.webhookSigningSecret() === signingSecret).toBe(true)
    expectRedacted(JSON.stringify(config))
    expectRedacted(inspect(config, { showHidden: true, getters: true, depth: null }))
  })

  it('requires explicit production mode and rejects an API key with the wrong mode', () => {
    const production = { ...configured, NODE_ENV: 'production' }
    expect(() => loadConfig(production)).toThrow(/STRIPE_MODE must be explicitly set/)
    expect(loadConfig({ ...production, STRIPE_MODE: 'test' }).stripe?.mode).toBe('test')
    expect(() => loadConfig({ ...production, STRIPE_MODE: 'live' })).toThrow(
      /STRIPE_API_KEY must be a secret or restricted key matching STRIPE_MODE/,
    )
  })

  it.each(['STRIPE_API_KEY', 'STRIPE_WEBHOOK_SIGNING_SECRET'] as const)(
    'fails startup when %s is absent or uses both input sources',
    async (name) => {
      await expect(startServer({ ...configured, [name]: '' })).rejects.toThrow(
        `${name} or ${name}_FILE is required`,
      )
      await expect(
        startServer({ ...configured, [`${name}_FILE`]: '/private-unread-secret-path' }),
      ).rejects.toThrow(`set only ${name} or ${name}_FILE`)
    },
  )

  it('loads read-only files and keeps unreadable file paths out of diagnostics', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hourmere-stripe-config-'))
    const apiFile = join(directory, 'api-key')
    const signingFile = join(directory, 'endpoint-signing-secret')
    try {
      writeFileSync(apiFile, `${apiKey}\n`, { mode: 0o400 })
      writeFileSync(signingFile, `${signingSecret}\r\n`, { mode: 0o400 })
      const env = {
        ...configured,
        STRIPE_API_KEY: '',
        STRIPE_API_KEY_FILE: apiFile,
        STRIPE_WEBHOOK_SIGNING_SECRET: '',
        STRIPE_WEBHOOK_SIGNING_SECRET_FILE: signingFile,
      }
      const config = loadConfig(env)
      expect(config.stripe?.apiKey() === apiKey).toBe(true)
      expect(config.stripe?.webhookSigningSecret() === signingSecret).toBe(true)
      expectRedacted(JSON.stringify(config))
      const missing = () => loadConfig({ ...env, STRIPE_API_KEY_FILE: `${apiFile}-absent` })
      expect(missing).toThrow(/cannot read STRIPE_API_KEY_FILE/)
      expect(missing).not.toThrow(directory)
    } finally {
      rmSync(apiFile, { force: true })
      rmSync(signingFile, { force: true })
      rmdirSync(directory)
    }
  })

  it('does not include malformed credential values in validation errors', () => {
    const invalidKey = () => loadConfig({ ...configured, STRIPE_API_KEY: `private-${apiKey}` })
    const invalidSecret = () =>
      loadConfig({ ...configured, STRIPE_WEBHOOK_SIGNING_SECRET: `private-${signingSecret}` })
    expect(invalidKey).toThrow(/STRIPE_API_KEY/)
    expect(invalidKey).not.toThrow(apiKey)
    expect(invalidSecret).toThrow(/STRIPE_WEBHOOK_SIGNING_SECRET/)
    expect(invalidSecret).not.toThrow(signingSecret)
  })
})

it.skipIf(!process.env.DATABASE_URL)(
  'keeps Stripe settings out of production instance responses and logs with the paid flag set',
  async () => {
    const db = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'stripe_config',
    })
    const logs = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
    const fetchOnLoopback = globalThis.fetch
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (new URL(String(input)).hostname !== '127.0.0.1')
        throw new Error('Unexpected outbound request in startup test')
      return fetchOnLoopback(input, init)
    })
    try {
      const server = await startServer({
        ...configured,
        DATABASE_URL: db.url,
        HOURMERE_ROLE: 'web',
        NODE_ENV: 'production',
        STRIPE_MODE: 'test',
        PAID_BOOKINGS_ENABLED: 'true',
        PORT: '0',
        PUBLIC_URL: 'http://localhost',
      })
      try {
        const result = await fetch(`http://127.0.0.1:${server.port}/api/v1/instance`)
        expect(result.status).toBe(200)
        const response = await result.text()
        expectRedacted(response)
        expect(response.toLowerCase().includes('stripe')).toBe(false)
        expect(response.includes(configured.STRIPE_ACCOUNT_ID)).toBe(false)
        expect(http).toHaveBeenCalledTimes(1)
      } finally {
        await server.close()
      }
      expectRedacted(
        inspect(
          logs.flatMap((log) => log.mock.calls),
          { depth: null },
        ),
      )
    } finally {
      http.mockRestore()
      for (const log of logs) log.mockRestore()
      await db.drop()
    }
  },
)
