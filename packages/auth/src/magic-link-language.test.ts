import { createDb } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import type { MailMessage } from '@hourmere/mail'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AuthConfig, createAuth, createAuthPool } from './index.ts'

const serverUrl = process.env.DATABASE_URL
const origin = 'http://localhost:43827'
const signup = { mode: 'open', allowedDomains: [] } as const
const scenarios = [
  {
    name: 'maps a public-only cookie through the admin fallback',
    headers: { cookie: 'hourmere-language=de', 'accept-language': 'de-CH,zh-CN;q=0.8' },
    language: 'en',
    subject: 'Sign in to Hourmere',
  },
  {
    name: 'negotiates the next browser language available on the admin surface',
    headers: { 'accept-language': 'de-CH,zh-CN;q=0.8' },
    language: 'zh-CN',
    subject: '登录 Hourmere',
  },
  {
    name: 'keeps a supported cookie ahead of the browser language',
    headers: { cookie: 'hourmere-language=zh-CN', 'accept-language': 'en' },
    language: 'zh-CN',
    subject: '登录 Hourmere',
  },
] as const

describe.skipIf(!serverUrl)('sign-in email interface language', () => {
  let owned: TestDatabase
  let authPool: ReturnType<typeof createAuthPool>
  const messages: MailMessage[] = []
  const queued: Parameters<NonNullable<AuthConfig['queueSignInEmail']>>[0][] = []
  const auths = new Map<string, ReturnType<typeof createAuth>>()

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    authPool = createAuthPool(owned.url, signup)
    for (const delivery of ['queued', 'direct']) {
      auths.set(
        delivery,
        createAuth({
          pool: authPool,
          db: createDb(owned.pool),
          baseURL: origin,
          secret: 'synthetic-language-test-secret-at-least-32-characters',
          signup,
          mailer: {
            send: async (message) => {
              messages.push(message)
            },
          },
          ...(delivery === 'queued' && {
            queueSignInEmail: async (request) => {
              queued.push(request)
            },
          }),
        }),
      )
    }
  })
  afterAll(async () => {
    await authPool?.end()
    await owned?.drop()
  })

  describe.each(['queued', 'direct'])('%s delivery', (delivery) => {
    it.each(scenarios)('$name', async ({ headers, language, subject }) => {
      messages.length = 0
      queued.length = 0
      const auth = auths.get(delivery)
      expect(auth).toBeDefined()
      const response = await auth?.handler(
        new Request(`${origin}/api/auth/sign-in/magic-link`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin, ...headers },
          body: JSON.stringify({ email: 'language@example.test', callbackURL: '/app' }),
        }),
      )
      expect(response?.status).toBe(200)
      if (delivery === 'queued') {
        expect(queued).toHaveLength(1)
        expect(queued[0]?.language).toBe(language)
        expect(messages).toHaveLength(0)
      } else {
        await expect.poll(() => messages.length).toBe(1)
        expect(messages[0]?.subject).toBe(subject)
        expect(messages[0]?.html).toContain(`<html lang="${language}">`)
        expect(queued).toHaveLength(0)
      }
    })
  })
})
