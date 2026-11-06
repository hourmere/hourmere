import { createHmac, randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { createDb, type Db } from '@hourmere/db'
import { sql } from 'kysely'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../../db/src/testing.ts'
import { SmsError, type SmsProvider } from './sms-provider.ts'
import { createSmsService, purgeSmsDeliveryDetails, type SmsLimits } from './sms-service.ts'

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
    new SmsError('sms_provider_unavailable', { retryAfterSeconds: 60 }),
    new Error('sensitive provider body'),
  ])('never retries a provider failure or ambiguous outcome %#', async (error) => {
    const sendSms = vi.fn(async () => {
      throw error
    })
    const { service } = setup(roomy, { sendSms })
    const input = request()
    await expect(service.sendSms(input)).rejects.toBeInstanceOf(SmsError)
    await expect(service.sendSms(input)).rejects.toMatchObject({ code: 'sms_delivery_unknown' })
    expect(sendSms).toHaveBeenCalledTimes(1)
  })
  it('retains crash reservations and secret-rotation deduplication', async () => {
    const { service, sendSms } = setup()
    const input = request()
    await service.sendSms(input)
    await db
      .updateTable('sms_deliveries')
      .set({ status: 'dispatching', provider_message_id: null })
      .execute()
    await expect(service.sendSms(input)).rejects.toMatchObject({ code: 'sms_delivery_unknown' })
    const rotated = createSmsService({ db, hashSecret: `new-${secret}`, provider: { sendSms } })
    await expect(rotated.sendSms(input)).rejects.toMatchObject({ code: 'sms_idempotency_conflict' })
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
              const file = new URL(`./sms-service.mutation-${randomUUID()}.ts`, import.meta.url)
              try {
                await writeFile(
                  file,
                  mutated ? fixed.replace("interval '24 hours'", "interval '1 day'") : fixed,
                )
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
                await unlink(file)
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
            const file = new URL(`./sms-service.mutation-${randomUUID()}.ts`, import.meta.url)
            try {
              await writeFile(
                file,
                mutated ? fixed.replace("interval '720 hours'", "interval '30 days'") : fixed,
              )
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
              await unlink(file)
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
        "createHmac('sha256', secret)",
        "createHash('sha256')",
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
        'SELECT pg_sleep(0.05)',
        async (module) => {
          const service = make(module, { ...roomy, instancePerHour: 1 })
          const results = await Promise.allSettled(
            Array.from({ length: 12 }, () => service.sendSms(request())),
          )
          expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
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
        const file = new URL(`./sms-service.mutation-${randomUUID()}.ts`, import.meta.url)
        try {
          await writeFile(file, mutated ? source.replace(before, after) : source)
          const module = await import(file.href)
          if (mutated)
            await expect(verify(module), before).rejects.toMatchObject({ name: 'AssertionError' })
          else await verify(module)
        } finally {
          await unlink(file)
        }
      }
    }
  }, 60_000)
})
