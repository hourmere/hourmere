// Background jobs on Postgres (pg-boss): no extra service to run, and a job can be enqueued in
// the same transaction as the writes it belongs to. pg-boss keeps its tables in its own
// `pgboss` schema, which it installs and upgrades itself; our migration runner never touches it.
import { inspect } from 'node:util'
import { fromKysely, type KyselyTransactionLike, PgBoss, type Queue } from 'pg-boss'
import pgBossPackage from 'pg-boss/package.json' with { type: 'json' }
import type { z } from 'zod'

export type { KyselyTransactionLike } from 'pg-boss'

/**
 * How pg-boss treats jobs that share a `singletonKey` (see https://hourmere.com/docs/notifications):
 * - `standard`: keys are ignored, every job is queued.
 * - `exclusive`: at most one job per key is queued or running; enqueueing another returns null.
 * - `stately`: at most one queued and one running job per key.
 * - `singleton`: at most one running job per key; any number may queue.
 * - `short`: at most one queued job per key; any number may run.
 */
export type JobPolicy = 'standard' | 'exclusive' | 'stately' | 'singleton' | 'short'

export interface RetryPolicy {
  /** Retries after the first attempt; 0 = never retry. */
  limit: number
  /** Seconds before the first retry. */
  delaySeconds: number
  /** Doubles the delay (with jitter) on every retry. */
  backoff: boolean
  /** Upper bound for the delay when backing off. */
  maxDelaySeconds?: number | undefined
}

/** What a handler learns about the job it runs. Never contains the payload. */
export interface JobRun {
  id: string
  /** 1 for the first attempt, 2 for the first retry, … */
  attempt: number
  /** Aborted when the worker shuts down and gives up waiting for this job. */
  signal: AbortSignal
}

/**
 * A kind of job: its queue name, the payload it carries, how it is retried and what runs it.
 * Payloads are stored as JSON in the database until the job is deleted, so they must be
 * plain JSON (no Date, Map, BigInt) and must never contain secrets such as tokens.
 */
export interface JobDefinition<Name extends string = string, Schema extends z.ZodType = z.ZodType> {
  /** Queue name: letters, digits, `_`, `-`, `.` and `/`. Renaming it orphans queued jobs. */
  name: Name
  /** Validates the payload when it is enqueued and again before the handler runs. */
  payload: Schema
  /** Default: 3 retries, 30 s apart, doubling, at most an hour. */
  retry?: Partial<RetryPolicy> | undefined
  /** Longest an attempt may run before it counts as failed (and is retried). Default 300. */
  expireInSeconds?: number | undefined
  /** Longest a job may wait to start (after its startAfter) before it is dropped. Default 14 days. */
  retentionSeconds?: number | undefined
  /** How long finished jobs are kept for inspection. Default 7 days. */
  deleteAfterSeconds?: number | undefined
  /** Default `standard`. Fixed once the queue exists: a different policy needs a new name. */
  policy?: JobPolicy | undefined
  /** Jobs of this kind run at the same time in one process. Default 1. */
  concurrency?: number | undefined
  /** Optional recurring dispatch, installed idempotently by worker processes. */
  schedule?: { cron: string; payload: z.input<Schema> } | undefined
  /**
   * Runs one job. Throwing fails the attempt, which is retried by the retry policy; a job
   * may therefore run more than once, so handlers must be idempotent.
   */
  handler(payload: z.output<Schema>, run: JobRun): Promise<void>
}

export type AnyJobDefinition = JobDefinition<string, z.ZodType>

/** Declares a job; the name stays a literal type so `enqueue` can check payloads by name. */
export function defineJob<const Name extends string, Schema extends z.ZodType>(
  definition: JobDefinition<Name, Schema>,
): JobDefinition<Name, Schema> {
  return definition
}

export interface EnqueueOptions {
  /** Not before this instant, e.g. 24 hours before a meeting. */
  startAfter?: Date | Temporal.Instant | undefined
  /** Deduplicates by the job's `policy`; with `standard` it has no effect. */
  singletonKey?: string | undefined
  /**
   * Inserts the job through this Kysely transaction, so it is committed or rolled back with
   * the caller's own writes, and workers only see it after the commit.
   */
  transaction?: KyselyTransactionLike | undefined
}

