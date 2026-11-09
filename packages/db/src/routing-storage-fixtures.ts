import { randomUUID } from 'node:crypto'
import { copyFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { expect } from 'vitest'
import { migrationsDir } from './migrate.ts'

export const routingMigration = '0072_routing_forms.sql'
export const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
export type Connection = pg.Pool | pg.PoolClient
export interface RoutingFixture {
  pool: pg.Pool
  organization: string
  otherOrganization: string
  creator: string
  form: string
  otherForm: string
  version: string
  otherVersion: string
  booking: string
  otherBooking: string
  event: string
}

export async function copyRoutingPredecessor(directory: string) {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql') && file.slice(0, 4) <= '0070')
    .sort()
  expect(files.at(-1)).toBe('0070_attendee_no_show.sql')
  for (const file of files) await copyFile(join(migrationsDir, file), join(directory, file))
  return files
}

export async function insertRow(
  connection: Connection,
  table: string,
  values: Record<string, unknown>,
) {
  const fields = Object.keys(values)
  return (
    await connection.query<{ id: string }>(
      `INSERT INTO ${quote(table)} (${fields.map(quote).join(',')})
       VALUES (${fields.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      Object.values(values),
    )
  ).rows[0]?.id as string
}

export function formValues(f: Pick<RoutingFixture, 'organization' | 'creator'>) {
  return {
    organization_id: f.organization,
    slug: `form-${randomUUID()}`,
    created_by_user_id: f.creator,
    draft: JSON.stringify({
      title: 'Qualification 東京',
      questions: [],
      rules: [],
      fallback: { kind: 'message', message: 'Thank you' },
    }),
  }
}
export function versionValues(f: Pick<RoutingFixture, 'organization' | 'creator' | 'form'>) {
  return {
    organization_id: f.organization,
    form_id: f.form,
    version_number: 1,
    questions: '[]',
    rules: '[]',
    fallback: JSON.stringify({ kind: 'message', message: 'Thank you' }),
    published_by_user_id: f.creator,
  }
}
export function receiptValues(f: RoutingFixture) {
  return {
    organization_id: f.organization,
    form_id: f.form,
    version_id: f.version,
    token_hash: randomUUID().replaceAll('-', '').repeat(2),
    answers_ciphertext: Buffer.from('synthetic encrypted answers'),
    matched_rule_id: 'fallback',
    resolved_rule_id: 'fallback',
    resolved_target: JSON.stringify({ kind: 'event', eventTypeId: f.event }),
    expires_at: '2099-01-01T00:00:00Z',
  }
}
export function bookingRoutingValues(f: RoutingFixture) {
  return {
    organization_id: f.organization,
    booking_id: f.booking,
    form_id: f.form,
    version_id: f.version,
    version_number: 1,
    matched_rule_id: 'fallback',
    resolved_rule_id: 'fallback',
    questions: '[]',
    answers: '{}',
  }
}

export async function routingFixture(pool: pg.Pool): Promise<RoutingFixture> {
  const creator = (
    await pool.query<{ id: string }>(
      `INSERT INTO auth."user" (name,email,"emailVerified")
      VALUES ('Synthetic routing host',$1,true) RETURNING id`,
      [`routing-${randomUUID()}@example.test`],
    )
  ).rows[0]?.id as string
  const organizations = (
    await pool.query<{ id: string }>(
      `INSERT INTO auth.organization (name,slug,"createdAt")
      VALUES ('Routing team',$1,now()),('Other routing team',$2,now()) RETURNING id`,
      [`routing-${randomUUID()}`, `routing-${randomUUID()}`],
    )
  ).rows
  const organization = organizations[0]?.id as string
  const otherOrganization = organizations[1]?.id as string
  const form = await insertRow(pool, 'routing_forms', formValues({ organization, creator }))
  const otherForm = await insertRow(
    pool,
    'routing_forms',
    formValues({ organization: otherOrganization, creator }),
  )
  const version = await insertRow(
    pool,
    'routing_form_versions',
    versionValues({ organization, creator, form }),
  )
  const otherVersion = await insertRow(
    pool,
    'routing_form_versions',
    versionValues({ organization: otherOrganization, creator, form: otherForm }),
  )
  const event = await insertRow(pool, 'event_types', {
    organization_id: organization,
    slug: 'routing-target',
    title: 'Synthetic target',
    duration_minutes: 30,
  })
  const bookings = (
    await pool.query<{ id: string }>(
      `INSERT INTO bookings
      (organization_id,event_type_id,start_at,end_at,title,source,status) VALUES
      ($1,$2,'2030-01-01T09:00Z','2030-01-01T09:30Z','Routing booking','web','confirmed'),
      ($3,NULL,'2030-01-02T09:00Z','2030-01-02T09:30Z','Other booking','web','confirmed') RETURNING id`,
      [organization, event, otherOrganization],
    )
  ).rows
  return {
    pool,
    creator,
    organization,
    otherOrganization,
    form,
    otherForm,
    version,
    otherVersion,
    event,
    booking: bookings[0]?.id as string,
    otherBooking: bookings[1]?.id as string,
  }
}
