// Binds the catalogues that migration 0079 (workflow execution storage) checks to this contract:
// the triggers each lifecycle occurrence captures, the fixed skip reasons of runs, recipients and
// history, the intent categories and offsets of timer email, and the history triggers. Each is
// derived here from the contract's own schemas and constants, so neither side can change
// without the other.
import { createTestDatabase, type TestDatabase } from '@hourmere/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKFLOW_SKIP_REASONS } from './audit.ts'
import { WorkflowTriggerSchema } from './definition.ts'
import { WORKFLOW_MAX_OFFSET_MINUTES, WORKFLOW_MIN_TIMER_OFFSET_MINUTES } from './limits.ts'

const serverUrl = process.env.DATABASE_URL

const triggers = WorkflowTriggerSchema.options.map((option) => option.shape.type.value)
const lifecycle = WorkflowTriggerSchema.options
  .filter((option) => 'delayMinutes' in option.shape)
  .map((option) => option.shape.type.value)
const timers = WorkflowTriggerSchema.options
  .filter((option) => 'offsetMinutes' in option.shape)
  .map((option) => option.shape.type.value)
/** A list as `pg_get_constraintdef` prints it: one value as `= 'x'::text`, more as `= ANY`. */
const list = (values: readonly string[]) =>
  values.length === 1
    ? `= '${values[0]}'::text`
    : `= ANY (ARRAY[${values.map((value) => `'${value}'::text`).join(', ')}])`

describe.skipIf(!serverUrl)('workflow execution storage and the workflow contract', () => {
  let owned: TestDatabase
  let definitions: Record<string, string>

  beforeAll(async () => {
    owned = await createTestDatabase(serverUrl as string, undefined, { tag: 'wf_exec_contract' })
    const { rows } = await owned.pool.query<{ name: string; definition: string }>(
      `SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE contype='c' AND conrelid IN ('workflow_enrollments'::regclass,'workflow_runs'::regclass,
        'workflow_recipient_claims'::regclass,'workflow_run_history'::regclass)`,
    )
    definitions = Object.fromEntries(rows.map(({ name, definition }) => [name, definition]))
  })
  afterAll(async () => {
    await owned?.drop()
  })

  it('captures each trigger at exactly its lifecycle occurrence', () => {
    // Creation captures the creation trigger and every timer (a reschedule successor carries
    // the timers under the creation occurrence); each other lifecycle trigger has its own.
    const [created, ...others] = lifecycle
    expect(created).toBe('booking.created')
    const occurrences: [string, string[]][] = [
      ['created', [created as string, ...timers]],
      ...others.map((trigger): [string, string[]] => [trigger.replace('booking.', ''), [trigger]]),
    ]
    expect(occurrences.flatMap(([, captured]) => captured).sort()).toEqual([...triggers].sort())
    const disjuncts = (definitions.workflow_enrollments_occurrence ?? '')
      .replace(/^CHECK \(\((.*)\)\)$/, '$1')
      .split(' OR ')
    expect(disjuncts.sort()).toEqual(
      occurrences
        .map(
          ([occurrence, captured]) =>
            `((occurrence = '${occurrence}'::text) AND (trigger ${list(captured)}))`,
        )
        .sort(),
    )
    expect(definitions.workflow_run_history_trigger).toBe(`CHECK ((trigger ${list(triggers)}))`)
  })

  it('stores exactly the contract skip reasons for runs, recipients and history', () => {
    for (const [name, column] of [
      ['workflow_runs_state', 'skip_reason'],
      ['workflow_recipient_claims_state', 'skip_reason'],
      ['workflow_run_history_outcome', 'reason'],
    ])
      expect(definitions[name as string], name).toContain(
        `(${column} ${list(WORKFLOW_SKIP_REASONS)})`,
      )
  })

  it('keys timer email intents by the timer triggers and their offset range', () => {
    expect(definitions.workflow_recipient_claims_intent_key).toContain(
      `((intent_kind ${list(timers)}) AND ((intent_offset_minutes >= ${WORKFLOW_MIN_TIMER_OFFSET_MINUTES}) AND (intent_offset_minutes <= ${WORKFLOW_MAX_OFFSET_MINUTES})))`,
    )
  })

  it('closes every pool it opens', () => {
    expect(owned.pool.totalCount).toBeLessThanOrEqual(2)
  })
})
