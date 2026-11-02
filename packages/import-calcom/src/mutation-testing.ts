// Test-only source-copy negative controls. A syntax/import error is never a killed mutation.
import { randomBytes } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { expect } from 'vitest'
export async function checkSourceMutation<T>(
  source: URL,
  before: string,
  after: string,
  select: (module: Record<string, unknown>) => T,
  assertion: (value: T) => void | Promise<void>,
) {
  const original = await readFile(source, 'utf8')
  // Formatting changes must not invalidate a control. Match the same source characters
  // while tolerating whitespace; retain original offsets for the actual replacement.
  const offsets: number[] = []
  let compact = ''
  for (let index = 0; index < original.length; index++) {
    const character = original[index] as string
    if (!/\s/.test(character)) {
      compact += character
      offsets.push(index)
    }
  }
  const needle = before.replace(/\s/g, '')
  const start = compact.indexOf(needle)
  expect(start >= 0).toBe(true)
  const first = offsets[start] as number
  const last = (offsets[start + needle.length - 1] as number) + 1
  const changed = original.slice(0, first) + after + original.slice(last)
  const copy = new URL(
    `./mutation-copy-${process.pid}-${randomBytes(6).toString('hex')}.ts`,
    source,
  )
  await writeFile(copy, changed, { mode: 0o600 })
  try {
    const module = await import(/* @vite-ignore */ copy.href)
    let assertionFailed = false
    try {
      await assertion(select(module))
    } catch (error) {
      if (error instanceof Error && error.name === 'AssertionError') assertionFailed = true
      else throw error
    }
    expect(assertionFailed).toBe(true)
  } finally {
    await unlink(copy)
  }
}

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Required test fixture is missing')
  return value
}