type Named<Defs extends readonly AnyJobDefinition[], N> = Extract<Defs[number], { name: N }>

/** The retained job identity for one invitation delivery generation. */
export interface InvitationEmailJobIdentity {
  id: string
  invitationId: string
  generation: number
}

export interface Jobs<Defs extends readonly AnyJobDefinition[]> {
  /**
   * Validates the payload and queues a job. Resolves to the job id, or null when the job's
   * policy refused a duplicate `singletonKey`. Throws JobPayloadError for an invalid payload.
   */
  enqueue<N extends Defs[number]['name']>(
    name: N,
    payload: z.input<Named<Defs, N>['payload']>,
    options?: EnqueueOptions,
  ): Promise<string | null>
  /** Installs or upgrades pg-boss's schema (if `migrate`), creates the queues, starts workers. */
  start(): Promise<void>
  /**
   * Stops taking new jobs, waits up to `shutdownTimeoutMs` for running ones (those still
   * running then are failed and retried later), and closes pg-boss's connections.
   */
  stop(): Promise<void>
  /** True between a successful start() and the beginning of stop(). */
  readonly running: boolean
  /** Resolves when pg-boss's own connection pool answers a query; rejects otherwise. */
  check(): Promise<void>
  /** Narrow pg-boss adapter: only a matching, unexpired invitation delivery job is live. */
  hasLiveInvitationEmailJob(
    identity: InvitationEmailJobIdentity,
    transaction?: KyselyTransactionLike,
  ): Promise<boolean>
}

export interface JobsOptions<Defs extends readonly AnyJobDefinition[]> {
  /** pg-boss opens its own small pool on this database. */
  connectionString: string
  definitions: Defs
  /** Run handlers (and pg-boss maintenance) in this process; false only enqueues. */
  work: boolean
  /** Install or upgrade the `pgboss` schema on start. When false, it must already be current. */
  migrate: boolean
  /** Connections in pg-boss's pool. Default 5. */
  maxConnections?: number | undefined
  /** How often idle workers look for jobs. Default 2; at least 0.5. */
  pollingIntervalSeconds?: number | undefined
  /** How long stop() waits for running jobs. Default 20 000. */
  shutdownTimeoutMs?: number | undefined
  /** Shown in pg-boss's instance registry and in pg_stat_activity. */
  instanceName?: string | undefined
  /** Receives one line per event; defaults to the console. */
  log?: ((level: 'info' | 'warn' | 'error', line: string) => void) | undefined
}

/** The payload did not match the job's schema. The message names fields, never their values. */
export class JobPayloadError extends Error {
  override name = 'JobPayloadError'
}

const DEFAULT_RETRY: RetryPolicy = {
  limit: 3,
  delaySeconds: 30,
  backoff: true,
  maxDelaySeconds: 3600,
}

// C0/C1 controls, line and paragraph separators, bidi controls: escaped so that nothing in an
// error (which can carry outside input, e.g. an SMTP reply) can start a log line of its own.
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const NAMED: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' }
const oneLine = (text: string) =>
  text.replace(CONTROL, (c) => NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
const describe = (value: unknown) =>
  oneLine(
    typeof value === 'string' ? value : inspect(value, { breakLength: Number.POSITIVE_INFINITY }),
  )

/** Field paths and messages of a failed parse, without the values. */
function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message))
    .join('; ')
}

function queueOptions(definition: AnyJobDefinition) {
  const retry = { ...DEFAULT_RETRY, ...definition.retry }
  return {
    retryLimit: retry.limit,
    retryDelay: retry.delaySeconds,
    retryBackoff: retry.backoff,
    // Only meaningful with backoff (pg-boss refuses it otherwise); null clears an old value.
    retryDelayMax: retry.backoff ? (retry.maxDelaySeconds ?? null) : null,
    expireInSeconds: definition.expireInSeconds ?? 300,
    retentionSeconds: definition.retentionSeconds ?? 14 * 24 * 3600,
    deleteAfterSeconds: definition.deleteAfterSeconds ?? 7 * 24 * 3600,
  }
}

