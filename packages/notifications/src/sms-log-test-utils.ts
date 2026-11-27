import { inspect } from 'node:util'
import { expect, vi } from 'vitest'

function logged(output: string, value: string): boolean {
  const formEncoded = new URLSearchParams({ value }).toString().slice('value='.length)
  return [value, encodeURIComponent(value), formEncoded].some((form) => output.includes(form))
}

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
    const digits = input.to.replace(/\D/g, '')
    expect({
      destination: logged(output, input.to) || output.includes(digits),
      body: logged(output, input.body),
    }).toEqual({ destination: false, body: false })
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}
