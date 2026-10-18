import { createDb, type Db } from '@hourmere/db'
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { DomainError } from '@hourmere/scheduling/errors'
import { createTestTeam, createTestUser, testContext } from '@hourmere/scheduling/testing'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWebhook, deleteWebhook, rotateWebhookSecret, updateWebhook } from './service.ts'

const serverUrl = process.env.DATABASE_URL
const settings = { enabled: true, encryptionKey: Buffer.alloc(32, 7).toString('base64') }
const operations = ['create', 'update', 'rotate', 'delete'] as const
const revocations = ['demotion', 'removal', 'unverified'] as const
type Operation = (typeof operations)[number]
type Revocation = (typeof revocations)[number]
const BARRIER = 4_708_119

describe.skipIf(!serverUrl)('webhook mutation authorization linearization', () => {
  let owned: TestDatabase
  let db: Db
  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string)
    db = createDb(owned.pool)
    // A test-only write barrier runs AFTER the service's authorization locks, so a
    // separate connection can prove revocation waits through the actual mutation.
    await owned.pool.query(`
      CREATE FUNCTION webhook_test_write_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${BARRIER});
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER webhook_test_write_barrier BEFORE INSERT OR UPDATE OR DELETE ON webhooks
        FOR EACH ROW EXECUTE FUNCTION webhook_test_write_barrier();
    `)
  })
  afterAll(async () => {
    await owned?.drop()
  })

  async function fixture(personal = false) {
    const owner = await createTestUser(db)
    const admin = personal ? owner : await createTestUser(db)
    const team = personal
      ? { id: owner.principal.organization.id, as: (member: typeof owner) => member.principal }
      : await createTestTeam(db, [
          { user: owner, role: 'owner' },
          { user: admin, role: 'admin' },
        ])
    const ctx = testContext(db, team.as(admin))
    const { webhook } = await createWebhook(testContext(db, team.as(owner)), settings, {
      url: 'https://hooks.example.com/',
      events: ['booking.created'],
    })
    const before = await db
      .selectFrom('webhooks')
      .select('secret_ciphertext')
      .where('id', '=', webhook.id)
      .executeTakeFirstOrThrow()
    return { admin, team, ctx, webhook, before }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>

  function run(operation: Operation, f: Fixture) {
    const change =
      operation === 'create'
        ? createWebhook(f.ctx, settings, {
            url: 'https://hooks.example.com/new',
            events: ['booking.created'],
          })
        : operation === 'update'
          ? updateWebhook(f.ctx, f.webhook.id, { isActive: false })
          : operation === 'rotate'
            ? rotateWebhookSecret(f.ctx, settings, f.webhook.id)
            : deleteWebhook(f.ctx, f.webhook.id)
    return change.then(
      (result) => ({
        ok: true,
        code: null,
        secretReturned:
          typeof result === 'object' &&
          result !== null &&
          'secret' in result &&
          typeof result.secret === 'string',
      }),
      (error: unknown) => ({
        ok: false,
        secretReturned: false,
        code: error instanceof DomainError ? error.code : 'unexpected_error',
      }),
    )
  }
  function revoke(client: PoolClient, kind: Revocation, f: Fixture) {
    return kind === 'demotion'
      ? client.query('UPDATE auth.member SET role=$1 WHERE "organizationId"=$2 AND "userId"=$3', [
          'member',
          f.team.id,
          f.admin.id,
        ])
      : kind === 'removal'
        ? client.query('DELETE FROM auth.member WHERE "organizationId"=$1 AND "userId"=$2', [
            f.team.id,
            f.admin.id,
          ])
        : client.query('UPDATE auth."user" SET "emailVerified"=false WHERE id=$1', [f.admin.id])
  }
  async function pid(client: PoolClient) {
    return (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]
      ?.pid as number
  }
  async function blockedBy(blocker: number, waiting?: number) {
    let blockedPid = 0
    await vi.waitFor(
      async () => {
        const { rows } = await owned.pool.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) AND ($2::int IS NULL OR pid=$2)',
          [blocker, waiting ?? null],
        )
        expect(rows.length > 0).toBe(true)
        blockedPid = rows[0]?.pid ?? 0
      },
      { timeout: 3000, interval: 10 },
    )
    return blockedPid
  }
  async function unchanged(f: Fixture) {
    const row = await db
      .selectFrom('webhooks')
      .select(['is_active', 'secret_ciphertext'])
      .where('id', '=', f.webhook.id)
      .executeTakeFirstOrThrow()
    expect(row.is_active).toBe(true)
    expect(row.secret_ciphertext.equals(f.before.secret_ciphertext)).toBe(true)
    expect(
      await db
        .selectFrom('webhooks')
        .select('id')
        .where('organization_id', '=', f.team.id)
        .execute(),
    ).toHaveLength(1)
  }

  for (const operation of operations) {
    it.each(revocations)(
      `${operation}: refuses when %s commits before its authorization lock`,
      async (kind) => {
        const f = await fixture()
        const holder = await owned.pool.connect()
        const revoker = await owned.pool.connect()
        let mutation: ReturnType<typeof run> | undefined
        try {
          await holder.query('BEGIN')
          if (kind === 'unverified')
            await holder.query('SELECT id FROM auth."user" WHERE id=$1 FOR UPDATE', [f.admin.id])
          else if (operation === 'create')
            await holder.query('SELECT id FROM auth.organization WHERE id=$1 FOR UPDATE', [
              f.team.id,
            ])
          else await holder.query('SELECT id FROM webhooks WHERE id=$1 FOR UPDATE', [f.webhook.id])
          mutation = run(operation, f)
          await blockedBy(await pid(holder))
          // Membership revocation is independent of the domain-lock holder. For email,
          // the user-row holder itself commits the change before its waiting reader.
          await revoke(kind === 'unverified' ? holder : revoker, kind, f)
          await holder.query('COMMIT')
          expect(await mutation).toEqual({
            ok: false,
            code: 'insufficient_role',
            secretReturned: false,
          })
          await unchanged(f)
        } finally {
          await holder.query('ROLLBACK')
          holder.release()
          revoker.release()
          await mutation
        }
      },
    )

    it.each(revocations)(
      `${operation}: holds %s until an already-authorized mutation commits`,
      async (kind) => {
        const f = await fixture()
        const holder = await owned.pool.connect()
        const revoker = await owned.pool.connect()
        let mutation: ReturnType<typeof run> | undefined
        let revoked: ReturnType<typeof revoke> | undefined
        try {
          await holder.query('BEGIN')
          await holder.query('SELECT pg_advisory_xact_lock($1)', [BARRIER])
          mutation = run(operation, f)
          const mutationPid = await blockedBy(await pid(holder))
          const revokerPid = await pid(revoker)
          revoked = revoke(revoker, kind, f)
          await blockedBy(mutationPid, revokerPid)
          await holder.query('COMMIT')
          expect(await mutation).toEqual({
            ok: true,
            code: null,
            secretReturned: operation === 'create' || operation === 'rotate',
          })
          await revoked
          const current = await db
            .selectFrom('auth.member as m')
            .innerJoin('auth.user as u', 'u.id', 'm.userId')
            .select(['m.role', 'u.emailVerified'])
            .where('m.organizationId', '=', f.team.id)
            .where('m.userId', '=', f.admin.id)
            .executeTakeFirst()
          expect(
            kind === 'removal'
              ? current === undefined
              : kind === 'demotion'
                ? current?.role === 'member'
                : current?.emailVerified === false,
          ).toBe(true)
        } finally {
          await holder.query('ROLLBACK')
          holder.release()
          await mutation
          await revoked
          revoker.release()
        }
      },
    )
  }

  for (const personal of [false, true]) {
    it.each(['organization', 'user'] as const)(
      `does not invert %s deletion while waiting for a parent (personal=${personal})`,
      async (target) => {
        const f = await fixture(personal)
        const holder = await owned.pool.connect()
        let mutation: ReturnType<typeof run> | undefined
        try {
          await holder.query('BEGIN')
          const table = target === 'user' ? 'auth."user"' : 'auth.organization'
          const id = target === 'user' ? f.admin.id : f.team.id
          await holder.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id])
          mutation = run('create', f)
          await blockedBy(await pid(holder))
          await holder.query(`DELETE FROM ${table} WHERE id=$1`, [id])
          await holder.query('COMMIT')
          expect(await mutation).toEqual({
            ok: false,
            code: 'insufficient_role',
            secretReturned: false,
          })
        } finally {
          await holder.query('ROLLBACK')
          holder.release()
          await mutation
        }
      },
    )

    it.each(['organization', 'user'] as const)(
      `lets an authorized mutation finish before %s deletion cascades (personal=${personal})`,
      async (target) => {
        const f = await fixture(personal)
        const holder = await owned.pool.connect()
        const remover = await owned.pool.connect()
        let mutation: ReturnType<typeof run> | undefined
        let removed: Promise<unknown> | undefined
        try {
          await holder.query('BEGIN')
          await holder.query('SELECT pg_advisory_xact_lock($1)', [BARRIER])
          mutation = run('update', f)
          const mutationPid = await blockedBy(await pid(holder))
          const table = target === 'user' ? 'auth."user"' : 'auth.organization'
          const removerPid = await pid(remover)
          removed = remover.query(`DELETE FROM ${table} WHERE id=$1`, [
            target === 'user' ? f.admin.id : f.team.id,
          ])
          await blockedBy(mutationPid, removerPid)
          await holder.query('COMMIT')
          expect((await mutation).ok).toBe(true)
          await removed
        } finally {
          await holder.query('ROLLBACK')
          holder.release()
          await mutation
          await removed
          remover.release()
        }
      },
    )
  }
})