const defaultLog = (level: 'info' | 'warn' | 'error', line: string) => console[level](line)

export function createJobs<const Defs extends readonly AnyJobDefinition[]>(
  options: JobsOptions<Defs>,
): Jobs<Defs> {
  const log = options.log ?? defaultLog
  const definitions = new Map<string, AnyJobDefinition>()
  for (const definition of options.definitions) {
    if (definitions.has(definition.name)) throw new Error(`job ${definition.name} defined twice`)
    definitions.set(definition.name, definition)
  }
  const pollingIntervalSeconds = options.pollingIntervalSeconds ?? 2
  const boss = new PgBoss({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 5,
    application_name: `hourmere-jobs${options.instanceName ? `-${options.instanceName}` : ''}`,
    migrate: options.migrate,
    // Maintenance (expiring, retrying and deleting jobs) and cron belong to workers.
    supervise: options.work,
    schedule: options.work,
    ...(options.instanceName && { instanceName: options.instanceName }),
  })
  // Without a listener, an 'error' event would throw and end the process. pg-boss keeps
  // going after these (e.g. a lost connection during a poll).
  boss.on('error', (err) =>
    log('error', `${new Date().toISOString()} ERROR jobs: ${describe(err)}`),
  )
  boss.on('warning', (warning) =>
    log('warn', `${new Date().toISOString()} WARN jobs: ${describe(warning.message)}`),
  )

  let state: 'created' | 'starting' | 'running' | 'stopping' | 'stopped' = 'created'

  async function syncQueue(definition: AnyJobDefinition) {
    const wanted = queueOptions(definition)
    const policy = definition.policy ?? 'standard'
    const existing = await boss.getQueue(definition.name)
    if (!existing) {
      // Idempotent: another instance starting at the same time creates it once.
      const { retryDelayMax, ...rest } = wanted
      await boss.createQueue(definition.name, {
        policy,
        ...rest,
        ...(retryDelayMax !== null && { retryDelayMax }),
      })
      const created = await boss.getQueue(definition.name)
      if (created?.policy !== policy) throw policyMismatch(definition.name, created, policy)
      return
    }
    if (existing.policy !== policy) throw policyMismatch(definition.name, existing, policy)
    const changed = (Object.keys(wanted) as (keyof typeof wanted)[]).some(
      (k) => existing[k as keyof Queue] !== wanted[k],
    )
    if (changed) await boss.updateQueue(definition.name, wanted)
  }

  function policyMismatch(name: string, queue: Queue | null, policy: string) {
    return new Error(
      `queue ${name} has policy ${queue?.policy ?? 'unknown'} but its job definition says ${policy}; a policy cannot change, so give the job a new name`,
    )
  }

  async function run(
    definition: AnyJobDefinition,
    job: { id: string; data: unknown; retryCount: number; signal: AbortSignal },
  ) {
    const limit = { ...DEFAULT_RETRY, ...definition.retry }.limit
    const attempt = job.retryCount + 1
    const fail = (what: string, err: unknown) => {
      const next = attempt <= limit ? 'will retry' : 'giving up'
      log(
        'error',
        `${new Date().toISOString()} ERROR job ${definition.name} ${job.id} attempt ${attempt} of ${limit + 1} ${what} (${next}): ${describe(err)}`,
      )
    }
    const parsed = definition.payload.safeParse(job.data)
    if (!parsed.success) {
      const err = new JobPayloadError(`invalid payload: ${issuesOf(parsed.error)}`)
      fail('has an invalid payload', err.message)
      throw err
    }
    try {
      await definition.handler(parsed.data, { id: job.id, attempt, signal: job.signal })
    } catch (err) {
      if (job.signal.aborted) {
        // A shutdown, not a failure worth a stack trace.
        const next = attempt <= limit ? 'will retry' : 'giving up'
        log(
          'warn',
          `${new Date().toISOString()} WARN job ${definition.name} ${job.id} attempt ${attempt} of ${limit + 1} stopped: the worker is shutting down (${next})`,
        )
      } else {
        fail('failed', err)
      }
      throw err
    }
  }

  return {
    get running() {
      return state === 'running'
    },

    async check() {
      if (state !== 'running') throw new Error(`jobs are not running (${state})`)
      await boss.getDb().executeSql('SELECT 1')
    },

    async hasLiveInvitationEmailJob(identity, transaction) {
      if (state !== 'running') throw new Error(`jobs are not running (${state})`)
      // This intentionally reads pg-boss internals. Review the columns and expiry rules
      // whenever its exact dependency version changes; never add an application FK.
      if (pgBossPackage.version !== '12.38.0') {
        throw new Error('invitation job lookup requires pg-boss 12.38.0')
      }
      const connection = transaction ? fromKysely(transaction) : boss.getDb()
      const result = await connection.executeSql(
        `SELECT 1 FROM pgboss.job
         WHERE id = $1::uuid AND name = 'invitation-email-v1'
           AND singleton_key = $2
           AND data = $3::jsonb
           AND (
             (state IN ('created', 'retry') AND keep_until > clock_timestamp())
             OR (state = 'active' AND started_on IS NOT NULL
               AND started_on + expire_seconds * INTERVAL '1 second' > clock_timestamp())
           )
         LIMIT 1`,
        [
          identity.id,
          `invitation-email:v1:${identity.invitationId}:${identity.generation}`,
          JSON.stringify({ invitationId: identity.invitationId, generation: identity.generation }),
        ],
      )
      return result.rows.length === 1
    },

    async enqueue(name, payload, enqueueOptions = {}) {
      const definition = definitions.get(name)
      if (!definition) throw new Error(`unknown job ${name}`)
      if (state !== 'running') throw new Error(`jobs are not running (${state})`)
      const parsed = definition.payload.safeParse(payload)
      if (!parsed.success) {
        throw new JobPayloadError(`job ${name}: invalid payload: ${issuesOf(parsed.error)}`)
      }
      const { startAfter, singletonKey, transaction } = enqueueOptions
      return boss.send(name, parsed.data as object, {
        ...(startAfter !== undefined && {
          startAfter:
            startAfter instanceof Date ? startAfter : new Date(startAfter.epochMilliseconds),
        }),
        ...(singletonKey !== undefined && { singletonKey }),
        ...(transaction && { db: fromKysely(transaction) }),
      })
    },

    async start() {
      if (state !== 'created') throw new Error(`jobs cannot start (${state})`)
      state = 'starting'
      try {
        await boss.start()
        for (const definition of definitions.values()) await syncQueue(definition)
        if (options.work) {
          for (const definition of definitions.values()) {
            if (definition.schedule) {
              const scheduled = definition.payload.safeParse(definition.schedule.payload)
              if (!scheduled.success)
                throw new JobPayloadError(
                  `job ${definition.name}: invalid scheduled payload: ${issuesOf(scheduled.error)}`,
                )
              await boss.schedule(
                definition.name,
                definition.schedule.cron,
                scheduled.data as object,
              )
            }
            await boss.work(
              definition.name,
              {
                batchSize: 1,
                localConcurrency: definition.concurrency ?? 1,
                pollingIntervalSeconds,
              },
              async ([job]) => {
                if (job) await run(definition, job)
              },
            )
          }
        }
        state = 'running'
      } catch (err) {
        state = 'stopping'
        await boss.stop({ graceful: false, close: true }).catch(() => {})
        state = 'stopped'
        if (options.migrate) throw err
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(
          `background jobs could not start: ${reason} (migrate is off, so pg-boss's schema must already be installed and current; \`npm run db:migrate\` does that)`,
          { cause: err },
        )
      }
    },

    async stop() {
      if (state === 'stopped' || state === 'stopping') return
      const wasStarted = state !== 'created'
      state = 'stopping'
      try {
        if (wasStarted) {
          await boss.stop({
            graceful: true,
            timeout: options.shutdownTimeoutMs ?? 20_000,
            close: true,
          })
        }
      } finally {
        state = 'stopped'
      }
    },
  }
}
