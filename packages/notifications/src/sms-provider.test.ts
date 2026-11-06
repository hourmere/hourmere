import { readFile, unlink, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  createFakeSmsProvider,
  createTwilioSmsProvider,
  maskSmsNumber,
  normalizeSmsDestination,
  SmsError,
  type SmsProvider,
  unconfiguredSmsProvider,
} from './sms-provider.ts'

const config = {
  accountSid: `AC${'1'.repeat(32)}`,
  authToken: 'synthetic-token',
  from: '+14155550123',
}
const input = { to: '+14155550124', body: 'Synthetic & reminder + 中文', idempotencyKey: 'job:1' }
const sid = `SM${'2'.repeat(32)}`
const success = () => Response.json({ sid })

describe('SMS providers', () => {
  it('fails closed when unconfigured', async () => {
    await expect(unconfiguredSmsProvider.sendSms(input)).rejects.toMatchObject({
      code: 'sms_not_configured',
    })
  })
  it('normalizes E.164 and masks fake observations', async () => {
    expect(normalizeSmsDestination(' +14155550124 ')).toBe(input.to)
    expect(maskSmsNumber(input.to)).toBe('+****24')
    const fake = createFakeSmsProvider()
    expect(await fake.sendSms(input)).toEqual({ providerMessageId: 'fake-1' })
    expect(fake.calls).toEqual([{ to: '+****24', idempotencyKey: 'job:1' }])
    expect(JSON.stringify(fake.calls)).not.toContain(input.body)
    expect(JSON.stringify(fake.calls)).not.toContain(input.to)
  })
  it.each([
    '911',
    '+19005550123',
    '+449012345678',
    '+442079460018',
    '4155550124',
    '+1234567',
    '+14155550124 ext 1',
  ])('rejects unsafe destination %s', async (to) => {
    const request = vi.fn<typeof fetch>()
    await expect(
      createTwilioSmsProvider(config, request).sendSms({ ...input, to }),
    ).rejects.toMatchObject({ code: 'sms_invalid_request' })
    expect(request).not.toHaveBeenCalled()
  })
  it('uses fixed endpoint, Basic account auth, encoded form and refuses redirects', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(success())
    expect(await createTwilioSmsProvider(config, request).sendSms(input)).toEqual({
      providerMessageId: sid,
    })
    const [url, init] = request.mock.calls[0] ?? []
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
    )
    expect(init?.redirect).toBe('error')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    })
    const body = new URLSearchParams(String(init?.body))
    expect(body.get('Body')).toBe(input.body)
    expect(body.get('To')).toBe(input.to)
    expect(body.get('From')).toBe(config.from)
    expect(body.has('MessagingServiceSid')).toBe(false)
    expect(body.has('StatusCallback')).toBe(false)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
  it('supports API keys and Messaging Services without From', async () => {
    const apiKeySid = `SK${'3'.repeat(32)}`
    const service = `MG${'4'.repeat(32)}`
    const request = vi.fn<typeof fetch>().mockResolvedValue(success())
    await createTwilioSmsProvider(
      {
        accountSid: config.accountSid,
        apiKeySid,
        apiKeySecret: 'synthetic-key',
        messagingServiceSid: service,
      },
      request,
    ).sendSms(input)
    const init = request.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from(`${apiKeySid}:synthetic-key`).toString('base64')}`,
    )
    const body = new URLSearchParams(String(init?.body))
    expect(body.get('MessagingServiceSid')).toBe(service)
    expect(body.has('From')).toBe(false)
  })
  it.each([
    { ...config, accountSid: '../escape' },
    { ...config, messagingServiceSid: `MG${'4'.repeat(32)}` },
    { ...config, authToken: undefined },
    { ...config, apiKeySid: `SK${'3'.repeat(32)}`, apiKeySecret: 'synthetic' },
  ])('rejects invalid configuration before HTTP', (invalid) => {
    expect(() => createTwilioSmsProvider(invalid)).toThrow(SmsError)
  })
  it.each([
    [429, 20429, 'sms_rate_limited'],
    [400, 21610, 'sms_provider_rejected'],
    [401, 20003, 'sms_provider_rejected'],
    [503, 20500, 'sms_delivery_unknown'],
  ] as const)(
    'maps HTTP %s without upstream prose and never retries',
    async (status, code, expected) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { code, message: `${input.to} ${input.body}` },
            { status, headers: { 'Retry-After': '17' } },
          ),
        )
      const error = await createTwilioSmsProvider(config, request)
        .sendSms(input)
        .catch((e: unknown) => e)
      expect(error).toMatchObject({
        code: expected,
        providerCode: code,
        retryAfterSeconds: status === 429 ? 17 : undefined,
      })
      expect(String(error)).not.toContain(input.to)
      expect(String(error)).not.toContain(input.body)
      expect(request).toHaveBeenCalledTimes(1)
    },
  )
  it('times out even when HTTP ignores abort', async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}))
    await expect(createTwilioSmsProvider(config, request, 5).sendSms(input)).rejects.toMatchObject({
      code: 'sms_timeout',
    })
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
  it('bounds a hanging response body', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new ReadableStream({ start() {} })))
    await expect(createTwilioSmsProvider(config, request, 5).sendSms(input)).rejects.toMatchObject({
      code: 'sms_timeout',
    })
  })
  it.each([
    () => new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid/' } }),
    () => new Response('malformed'),
    () => Response.json({ sid: input.to }),
    () => new Response('x'.repeat(32769)),
  ])('rejects redirect/malformed/unbounded responses', async (response) => {
    await expect(
      createTwilioSmsProvider(config, vi.fn<typeof fetch>().mockResolvedValue(response())).sendSms(
        input,
      ),
    ).rejects.toMatchObject({ code: 'sms_delivery_unknown' })
  })
  it('sanitizes transport errors', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`${input.to} ${config.authToken}`))
    const error = await createTwilioSmsProvider(config, request)
      .sendSms(input)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ message: 'sms_delivery_unknown' })
    expect(error).not.toHaveProperty('cause')
  })
})

// Source-copy controls keep production source unchanged and assert the real behavior.
it('source-copy mutations detect weakened provider protections', async () => {
  const sourceUrl = new URL('./sms-provider.ts', import.meta.url)
  const source = await readFile(sourceUrl, 'utf8')
  const cases: [string, string, (module: typeof import('./sms-provider.ts')) => Promise<void>][] = [
    [
      "redirect: 'error'",
      "redirect: 'follow'",
      async (module) => {
        const request = vi.fn<typeof fetch>().mockResolvedValue(success())
        await module.createTwilioSmsProvider(config, request).sendSms(input)
        expect(request.mock.calls[0]?.[1]?.redirect).toBe('error')
      },
    ],
    [
      "(type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE')",
      'false',
      async (module) => {
        expect(() => module.normalizeSmsDestination('+19005550123')).toThrow()
      },
    ],
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source-copy mutation
      '`+****${value.slice(-2)}`',
      'value',
      async (module) => {
        expect(module.maskSmsNumber(input.to)).toBe('+****24')
      },
    ],
    [
      "throw new SmsError('sms_not_configured')",
      "return { providerMessageId: 'disabled' }",
      async (module) => {
        await expect(module.unconfiguredSmsProvider.sendSms(input)).rejects.toMatchObject({
          code: 'sms_not_configured',
        })
      },
    ],
    [
      'length > 32768',
      'length > 999999',
      async (module) => {
        const response = Response.json({ sid, padding: 'x'.repeat(32769) })
        const provider: SmsProvider = module.createTwilioSmsProvider(
          config,
          vi.fn<typeof fetch>().mockResolvedValue(response),
        )
        await expect(provider.sendSms(input)).rejects.toMatchObject({
          code: 'sms_delivery_unknown',
        })
      },
    ],
  ]
  cases.push(
    [
      'setTimeout(() => controller.abort(), timeoutMs)',
      'setTimeout(() => controller.abort(), 30000)',
      async (module) => {
        const request = vi.fn<typeof fetch>().mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return success()
        })
        await expect(
          module.createTwilioSmsProvider(config, request, 5).sendSms(input),
        ).rejects.toMatchObject({ code: 'sms_timeout' })
      },
    ],
    [
      'input.body.length > 1600',
      'input.body.length > 9999',
      async (module) => {
        await expect(
          module.createFakeSmsProvider().sendSms({ ...input, body: 'x'.repeat(1601) }),
        ).rejects.toMatchObject({ code: 'sms_invalid_request' })
      },
    ],
    [
      "throw new SmsError(controller.signal.aborted ? 'sms_timeout' : 'sms_delivery_unknown')",
      'throw error',
      async (module) => {
        const request = vi
          .fn<typeof fetch>()
          .mockRejectedValue(new Error('private transport details'))
        await expect(
          module.createTwilioSmsProvider(config, request).sendSms(input),
        ).rejects.toMatchObject({ message: 'sms_delivery_unknown' })
      },
    ],
  )
  for (const [before, after, verify] of cases) {
    expect(source.includes(before)).toBe(true)
    const copy = new URL(`./sms-provider.mutation-${crypto.randomUUID()}.ts`, import.meta.url)
    try {
      await writeFile(copy, source)
      await verify(await import(copy.href))
      await unlink(copy)
      const mutant = new URL(`./sms-provider.mutation-${crypto.randomUUID()}.ts`, import.meta.url)
      try {
        await writeFile(mutant, source.replace(before, after))
        await expect(verify(await import(mutant.href))).rejects.toThrow()
      } finally {
        await unlink(mutant)
      }
    } finally {
      await unlink(copy).catch(() => {})
    }
  }
})
