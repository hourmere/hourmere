import { inspect } from 'node:util'
import { expect, vi } from 'vitest'

/** Capture both console methods and direct logger writes without emitting private fixtures. */
export async function assertSmsLogsPrivate(
  run: () => Promise<void>,
  input: { to: string; body: string },
): Promise<void> {
  const logs: string[] = []
  const spies = [
    ...(
      [
        'log',
        'info',
        'warn',
        'error',
        'debug',
        'trace',
        'dir',
        'dirxml',
        'table',
        'assert',
      ] as const
    ).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(inspect(args, { depth: null }))
      }),
    ),
    ...[process.stdout, process.stderr].map((stream) =>
      vi.spyOn(stream, 'write').mockImplementation((chunk) => {
        logs.push(String(chunk))
        return true
      }),
    ),
  ]
  try {
    await run()
    const output = logs.join('\n')
    expect(output).not.toContain(input.to)
    expect(output).not.toContain(input.body)
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}
