import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect } from 'vitest'

const transferTable = 'organization_ownership_transfers'
const budgetTable = 'organization_ownership_transfer_budgets'
const day = 24 * 60 * 60 * 1000

function insert(pool: pg.Pool, table: string, values: Record<string, unknown>) {
  const columns = Object.keys(values)
  return pool.query(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING *`,
    Object.values(values),
  )
}

async function needsColumns(
  pool: pg.Pool,
  table: string,
  values: Record<string, unknown>,
  columns = Object.keys(values),
) {
  for (const column of columns) {
    await expect(insert(pool, table, { ...values, [column]: null })).rejects.toMatchObject({
      code: '23502',
      table,
      column,
    })
  }
}

async function refuses(query: Promise<pg.QueryResult>, constraint: string, code = '23514') {
  await expect(query, constraint).rejects.toMatchObject({ code, constraint })
}

async function assertBudgets(pool: pg.Pool, organizationId: string, otherOrganizationId: string) {
  const values = { window_start: '2026-01-01T00:00:00Z', request_count: 1 }
  const initiate = { ...values, organization_id: organizationId, operation: 'initiate' }
  const addBudget = (overrides: Record<string, unknown>) =>
    insert(pool, budgetTable, { ...initiate, ...overrides })
  await needsColumns(pool, budgetTable, initiate, Object.keys(values))
  await refuses(
    addBudget({ organization_id: randomUUID() }),
    `${budgetTable}_organization_id_fkey`,
    '23503',
  )
  await refuses(addBudget({ operation: 'confirm' }), `${budgetTable}_operation`)
  await refuses(addBudget({ window_start: 'infinity' }), `${budgetTable}_window_start_check`)
  for (const request_count of [0, -1]) {
    await refuses(addBudget({ request_count }), `${budgetTable}_request_count_check`)
  }
  await expect(addBudget({})).resolves.toMatchObject({ rowCount: 1 })
  await expect(addBudget({ operation: 'revoke', request_count: 4 })).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(addBudget({ organization_id: otherOrganizationId })).resolves.toMatchObject({
    rowCount: 1,
  })
  await refuses(addBudget({ window_start: '2026-01-02T00:00:00Z' }), `${budgetTable}_pkey`, '23505')
  await expect(
    pool.query(
      `UPDATE organization_ownership_transfer_budgets SET window_start = $2, request_count = 1
       WHERE organization_id = $1 AND operation = 'initiate' RETURNING operation, request_count`,
      [organizationId, '2026-01-02T00:00:00Z'],
    ),
  ).resolves.toMatchObject({ rows: [{ operation: 'initiate', request_count: 1 }] })
  await expect(
    pool.query(
      `SELECT operation, request_count FROM organization_ownership_transfer_budgets
       WHERE organization_id = $1 ORDER BY operation`,
      [organizationId],
    ),
  ).resolves.toMatchObject({
    rows: [
      { operation: 'initiate', request_count: 1 },
      { operation: 'revoke', request_count: 4 },
    ],
  })
}

export async function assertOwnershipTransferStorageProtections(pool: pg.Pool) {
  const organizationId = randomUUID()
  const otherOrganizationId = randomUUID()
  const initiator = randomUUID()
  const recipient = randomUUID()
  const initiatorMembership = randomUUID()
  const recipientMembership = randomUUID()
  const otherInitiatorMembership = randomUUID()
  const otherRecipientMembership = randomUUID()
  const id = randomUUID()
  const otherId = randomUUID()
  await expect(
    pool.query(
      `INSERT INTO auth.organization (id, name, slug, "createdAt")
       SELECT id, 'Transfer fixture', id::text, now() FROM unnest($1::uuid[]) AS ids(id)`,
      [[organizationId, otherOrganizationId]],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })
  await expect(
    pool.query(
      `INSERT INTO auth."user" (id, name, email, "emailVerified")
       SELECT id, 'Transfer fixture', id::text || '@example.test', true
       FROM unnest($1::uuid[]) AS ids(id)`,
      [[initiator, recipient]],
    ),
  ).resolves.toMatchObject({ rowCount: 2 })
  await expect(
    pool.query(
      `INSERT INTO auth.member (id, "organizationId", "userId", role, "createdAt")
       VALUES ($1, $2, $3, 'owner', now()), ($4, $2, $5, 'member', now()),
              ($6, $7, $3, 'owner', now()), ($8, $7, $5, 'member', now())`,
      [
        initiatorMembership,
        organizationId,
        initiator,
        recipientMembership,
        recipient,
        otherInitiatorMembership,
        otherOrganizationId,
        otherRecipientMembership,
      ],
    ),
  ).resolves.toMatchObject({ rowCount: 4 })

  const { rows } = await pool.query<{ now_ms: string }>(
    `SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`,
  )
  const now = Number(rows[0]?.now_ms)
  const createdAt = new Date(now - 60_000)
  const expiresAt = new Date(createdAt.getTime() + day)
  const binding = {
    organization_id: organizationId,
    initiator_user_id: initiator,
    initiator_membership_id: initiatorMembership,
    target_user_id: recipient,
    target_membership_id: recipientMembership,
    created_at: createdAt,
    expires_at: expiresAt,
  }
  const offer = (overrides: Record<string, unknown> = {}) =>
    insert(pool, transferTable, { ...binding, ...overrides })
  const transition = (offerId: string, state: string, terminalAt: Date | null) =>
    pool.query(
      `UPDATE organization_ownership_transfers SET state = $2, terminal_at = $3 WHERE id = $1`,
      [offerId, state, terminalAt],
    )

  await needsColumns(pool, transferTable, { ...binding, state: 'pending' })
  await refuses(
    offer({ organization_id: randomUUID() }),
    `${transferTable}_organization_id_fkey`,
    '23503',
  )
  await refuses(offer({ target_user_id: initiator }), `${transferTable}_participants`)
  await refuses(
    offer({ target_membership_id: initiatorMembership }),
    `${transferTable}_participants`,
  )
  await refuses(offer({ expires_at: createdAt }), `${transferTable}_deadline`)
  await refuses(
    offer({ created_at: 'infinity', expires_at: 'infinity' }),
    `${transferTable}_deadline`,
  )
  await refuses(offer({ terminal_at: createdAt }), `${transferTable}_terminal_time`)
  await refuses(
    offer({ state: 'confirmed', terminal_at: createdAt }),
    `${transferTable}_transition`,
  )

  await expect(offer({ id })).resolves.toMatchObject({
    rows: [{ ...binding, id, state: 'pending', terminal_at: null }],
  })
  await refuses(offer(), `${transferTable}_one_pending`, '23505')
  const other = {
    id: otherId,
    organization_id: otherOrganizationId,
    initiator_membership_id: otherInitiatorMembership,
    target_membership_id: otherRecipientMembership,
  }
  await expect(offer(other)).resolves.toMatchObject({ rowCount: 1 })
  await refuses(transition(id, 'unknown', createdAt), `${transferTable}_state`)
  await refuses(transition(id, 'confirmed', null), `${transferTable}_terminal_time`)
  await refuses(transition(id, 'confirmed', expiresAt), `${transferTable}_terminal_time`)
  await refuses(transition(id, 'expired', createdAt), `${transferTable}_terminal_time`)
  const immutableWrites = {
    id: randomUUID(),
    organization_id: otherOrganizationId,
    initiator_user_id: randomUUID(),
    initiator_membership_id: randomUUID(),
    target_user_id: randomUUID(),
    target_membership_id: randomUUID(),
  }
  for (const [column, value] of Object.entries(immutableWrites)) {
    await refuses(
      pool.query(
        `UPDATE organization_ownership_transfers
         SET ${column} = $2, state = 'confirmed', terminal_at = clock_timestamp() WHERE id = $1`,
        [id, value],
      ),
      `${transferTable}_binding`,
    )
  }
  await refuses(
    pool.query(
      `UPDATE organization_ownership_transfers
       SET created_at = created_at - interval '1 second', expires_at = expires_at - interval '1 second',
           state = 'confirmed', terminal_at = clock_timestamp() WHERE id = $1`,
      [id],
    ),
    `${transferTable}_binding`,
  )

  const consume = () =>
    pool.query(
      `UPDATE organization_ownership_transfers SET state = 'confirmed', terminal_at = clock_timestamp()
       WHERE organization_id = $1 AND id = $2 AND state = 'pending' RETURNING id`,
      [organizationId, id],
    )
  await expect(Promise.all([consume(), consume()])).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rows: [{ id }], rowCount: 1 }),
      expect.objectContaining({ rows: [], rowCount: 0 }),
    ]),
  )
  await refuses(transition(id, 'pending', null), `${transferTable}_transition`)
  await refuses(transition(id, 'confirmed', createdAt), `${transferTable}_transition`)
  await refuses(transition(id, 'revoked', createdAt), `${transferTable}_transition`)
  await refuses(offer({ id }), `${transferTable}_pkey`, '23505')

  const expiredId = randomUUID()
  const expiredAt = new Date(now - 60_000)
  const historicalCreation = new Date(expiredAt.getTime() - day)
  await expect(
    offer({ id: expiredId, created_at: historicalCreation, expires_at: expiredAt }),
  ).resolves.toMatchObject({ rowCount: 1 })
  await refuses(offer(), `${transferTable}_one_pending`, '23505')
  for (const state of ['confirmed', 'revoked']) {
    await refuses(transition(expiredId, state, historicalCreation), `${transferTable}_expired`)
  }
  await expect(transition(expiredId, 'expired', expiredAt)).resolves.toMatchObject({ rowCount: 1 })
  await expect(transition(otherId, 'revoked', createdAt)).resolves.toMatchObject({ rowCount: 1 })
  await expect(offer()).resolves.toMatchObject({
    rows: [{ id: expect.any(String), state: 'pending', terminal_at: null }],
  })

  await expect(
    pool.query(`DELETE FROM auth."user" WHERE id = $1`, [recipient]),
  ).resolves.toMatchObject({
    rowCount: 1,
  })
  await expect(
    pool.query(
      `SELECT target_user_id, target_membership_id FROM organization_ownership_transfers
       WHERE organization_id = $1 AND state = 'pending'`,
      [organizationId],
    ),
  ).resolves.toMatchObject({
    rows: [{ target_user_id: recipient, target_membership_id: recipientMembership }],
  })

  await assertBudgets(pool, organizationId, otherOrganizationId)
  await expect(
    pool.query(`DELETE FROM auth.organization WHERE id = $1`, [organizationId]),
  ).resolves.toMatchObject({
    rowCount: 1,
  })
  for (const table of [transferTable, budgetTable]) {
    await expect(pool.query(`SELECT organization_id FROM ${table}`)).resolves.toMatchObject({
      rows: [{ organization_id: otherOrganizationId }],
    })
  }
}
