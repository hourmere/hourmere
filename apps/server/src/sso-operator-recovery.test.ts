import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { createJobs } from '@hourmere/jobs'
import type { MailMessage } from '@hourmere/mail'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type SsoFixture, ssoFixture } from '../../../packages/db/src/sso-storage-fixtures.ts'
import { disableSsoEnforcement, ssoOperatorRecoveryEmailJob } from './sso-operator-recovery.ts'

const script = fileURLToPath(new URL('./sso-operator-recovery-cli.ts', import.meta.url))
const execute = promisify(execFile)
const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('SSO operator recovery maintenance', () => {
  let owned: TestDatabase
  let db: Db
  let fixture: SsoFixture
  const sent: MailMessage[] = []
  let worker: ReturnType<typeof createJobs<[ReturnType<typeof ssoOperatorRecoveryEmailJob>]>>

  beforeAll(async () => {
    owned = await createTestDatabase(databaseUrl as string, undefined, { tag: 'sso_operator' })
    db = createDb(owned.pool)
    const client = await owned.pool.connect()
    try {
      fixture = await ssoFixture(client)
    } finally {
      client.release()
    }
    await db
      .insertInto('sso_policies')
      .values([
        {
          organization_id: fixture.team,
          require_sso: true,
          admission: 'jit',
          policy_revision: 7,
          trust_generation: 4,
        },
        { organization_id: fixture.otherTeam, require_sso: true },
      ])
      .execute()
    worker = createJobs({
      connectionString: owned.url,
      definitions: [
        ssoOperatorRecoveryEmailJob(db, { send: async (message) => void sent.push(message) }),
      ],
      migrate: true,
      work: true,
      pollingIntervalSeconds: 0.5,
    })
    await worker.start()
  }, 60_000)

  afterAll(async () => {
    try {
      await worker?.stop()
    } finally {
      await owned?.drop()
    }
  })

  const run = (team: string, container = '1') =>
    execute(process.execPath, [script, team], {
      env: {
        ...process.env,
        DATABASE_URL: owned.url,
        HOURMERE_SERVER_CONTAINER: container,
      },
    })

  it('refuses an unknown team and personal organizations with a non-zero exit', async () => {
    for (const id of [randomUUID(), fixture.personal]) {
      await expect(run(id)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Unknown team'),
      })
    }
    await expect(run(fixture.team, '')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('inside the Hourmere server container'),
    })
  })

  it('turns off only the requested team and durably queues one localized notice per owner', async () => {
    await db
      .insertInto('profiles')
      .values({
        user_id: fixture.coOwner,
        handle: 'recovery-owner',
        time_zone: 'UTC',
        locale: 'zh-CN',
      })
      .execute()
    const policies = () =>
      db.selectFrom('sso_policies').selectAll().orderBy('organization_id').execute()
    const before = await policies()
    const audit = () =>
      db
        .selectFrom('audit_events')
        .select([
          'organization_id',
          'actor_type',
          'actor_id',
          'credential_type',
          'target_type',
          'target_id',
          'details',
        ])
        .where('action', '=', 'sso_maintenance.enforcement_disabled')
        .execute()
    const notices = async () =>
      (
        await sql<{ count: number }>`SELECT count(*)::int AS count
      FROM pgboss.job WHERE name = 'sso-operator-recovery-email'`.execute(db)
      ).rows[0]?.count

    await expect(run(fixture.team)).resolves.toMatchObject({
      stdout: expect.stringContaining('SSO enforcement disabled'),
    })
    expect(await policies()).toEqual(
      before.map((row) =>
        row.organization_id === fixture.team
          ? { ...row, require_sso: false, policy_revision: 8, trust_generation: 5 }
          : row,
      ),
    )
    const event = {
      organization_id: fixture.team,
      actor_type: 'system',
      actor_id: 'sso-operator-recovery',
      credential_type: 'none',
      target_type: 'organization',
      target_id: fixture.team,
      details: { revision: 8 },
    }
    expect(await audit()).toEqual([event])
    await expect(run(fixture.team)).resolves.toMatchObject({
      stdout: expect.stringContaining('already off. No changes made'),
    })
    expect(await audit()).toEqual([event])
    expect(await notices()).toBe(2)

    const emails = await db
      .selectFrom('auth.user')
      .select(['id', 'email'])
      .where('id', 'in', [fixture.owner, fixture.coOwner])
      .execute()
    await vi.waitFor(() => expect(sent).toHaveLength(2), { timeout: 5_000 })
    expect(sent).toEqual(
      expect.arrayContaining(
        emails.map(({ id, email }) =>
          expect.objectContaining({
            to: email,
            sensitive: true,
            subject:
              id === fixture.coOwner
                ? '运维人员已关闭强制单点登录'
                : 'An operator turned off single sign-on enforcement',
          }),
        ),
      ),
    )
  })

  it('rolls back the enforcement change and audit if a notice fails to queue', async () => {
    const organizationId = fixture.otherTeam
    const getPolicy = () =>
      db
        .selectFrom('sso_policies')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .executeTakeFirst()
    const before = await getPolicy()
    expect(before?.require_sso).toBe(true)
    await expect(
      disableSsoEnforcement(db, { enqueue: async () => null }, organizationId),
    ).rejects.toThrow('could not be queued')
    expect(await getPolicy()).toEqual(before)
    expect(
      await db
        .selectFrom('audit_events')
        .select('id')
        .where('organization_id', '=', organizationId)
        .execute(),
    ).toEqual([])
  })

  it('leaves a notice retryable when SMTP is unavailable', async () => {
    const job = ssoOperatorRecoveryEmailJob(db, undefined)
    await expect(
      job.handler(
        { organizationId: fixture.team, userId: fixture.owner, language: 'en' },
        { id: randomUUID(), attempt: 1, signal: new AbortController().signal },
      ),
    ).rejects.toThrow('SSO operator recovery email requires configured SMTP')
  })
})
