import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { claimedDomainValues, ssoFixture } from '../../../packages/db/src/sso-storage-fixtures.ts'
import {
  recheckSsoDomains,
  SSO_DOMAIN_RECHECK_BATCH,
  ssoDomainRecheckJob,
} from './sso-domain-recheck.ts'
import { ssoDomainChallengeDigest } from './sso-domains.ts'

const publicUrl = 'https://hourmere.example.com'
const ON = { ssoOidcEnabled: true, ssoSamlEnabled: false }
const OFF = { ssoOidcEnabled: false, ssoSamlEnabled: false }
let owned: TestDatabase
let db: Db
let team: string
let current: string
const resolveTxt = vi.fn<(name: string) => Promise<string[][]>>()
const deps = () => ({ db, publicUrl, capabilities: ON, resolveTxt, now: async () => current })
const advance = (days: number) => {
  current = new Date(Date.parse(current) + days * 86400000).toISOString()
}
async function claim() {
  const name = `${randomUUID()}.example.com`
  const value = `hourmere-sso=${randomUUID()}`
  const row = await db
    .insertInto('sso_domains')
    .values({
      ...claimedDomainValues(team, name),
      challenge_digest: ssoDomainChallengeDigest(
        { publicUrl },
        { name, organization_id: team, generation: 1 },
        value,
      ),
      next_check_at: current,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  return { row, value }
}
const stored = (id: string) =>
  db.selectFrom('sso_domains').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
const events = (id: string) =>
  db.selectFrom('audit_events').selectAll().where('target_id', '=', id).orderBy('id').execute()

it('never schedules or accesses storage/DNS while hard-off, including queued replay', async () => {
  const options = {
    db: new Proxy({} as Db, {
      get: () => {
        throw new Error('storage accessed')
      },
    }),
    publicUrl,
    capabilities: OFF,
    resolveTxt,
  }
  expect(ssoDomainRecheckJob(options).schedule).toBeUndefined()
  expect(ssoDomainRecheckJob({ ...options, capabilities: ON }).schedule).toEqual({
    cron: '*/5 * * * *',
    payload: {},
  })
  expect(await recheckSsoDomains(options)).toBe(0)
  expect(resolveTxt).not.toHaveBeenCalled()
  // A setting turned off keeps the worker scheduled and running, so verification stays current.
  const settingOff = { ...options, capabilities: { ...OFF, ssoOperatorSetting: true } }
  expect(ssoDomainRecheckJob(settingOff).schedule).toEqual({ cron: '*/5 * * * *', payload: {} })
  await expect(recheckSsoDomains(settingOff)).rejects.toThrow('storage accessed')
  const server = await readFile(new URL('./server.ts', import.meta.url), 'utf8')
  // The running server always passes its operator setting, so the schedule stays on.
  expect(server).toContain('...(ssoRetained(sso) ? [] : [SSO_DOMAIN_RECHECK_JOB])')
  expect(server).toContain('ssoDomainRecheckJob({')
})

describe.skipIf(!process.env.DATABASE_URL)('periodic SSO domain authority', () => {
  beforeAll(async () => {
    owned = await createTestDatabase(process.env.DATABASE_URL as string)
    db = createDb(owned.pool)
    const client = await owned.pool.connect()
    try {
      await client.query('BEGIN')
      team = (await ssoFixture(client)).team
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })
  afterAll(async () => {
    await owned?.drop()
  })
  afterEach(async () => {
    vi.useRealTimers()
    resolveTxt.mockReset()
    await db
      .updateTable('sso_domains')
      .set({ next_check_at: null })
      .where('retired_at', 'is', null)
      .execute()
  })
  const reset = async () => {
    current = (await owned.pool.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString()
    resolveTxt.mockReset()
  }

  it('renews the current generation and audits a redacted system outcome once under replay', async () => {
    await reset()
    const { row, value } = await claim()
    resolveTxt.mockResolvedValue([[value.slice(0, 8), value.slice(8)]])
    expect(await recheckSsoDomains(deps())).toBe(1)
    const result = await stored(row.id)
    expect(result).toMatchObject({
      generation: row.generation,
      verified_at: row.verified_at,
      last_check_outcome: 'positive',
      retired_at: null,
    })
    expect(new Date(result.verification_expires_at as Date).getTime()).toBe(
      Date.parse(current) + 7 * 86400000,
    )
    expect(await recheckSsoDomains(deps())).toBe(0)
    expect(resolveTxt).toHaveBeenCalledExactlyOnceWith(`_hourmere-sso.${row.name}`)
    const audit = await events(row.id)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      actor_type: 'system',
      action: 'sso_domain.renewed',
      details: { outcome: 'passed' },
    })
    expect(JSON.stringify(audit)).not.toContain(value)
    expect(JSON.stringify(audit)).not.toContain(row.name)
  })

  it('freezes on failure or unknown, retries daily without extending expiry and recovers inside the remaining lifetime', async () => {
    await reset()
    const { row, value } = await claim()
    resolveTxt.mockResolvedValue([])
    await recheckSsoDomains(deps())
    expect(await stored(row.id)).toMatchObject({
      last_check_outcome: 'failed',
      verification_expires_at: row.verification_expires_at,
    })
    expect(await recheckSsoDomains(deps())).toBe(0)
    advance(1)
    resolveTxt.mockRejectedValue(new Error('private resolver detail'))
    await recheckSsoDomains(deps())
    expect(await stored(row.id)).toMatchObject({
      last_check_outcome: 'unknown',
      verification_expires_at: row.verification_expires_at,
    })
    advance(1)
    resolveTxt.mockResolvedValue([[value]])
    await recheckSsoDomains(deps())
    expect(await stored(row.id)).toMatchObject({
      last_check_outcome: 'positive',
      generation: 1,
      retired_at: null,
    })
    expect((await events(row.id)).map((e) => e.details)).toEqual([
      { outcome: 'failed' },
      { outcome: 'unknown' },
      { outcome: 'passed' },
    ])
  })

  it('suspends at the exact expiry boundary without DNS, retirement or enforcement changes', async () => {
    await reset()
    const { row } = await claim()
    current = new Date(row.verification_expires_at as Date).toISOString()
    await db
      .insertInto('sso_policies')
      .values({ organization_id: team, require_sso: true })
      .execute()
    const memberships = await db.selectFrom('auth.member').selectAll().orderBy('id').execute()
    expect(await recheckSsoDomains(deps())).toBe(1)
    expect(await stored(row.id)).toMatchObject({
      retired_at: null,
      claimed_at: row.claimed_at,
      next_check_at: null,
      verification_expires_at: row.verification_expires_at,
    })
    expect(resolveTxt).not.toHaveBeenCalled()
    expect(
      await db
        .selectFrom('sso_policies')
        .selectAll()
        .where('organization_id', '=', team)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ require_sso: true, trust_generation: 1 })
    expect(await recheckSsoDomains(deps())).toBe(0)
    expect((await events(row.id)).map((e) => e.action)).toEqual(['sso_domain.expired'])
    expect(await db.selectFrom('auth.member').selectAll().orderBy('id').execute()).toEqual(
      memberships,
    )
  })

  it('does not revive authority when a matching DNS lookup crosses expiry', async () => {
    await reset()
    const { row, value } = await claim()
    resolveTxt.mockImplementation(async () => {
      current = new Date(row.verification_expires_at as Date).toISOString()
      return [[value]]
    })
    await recheckSsoDomains(deps())
    expect(await stored(row.id)).toMatchObject({
      verification_expires_at: row.verification_expires_at,
      next_check_at: null,
    })
    expect((await events(row.id)).map((e) => e.action)).toEqual(['sso_domain.expired'])
  })

  it('bounds stalled injected DNS and records unknown without exposing its error', async () => {
    await reset()
    const { row } = await claim()
    const entered = Promise.withResolvers<void>()
    resolveTxt.mockImplementation(() => {
      entered.resolve()
      return new Promise(() => {})
    })
    vi.useFakeTimers()
    const checking = recheckSsoDomains(deps())
    await entered.promise
    await vi.advanceTimersByTimeAsync(5000)
    expect(await checking).toBe(1)
    expect(await stored(row.id)).toMatchObject({
      last_check_outcome: 'unknown',
      verification_expires_at: row.verification_expires_at,
    })
    expect((await events(row.id)).map((e) => e.details)).toEqual([{ outcome: 'unknown' }])
    vi.useRealTimers()
  })

  it('two workers racing never query the same domain concurrently', async () => {
    await reset()
    const { row, value } = await claim()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    resolveTxt.mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return [[value]]
    })
    const first = recheckSsoDomains(deps())
    await entered.promise
    try {
      expect(await recheckSsoDomains(deps())).toBe(0)
    } finally {
      release.resolve()
    }
    expect(await first).toBe(1)
    expect(resolveTxt).toHaveBeenCalledOnce()
    expect(await events(row.id)).toHaveLength(1)
  })

  it('bounds each dispatch and ignores retired and not-yet-due claims', async () => {
    await reset()
    const future = await claim()
    await db
      .updateTable('sso_domains')
      .set({ next_check_at: new Date(Date.parse(current) + 86400000).toISOString() })
      .where('id', '=', future.row.id)
      .execute()
    const retired = await claim()
    await db
      .updateTable('sso_domains')
      .set({ retired_at: current })
      .where('id', '=', retired.row.id)
      .execute()
    for (let n = 0; n < SSO_DOMAIN_RECHECK_BATCH + 2; n++) await claim()
    resolveTxt.mockResolvedValue([])
    expect(await recheckSsoDomains(deps())).toBe(SSO_DOMAIN_RECHECK_BATCH)
    expect(resolveTxt).toHaveBeenCalledTimes(SSO_DOMAIN_RECHECK_BATCH)
    expect(await recheckSsoDomains(deps())).toBe(2)
    expect(await recheckSsoDomains(deps())).toBe(0)
  })
})
