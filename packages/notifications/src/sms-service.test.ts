import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createDb, createPool, type Db } from '@hourmere/db'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/src/testing.ts'
import { assertSmsLogsPrivate } from './sms-log-test-utils.ts'
import { createTwilioSmsProvider, SmsError, type SmsProvider } from './sms-provider.ts'
import { createSmsService, purgeSmsDeliveryDetails, type SmsLimits } from './sms-service.ts'

async function sourceCopy(source: string) {
  const directory = await mkdtemp(
    fileURLToPath(new URL('../../../node_modules/.sms-service-', import.meta.url)),
  )
  const file = new URL(`file://${directory}/service.ts`)
  await writeFile(
    file,
    source.replace(
      "'./sms-provider.ts'",
      JSON.stringify(new URL('./sms-provider.ts', import.meta.url).href),
    ),
  )
  return { file, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

const secret = 'synthetic-sms-hmac-key-at-least-32-characters'
const request = () => ({
  to: '+14155550123',
  body: 'Synthetic reminder',
  organizationId: randomUUID(),
  idempotencyKey: randomUUID(),
})
const roomy = {
  recipientPerHour: 100,
  recipientPerDay: 100,
  instancePerHour: 100,
  organizationPerDay: 100,
}

describe.skipIf(!process.env.DATABASE_URL)('durable SMS dispatch', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string, undefined, {
      tag: 'sms_dispatch',
    })
    db = createDb(owned.pool)
  })
  afterAll(async () => {
    await owned?.drop()
  })
  beforeEach(async () => {
    await db.deleteFrom('sms_deliveries').execute()
  })
  function setup(limits: Partial<SmsLimits> = roomy, provider?: SmsProvider) {
    const sendSms = vi.fn(async () => ({ providerMessageId: 'SMsynthetic' }))
    return {
      sendSms,
      service: createSmsService({
        db,
        hashSecret: secret,
        limits,
        provider: provider ?? { sendSms },
      }),
    }
  }
  it('fails closed without configuration before touching the database', async () => {
    const service = createSmsService({ db: {} as Db, hashSecret: '' })
    await expect(service.sendSms(request())).rejects.toMatchObject({ code: 'sms_not_configured' })
  })
  it('commits the dispatch reservation before provider I/O', async () => {
    const input = request()
    const sendSms = vi.fn(async () => {
      const rows = await owned.pool.query('SELECT status FROM sms_deliveries')
      expect(rows.rows).toEqual([{ status: 'dispatching' }])
      return { providerMessageId: 'SMsynthetic' }
    })
    await setup(roomy, { sendSms }).service.sendSms(input)
    expect(sendSms).toHaveBeenCalledTimes(1)
  })
  it('persists only keyed hashes, a mask and minimal delivery state', async () => {
    const { service } = setup()
    const input = request()
    await service.sendSms(input)
    const row = await db.selectFrom('sms_deliveries').selectAll().executeTakeFirstOrThrow()
    expect(row.key_hash).toEqual(
      createHmac('sha256', secret)
        .update('hourmere/sms/job/v1\0')
        .update(input.idempotencyKey)
        .digest(),
    )
    expect(row.recipient_mask).toBe('+****23')
    expect(row.recipient_hash).toHaveLength(32)
    expect(row.request_hash).toHaveLength(32)
    expect(row.status).toBe('accepted')
    expect(JSON.stringify(row)).not.toContain(input.to)
    expect(JSON.stringify(row)).not.toContain(input.body)
  })
  it('deduplicates concurrent workers and retained retries, rejects changed payloads', async () => {
    const { service, sendSms } = setup()
    const input = request()
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => service.sendSms(input)),
    )
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true)
    expect(sendSms).toHaveBeenCalledTimes(1)
    const restarted = createSmsService({
      db,
      hashSecret: secret,
      provider: { sendSms },
      limits: roomy,
    })
    await expect(restarted.sendSms(input)).resolves.toEqual({ providerMessageId: 'SMsynthetic' })
    for (const changed of [
      { body: 'changed' },
      { to: '+14155550124' },
      { organizationId: randomUUID() },
    ])
      await expect(restarted.sendSms({ ...input, ...changed })).rejects.toMatchObject({
        code: 'sms_idempotency_conflict',
      })
    expect(sendSms).toHaveBeenCalledTimes(1)
    expect(owned.pool.totalCount).toBeLessThanOrEqual(10)
  })
  it.each([
    'recipientPerHour',
    'recipientPerDay',
    'instancePerHour',
    'organizationPerDay',
  ] as const)('serializes %s across concurrent jobs', async (field) => {
    const { service, sendSms } = setup({ ...roomy, [field]: 2 })
    const input = request()
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        service.sendSms({
          ...input,
          idempotencyKey: randomUUID(),
          ...(field === 'instancePerHour'
            ? { organizationId: randomUUID(), to: `+141555501${String(index).padStart(2, '0')}` }
            : {}),
          ...(field === 'organizationPerDay'
            ? { to: `+141555501${String(index).padStart(2, '0')}` }
            : {}),
          ...(field.startsWith('recipient') ? { organizationId: randomUUID() } : {}),
        }),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    expect(
      results.filter((result) => result.status === 'rejected').map((result) => result.reason.code),
    ).toEqual(Array(10).fill('sms_rate_limited'))
    expect(sendSms).toHaveBeenCalledTimes(2)
  })
  it('uses rolling database windows, independently expires hourly and daily budgets', async () => {
    const { service } = setup({
      recipientPerHour: 1,
      recipientPerDay: 2,
      instancePerHour: 100,
      organizationPerDay: 100,
    })
    const input = request()
    await service.sendSms(input)
    await db
      .updateTable('sms_deliveries')
      .set({ created_at: sql`clock_timestamp()-interval '61 minutes'` })
      .execute()
    await service.sendSms({ ...input, idempotencyKey: randomUUID() })
    await db
      .updateTable('sms_deliveries')
      .set({ created_at: sql`clock_timestamp()-interval '61 minutes'` })
      .execute()
    await expect(service.sendSms({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject(
      { code: 'sms_rate_limited' },
    )
    await db
      .updateTable('sms_deliveries')
      .set({ created_at: sql`clock_timestamp()-interval '25 hours'` })
      .execute()
    await expect(service.sendSms({ ...input, idempotencyKey: randomUUID() })).resolves.toBeDefined()
  })
  it.each([
    new SmsError('sms_timeout'),
    new SmsError('sms_provider_rejected'),
    new SmsError('sms_delivery_unknown', { retryAfterSeconds: 60 }),
    new Error('sensitive provider body'),
  ])('never retries a provider failure or ambiguous outcome %#', async (error) => {
    const sendSms = vi.fn(async () => {
      throw error
    })
    const { service } = setup(roomy, { sendSms })
    const input = request()
    await expect(service.sendSms(input)).rejects.toBeInstanceOf(SmsError)
    await expect(service.sendSms(input)).rejects.toMatchObject({
      code:
        error instanceof SmsError && error.code === 'sms_provider_rejected'
          ? 'sms_provider_rejected'
          : 'sms_delivery_unknown',
    })
    expect(sendSms).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, 0, 9000, Number.NaN])('bounds provider retry delays %s', async (delay) => {
    const { service } = setup(roomy, {
      sendSms: async () => {
        throw new SmsError('sms_rate_limited', { retryAfterSeconds: delay })
      },
    })
    const expected = delay === 0 ? 1 : delay === 9000 ? 3600 : 60
    await expect(service.sendSms(request())).rejects.toMatchObject({
      code: 'sms_rate_limited',
      retryAfterSeconds: expected,
    })
    const { rows } = await owned.pool.query(
      'SELECT extract(epoch FROM retry_not_before-updated_at) AS delay FROM sms_deliveries',
    )
    expect(Number(rows[0].delay)).toBeCloseTo(expected, 1)
  })
  it('retries definite rate limits only after backoff and charges only actual dispatches', async () => {
    await verifyRetry(createSmsService)
  })
  async function verifyRetry(factory: typeof createSmsService, aged = false) {
    const input = request()
    const providerMessageId = `SM${'2'.repeat(32)}`
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 20429 }), {
          status: 429,
          headers: { 'Retry-After': '3600' },
        }),
      )
      .mockImplementation(
        async () => new Response(JSON.stringify({ sid: providerMessageId }), { status: 201 }),
      )
    const twilio = createTwilioSmsProvider(
      { accountSid: `AC${'1'.repeat(32)}`, authToken: 'synthetic', from: '+14155550124' },
      http,
    )
    const sendSms = vi.fn(twilio.sendSms)
    const service = factory({
      db,
      hashSecret: secret,
      limits: {
        recipientPerHour: 1,
        recipientPerDay: 1,
        instancePerHour: 1,
        organizationPerDay: 1,
      },
      provider: { sendSms },
    })
    await expect(service.sendSms(input)).rejects.toMatchObject({ code: 'sms_rate_limited' })
    await expect(service.sendSms(input)).rejects.toMatchObject({
      code: 'sms_rate_limited',
      retryAfterSeconds: expect.any(Number),
    })
    expect(sendSms).toHaveBeenCalledTimes(1)
    await expect(service.sendSms({ ...input, body: 'changed' })).rejects.toMatchObject({
      code: 'sms_idempotency_conflict',
    })
    await db
      .updateTable('sms_deliveries')
      .set({
        retry_not_before: sql`clock_timestamp()-interval '1 second'`,
        ...(aged ? { created_at: sql<Date>`clock_timestamp()-interval '25 hours'` } : {}),
      })
      .execute()
    const pools = [createPool(owned.url), createPool(owned.url)]
    let results: PromiseSettledResult<{ providerMessageId: string }>[]
    try {
      const workers = [
        service,
        ...pools.map((pool) =>
          factory({
            db: createDb(pool),
            hashSecret: secret,
            limits: {
              recipientPerHour: 1,
              recipientPerDay: 1,
              instancePerHour: 1,
              organizationPerDay: 1,
            },
            provider: { sendSms },
          }),
        ),
      ]
      results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, index) => (workers[index % 3] ?? service).sendSms(input)),
      )
    } finally {
      await Promise.all(pools.map((pool) => pool.end()))
    }
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true)
    expect(sendSms).toHaveBeenCalledTimes(2)
    await expect(service.sendSms(input)).resolves.toEqual({ providerMessageId })
    await expect(service.sendSms({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject(
      { code: 'sms_rate_limited' },
    )
    expect(sendSms).toHaveBeenCalledTimes(2)
  }
  it('never logs destinations or bodies across success, failures, and retries', async () => {
    await verifyLogs(createSmsService)
  })
  async function verifyLogs(factory: typeof createSmsService) {
    for (const code of [
      undefined,
      'sms_provider_rejected',
      'sms_rate_limited',
      'sms_timeout',
      'sms_delivery_unknown',
    ] as const) {
      const input = request()
      const service = factory({
        db,
        hashSecret: secret,
        limits: roomy,
        provider: {
          sendSms: async () => {
            if (code) throw new SmsError(code)
            return { providerMessageId: 'SMsynthetic' }
          },
        },
      })
      await assertSmsLogsPrivate(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await service.sendSms(input)
          } catch (error) {
            expect(error).toBeInstanceOf(SmsError)
          }
        }
      }, input)
    }
  }
  it('retains crash reservations', async () => {
    const { service, sendSms } = setup()
    const input = request()
    await service.sendSms(input)
    await db
      .updateTable('sms_deliveries')
      .set({ status: 'dispatching', provider_message_id: null })
      .execute()
    await expect(service.sendSms(input)).rejects.toMatchObject({ code: 'sms_delivery_unknown' })
    expect(sendSms).toHaveBeenCalledTimes(1)
  })
  it('scrubs delivery details after 30 days but never reopens old job keys', async () => {
    const { service, sendSms } = setup()
    const input = request()
    await service.sendSms(input)
    await db
      .updateTable('sms_deliveries')
      .set({ created_at: sql`clock_timestamp()-interval '31 days'` })
      .execute()
    await purgeSmsDeliveryDetails(db)
    const row = await db.selectFrom('sms_deliveries').selectAll().executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      status: 'expired',
      request_hash: null,
      recipient_hash: null,
      recipient_mask: null,
      organization_id: null,
      provider_message_id: null,
    })
    await expect(service.sendSms(input)).rejects.toMatchObject({ code: 'sms_delivery_unknown' })
    expect(sendSms).toHaveBeenCalledTimes(1)
  })
  it('validates inputs and limits without spending budget', async () => {
    expect(() => setup({ recipientPerHour: 0 })).toThrow('positive')
    const { service, sendSms } = setup()
    for (const changed of [
      { organizationId: 'invalid' },
      { idempotencyKey: '' },
      { body: '' },
      { body: 'a'.repeat(1601) },
      { to: '911' },
      { to: '+19005550123' },
    ])
      await expect(service.sendSms({ ...request(), ...changed })).rejects.toBeInstanceOf(SmsError)
    expect(sendSms).not.toHaveBeenCalled()
    expect(await db.selectFrom('sms_deliveries').selectAll().execute()).toEqual([])
  })
  it('keeps daily budgets at 24 elapsed hours across both DST changes and kills calendar-day mutations', async () => {
    const source = await readFile(new URL('./sms-service.ts', import.meta.url), 'utf8')
    for (const example of [
      { now: '2026-03-08T16:00:00Z', ageHours: 23.5, limited: true },
      { now: '2026-11-01T17:00:00Z', ageHours: 24.5, limited: false },
    ]) {
      for (const field of ['recipientPerDay', 'organizationPerDay'] as const) {
        await db.connection().execute(async (connection) => {
          await sql`SET TIME ZONE 'America/New_York'`.execute(connection)
          try {
            for (const mutated of [false, true, false]) {
              await connection.deleteFrom('sms_deliveries').execute()
              const input = request()
              await createSmsService({
                db: connection,
                hashSecret: secret,
                limits: roomy,
                provider: { sendSms: async () => ({ providerMessageId: 'SMsynthetic' }) },
              }).sendSms(input)
              await connection
                .updateTable('sms_deliveries')
                .set({
                  created_at: new Date(Date.parse(example.now) - example.ageHours * 3_600_000),
                })
                .execute()
              const fixed = source.replaceAll('clock_timestamp()', `TIMESTAMPTZ '${example.now}'`)
              const { file, cleanup } = await sourceCopy(
                mutated ? fixed.replace("interval '24 hours'", "interval '1 day'") : fixed,
              )
              try {
                const module: typeof import('./sms-service.ts') = await import(file.href)
                const service = module.createSmsService({
                  db: connection,
                  hashSecret: secret,
                  limits: { ...roomy, [field]: 1 },
                  provider: { sendSms: async () => ({ providerMessageId: 'SMsynthetic' }) },
                })
                const verify = async () => {
                  const sending = service.sendSms({ ...input, idempotencyKey: randomUUID() })
                  if (example.limited)
                    await expect(sending).rejects.toMatchObject({ code: 'sms_rate_limited' })
                  else await expect(sending).resolves.toEqual({ providerMessageId: 'SMsynthetic' })
                }
                if (mutated)
                  await expect(verify()).rejects.toMatchObject({ name: 'AssertionError' })
                else await verify()
              } finally {
                await cleanup()
              }
            }
          } finally {
            await sql`RESET TIME ZONE`.execute(connection)
          }
        })
      }
    }
  })
  it('retains details for exactly 720 elapsed hours across DST and kills calendar-month-span mutations', async () => {
    const source = await readFile(new URL('./sms-service.ts', import.meta.url), 'utf8')
    for (const example of [
      { now: '2026-03-20T16:00:00Z', ageHours: 719.5, status: 'accepted' },
      { now: '2026-11-20T17:00:00Z', ageHours: 720.5, status: 'expired' },
    ]) {
      await db.connection().execute(async (connection) => {
        await sql`SET TIME ZONE 'America/New_York'`.execute(connection)
        try {
          for (const mutated of [false, true, false]) {
            await connection.deleteFrom('sms_deliveries').execute()
            await createSmsService({
              db: connection,
              hashSecret: secret,
              limits: roomy,
              provider: { sendSms: async () => ({ providerMessageId: 'SMsynthetic' }) },
            }).sendSms(request())
            await connection
              .updateTable('sms_deliveries')
              .set({ created_at: new Date(Date.parse(example.now) - example.ageHours * 3_600_000) })
              .execute()
            const fixed = source.replaceAll('clock_timestamp()', `TIMESTAMPTZ '${example.now}'`)
            const { file, cleanup } = await sourceCopy(
              mutated ? fixed.replace("interval '720 hours'", "interval '30 days'") : fixed,
            )
            try {
              const module: typeof import('./sms-service.ts') = await import(file.href)
              const verify = async () => {
                await module.purgeSmsDeliveryDetails(connection)
                expect(
                  (
                    await connection
                      .selectFrom('sms_deliveries')
                      .select('status')
                      .executeTakeFirstOrThrow()
                  ).status,
                ).toBe(example.status)
              }
              if (mutated) await expect(verify()).rejects.toMatchObject({ name: 'AssertionError' })
              else await verify()
            } finally {
              await cleanup()
            }
          }
        } finally {
          await sql`RESET TIME ZONE`.execute(connection)
        }
      })
    }
  })
  it('kills source-copy mutations of each durable protection and passes restored controls', async () => {
    const source = await readFile(new URL('./sms-service.ts', import.meta.url), 'utf8')
    type ServiceModule = typeof import('./sms-service.ts')
    type Check = (module: ServiceModule) => Promise<void>
    const make = (
      module: ServiceModule,
      limits: Partial<SmsLimits> = roomy,
      provider?: SmsProvider,
    ) =>
      module.createSmsService({
        db,
        hashSecret: secret,
        limits,
        provider: provider ?? { sendSms: async () => ({ providerMessageId: 'SMsynthetic' }) },
      })
    const mutations: [string, string, Check][] = []
    for (const [field, column] of [
      ['recipientPerHour', 'recipient_hour'],
      ['recipientPerDay', 'recipient_day'],
      ['instancePerHour', 'instance_hour'],
      ['organizationPerDay', 'organization_day'],
    ] as const) {
      mutations.push([
        `count.${column} >= limits.${field}`,
        'false',
        async (module) => {
          const service = make(module, { ...roomy, [field]: 1 })
          const input = request()
          await service.sendSms(input)
          await expect(
            service.sendSms({ ...input, idempotencyKey: randomUUID() }),
          ).rejects.toMatchObject({ code: 'sms_rate_limited' })
        },
      ])
    }
    mutations.push(
      [
        'const to = normalizeSmsDestination(input.to)',
        'const to = normalizeSmsDestination(input.to); console.info(to, input.body)',
        async (module) => verifyLogs(module.createSmsService),
      ],
      [
        "digest(deps.hashSecret, 'job', input.idempotencyKey)",
        "digest('wrong-secret', 'job', input.idempotencyKey)",
        async (module) => {
          const input = request()
          await make(module).sendSms(input)
          const row = await db.selectFrom('sms_deliveries').selectAll().executeTakeFirstOrThrow()
          expect(row.key_hash).toEqual(
            createHmac('sha256', secret)
              .update('hourmere/sms/job/v1\0')
              .update(input.idempotencyKey)
              .digest(),
          )
        },
      ],
      [
        'if ((remaining.rows[0]?.seconds ?? 1) > 0)',
        'if (false)',
        async (module) => verifyRetry(module.createSmsService),
      ],
      [
        'created_at: sql`clock_timestamp()`,',
        'created_at: sql`created_at`,',
        async (module) => verifyRetry(module.createSmsService, true),
      ],
      [
        "status NOT IN ('expired','rate_limited')",
        "status <> 'expired'",
        async (module) => verifyRetry(module.createSmsService),
      ],
      [
        'Math.min(3600, Math.max(1, Math.ceil(requestedDelay as number)))',
        'Math.ceil(requestedDelay as number)',
        async (module) => {
          await expect(
            make(module, roomy, {
              sendSms: async () => {
                throw new SmsError('sms_rate_limited', { retryAfterSeconds: 9000 })
              },
            }).sendSms(request()),
          ).rejects.toMatchObject({ retryAfterSeconds: 3600 })
        },
      ],
      [
        "if (existing.status === 'failed') throw new SmsError('sms_provider_rejected')",
        "if (false) throw new SmsError('sms_provider_rejected')",
        async (module) => {
          const service = make(module, roomy, {
            sendSms: async () => {
              throw new SmsError('sms_provider_rejected')
            },
          })
          const input = request()
          await expect(service.sendSms(input)).rejects.toMatchObject({
            code: 'sms_provider_rejected',
          })
          await expect(service.sendSms(input)).rejects.toMatchObject({
            code: 'sms_provider_rejected',
          })
        },
      ],
      [
        "createHmac('sha256', secret)",
        "createHmac('sha256', 'wrong-secret')",
        async (module) => {
          const input = request()
          await make(module).sendSms(input)
          const row = await db.selectFrom('sms_deliveries').selectAll().executeTakeFirstOrThrow()
          const expected = createHmac('sha256', secret)
            .update('hourmere/sms/recipient/v1\0')
            .update(input.to)
            .digest()
          expect(row.recipient_hash).toEqual(expected)
        },
      ],
      [
        'const reservation = await deps.db.transaction()',
        'await deps.provider.sendSms(input); const reservation = await deps.db.transaction()',
        async (module) => {
          const service = make(module, roomy, {
            sendSms: async () => {
              expect((await owned.pool.query('SELECT status FROM sms_deliveries')).rows).toEqual([
                { status: 'dispatching' },
              ])
              return { providerMessageId: 'SMsynthetic' }
            },
          })
          await service.sendSms(request())
        },
      ],
      [
        "if (!deps.provider) throw new SmsError('sms_not_configured')",
        "if (!deps.provider) return {providerMessageId:'disabled'}",
        async (module) => {
          await expect(
            module.createSmsService({ db, hashSecret: secret }).sendSms(request()),
          ).rejects.toMatchObject({ code: 'sms_not_configured' })
        },
      ],
      [
        'return existing.provider_message_id',
        "throw new SmsError('sms_delivery_unknown')",
        async (module) => {
          const service = make(module)
          const input = request()
          await service.sendSms(input)
          await expect(service.sendSms(input)).resolves.toEqual({
            providerMessageId: 'SMsynthetic',
          })
        },
      ],
      [
        'existing.request_hash && !existing.request_hash.equals(request)',
        'false',
        async (module) => {
          const service = make(module)
          const input = request()
          await service.sendSms(input)
          await expect(service.sendSms({ ...input, body: 'Changed' })).rejects.toMatchObject({
            code: 'sms_idempotency_conflict',
          })
        },
      ],
      [
        'if (existing) {',
        "if (existing && existing.status !== 'dispatching') {",
        async (module) => {
          const service = make(module)
          const input = request()
          await service.sendSms(input)
          await db
            .updateTable('sms_deliveries')
            .set({ status: 'dispatching', provider_message_id: null })
            .execute()
          await expect(service.sendSms(input)).rejects.toMatchObject({
            code: 'sms_delivery_unknown',
          })
        },
      ],
      [
        "throw error instanceof SmsError ? error : new SmsError('sms_delivery_unknown')",
        'throw error',
        async (module) => {
          const service = make(module, roomy, {
            sendSms: async () => {
              throw new Error('private provider body')
            },
          })
          await expect(service.sendSms(request())).rejects.toMatchObject({
            message: 'sms_delivery_unknown',
          })
        },
      ],
      [
        "interval '720 hours'",
        "interval '7200 hours'",
        async (module) => {
          const service = make(module)
          await service.sendSms(request())
          await db
            .updateTable('sms_deliveries')
            .set({ created_at: sql`clock_timestamp()-interval '31 days'` })
            .execute()
          await module.purgeSmsDeliveryDetails(db)
          expect(
            (await db.selectFrom('sms_deliveries').selectAll().executeTakeFirstOrThrow())
              .recipient_hash,
          ).toBeNull()
        },
      ],
      [
        'SELECT pg_advisory_xact_lock(1852798057, 1936552802)',
        'SELECT 1',
        async (module) => {
          // Hold the real database fence until the sender is observably waiting on it.
          // This tests synchronization without hoping concurrent queries happen to overlap.
          const blocker = await owned.pool.connect()
          const sendSms = vi.fn(async () => ({ providerMessageId: 'SMsynthetic' }))
          let sending: Promise<unknown> | undefined
          let completed = false
          let observedWaiter = false
          try {
            await blocker.query('SELECT pg_advisory_lock(1852798057, 1936552802)')
            const service = make(module, roomy, { sendSms })
            sending = service.sendSms(request()).finally(() => {
              completed = true
            })
            // Attach a rejection handler immediately, then inspect its result after release.
            const settled = Promise.allSettled([sending])
            sending = settled
            await vi.waitFor(
              async () => {
                const { rows } = await blocker.query(`SELECT 1 FROM pg_locks
                WHERE locktype='advisory' AND classid=1852798057 AND objid=1936552802
                  AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
                  AND NOT granted`)
                observedWaiter = rows.length > 0
                expect(observedWaiter || completed).toBe(true)
              },
              { timeout: 10_000, interval: 10 },
            )
            expect(observedWaiter, 'sender must wait for the held database fence').toBe(true)
            expect(sendSms).not.toHaveBeenCalled()
          } finally {
            let unlocked = false
            try {
              await blocker.query('SELECT pg_advisory_unlock(1852798057, 1936552802)')
              unlocked = true
            } finally {
              // Destroy the connection on unlock failure so its session lock cannot survive.
              blocker.release(!unlocked)
              await sending
            }
          }
          expect(await sending).toEqual([
            { status: 'fulfilled', value: { providerMessageId: 'SMsynthetic' } },
          ])
          expect(sendSms).toHaveBeenCalledTimes(1)
        },
      ],
    )
    const purgeStatement = source.match(
      /await sql`UPDATE sms_deliveries[\s\S]*?`\.execute\(db\)/,
    )?.[0]
    expect(purgeStatement).toBeDefined()
    mutations.push([
      purgeStatement as string,
      "await sql`DELETE FROM sms_deliveries WHERE created_at < clock_timestamp()-interval '720 hours'`.execute(db)",
      async (module) => {
        const service = make(module)
        const input = request()
        await service.sendSms(input)
        await db
          .updateTable('sms_deliveries')
          .set({ created_at: sql`clock_timestamp()-interval '31 days'` })
          .execute()
        await module.purgeSmsDeliveryDetails(db)
        await expect(service.sendSms(input)).rejects.toMatchObject({ code: 'sms_delivery_unknown' })
      },
    ])
    for (const [before, after, verify] of mutations) {
      expect(source).toContain(before)
      for (const mutated of [false, true, false]) {
        await db.deleteFrom('sms_deliveries').execute()
        const { file, cleanup } = await sourceCopy(mutated ? source.replace(before, after) : source)
        try {
          const module = await import(file.href)
          if (mutated) {
            let failure: unknown
            try {
              await verify(module)
            } catch (error) {
              failure = error
            }
            expect(
              failure,
              `Mutation must fail a real assertion: ${before} -> ${after}`,
            ).toMatchObject({ name: 'AssertionError' })
          } else await verify(module)
        } finally {
          await cleanup()
        }
      }
    }
  }, 60_000)
})
