// Keep this module free of imports: Vitest loads it before each file's vi.mock calls.
const activeDatabases = new Set<() => Promise<void>>()
const SHUTDOWN_TIMEOUT_MS = 15_000
let hooksInstalled = false
let interrupted = false

export async function withDeadline(
  operation: Promise<unknown>,
  milliseconds: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Fallback for a test runner's afterAll hook; callers should still drop their fixtures. */
export async function cleanupTestDatabases(): Promise<void> {
  const results = await Promise.allSettled([...activeDatabases].map(async (drop) => drop()))
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, 'Test database cleanup failed')
}

function removeHooks(): void {
  if (!hooksInstalled) return
  process.removeListener('beforeExit', beforeExit)
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  process.removeListener('disconnect', disconnect)
  hooksInstalled = false
}

function beforeExit(): void {
  void cleanupTestDatabases().catch(() => {
    // Do not print a driver's error: it can contain connection details.
    console.error(
      'Test database cleanup failed; inspect stale test databases with the cleanup script',
    )
    process.exitCode = 1
  })
}

function interrupt(signal: NodeJS.Signals): void {
  const ownsSignal = process.listenerCount(signal) === 1
  if (interrupted) {
    removeHooks()
    if (ownsSignal) process.kill(process.pid, signal)
    return
  }
  interrupted = true
  void withDeadline(
    cleanupTestDatabases().catch(() => {}),
    SHUTDOWN_TIMEOUT_MS,
  ).finally(() => {
    removeHooks()
    // Preserve standalone scripts' signal exit; Vitest owns its own cancellation.
    if (ownsSignal) process.kill(process.pid, signal)
  })
}

function disconnect(): void {
  // Fork workers can lose only their parent, without a signal or a beforeExit event.
  // Cleanup must neither reject into the worker nor wait indefinitely for PostgreSQL.
  void withDeadline(
    cleanupTestDatabases().catch(() => {}),
    SHUTDOWN_TIMEOUT_MS,
  ).finally(removeHooks)
}

/** Registers only databases owned by this process; call the result after a successful drop. */
export function registerTestDatabaseCleanup(drop: () => Promise<void>): () => void {
  activeDatabases.add(drop)
  if (!hooksInstalled) {
    interrupted = false
    process.once('beforeExit', beforeExit)
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', interrupt)
    process.on('disconnect', disconnect)
    hooksInstalled = true
  }
  // A still-running orphan may create another fixture after the disconnect event.
  // Defer until its caller has assigned any pending CREATE/ALTER setup promise.
  if (process.connected === false) queueMicrotask(disconnect)
  return () => {
    activeDatabases.delete(drop)
    if (activeDatabases.size === 0) removeHooks()
  }
}
