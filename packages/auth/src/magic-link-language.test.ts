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
    name: 'ignores a public-only cookie for a Chinese browser',
    headers: { cookie: 'hourmere-language=de', 'accept-language': 'zh-CN' },
    language: 'zh-CN',
    subject: '登录 Hourmere',
  },
  {
    name: 'falls back to English for a public-only cookie and browser language',
    headers: { cookie: 'hourmere-language=de', 'accept-language': 'de-CH' },
    language: 'en',
    subject: 'Sign in to Hourmere',
  },
  {
    name: 'ignores a public-only cookie before negotiating weighted browser languages',
    headers: { cookie: 'hourmere-language=de', 'accept-language': 'de-CH,zh-CN;q=0.8' },
    language: 'zh-CN',
    subject: '登录 Hourmere',
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
  {
    name: 'keeps an explicit English cookie ahead of a Chinese browser',
    headers: { cookie: 'hourmere-language=en', 'accept-language': 'zh-CN' },
    language: 'en',
    subject: 'Sign in to Hourmere',
  },
  {
    name: 'ignores an invalid cookie before negotiating the browser language',
    headers: { cookie: 'hourmere-language=invalid', 'accept-language': 'zh-CN' },
    language: 'zh-CN',
    subject: '登录 Hourmere',
  },
  {
    name: 'requires the exact registered cookie language',
    headers: { cookie: 'hourmere-language=zh-cn', 'accept-language': 'en' },
    language: 'en',
    subject: 'Sign in to Hourmere',
  },
  {
    name: 'falls back to English without a language cookie or browser preference',
    headers: {},
    language: 'en',
    subject: 'Sign in to Hourmere',
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
        expect(queued.length).toBe(1)
        expect(queued[0]?.language).toBe(language)
        expect(messages.length).toBe(0)
      } else {
        await expect.poll(() => messages.length).toBe(1)
        expect(messages[0]?.subject).toBe(subject)
        expect(messages[0]?.html?.includes(`<html lang="${language}">`)).toBe(true)
        expect(queued.length).toBe(0)
      }
    })
  })
})
