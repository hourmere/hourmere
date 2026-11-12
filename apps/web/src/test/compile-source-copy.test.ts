import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { compileSourceCopy, type SourceCopyOptions } from './compile-source-copy.ts'

// Records what the helper asks of the file system and the process API, passing every call
// through to the real implementation, so tests can check the temporary directory and the
// compiler's stdio directly.
const observed = vi.hoisted(() => ({
  directories: [] as string[],
  spawns: [] as { command: string; options: Record<string, unknown> }[],
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => {
      const directory = actual.mkdtempSync(...args)
      observed.directories.push(String(directory))
      return directory
    },
  }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
      const [command, , options] = args
      observed.spawns.push({ command, options: { ...(options as Record<string, unknown>) } })
      return actual.spawnSync(...args)
    },
  }
})
beforeEach(() => {
  observed.directories.length = 0
  observed.spawns.length = 0
})

const TSX: SourceCopyOptions = {
  loader: 'tsx',
  format: 'cjs',
  jsxFactory: 'h.createElement',
  jsxFragment: 'h.Fragment',
}

function run(code: string) {
  const h = {
    Fragment: 'fragment',
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
  }
  const module = { exports: {} as Record<string, (...args: never[]) => unknown> }
  new Function('module', 'exports', 'h', code)(module, module.exports, h)
  return module.exports
}

/** The one temporary directory the last compile created, which must be gone again. */
function expectTemporaryDirectoryRemoved() {
  expect(observed.directories).toHaveLength(1)
  const [directory] = observed.directories
  expect(directory?.startsWith(join(tmpdir(), 'hourmere-source-copy-'))).toBe(true)
  expect(existsSync(directory as string), `${directory} must be removed`).toBe(false)
}

it('compiles a TSX source copy to CommonJS with the requested JSX factory', () => {
  const code = compileSourceCopy(
    'Greeting.tsx',
    'export function Greeting({ name }: { name: string }) { return <><p>{name}</p></> }',
    TSX,
  )
  expect(run(code).Greeting?.({ name: 'Ada' } as never)).toEqual({
    type: 'fragment',
    props: null,
    children: [{ type: 'p', props: null, children: ['Ada'] }],
  })
  expectTemporaryDirectoryRemoved()
})

it('passes large source copies through intact', () => {
  const lines = Array.from(
    { length: 20_000 },
    (_, index) => `  total += ${index} // ${'x'.repeat(20)}`,
  )
  const source = `export function sum(): number {\n  let total = 0\n${lines.join('\n')}\n  return total\n}`
  expect(source.length).toBeGreaterThan(500_000)
  const code = compileSourceCopy('Large.ts', source, { loader: 'ts', format: 'cjs' })
  expect(run(code).sum?.()).toBe((19_999 * 20_000) / 2)
})

it('names the copy and keeps the esbuild diagnostic when compilation fails', () => {
  expect(() => compileSourceCopy('Broken.tsx', 'export const = <p>', TSX)).toThrowError(
    /esbuild could not compile the source copy of Broken\.tsx \(exit 1\):[\s\S]*Expected identifier/,
  )
  expectTemporaryDirectoryRemoved()
})

it('kills a compiler that does not finish in time and names the copy', () => {
  const started = Date.now()
  expect(() => compileSourceCopy('Slow.tsx', 'export const a = 1', TSX, 1)).toThrowError(
    'esbuild did not compile the source copy of Slow.tsx within 0.001 s; the compiler process was killed',
  )
  expect(Date.now() - started).toBeLessThan(10_000)
  expectTemporaryDirectoryRemoved()
})

it('starts the compiler with no stdin at all', () => {
  compileSourceCopy('Plain.ts', 'export const a: number = 1', { loader: 'ts', format: 'cjs' })
  expect(observed.spawns).toHaveLength(1)
  const [{ command, options } = { command: '', options: {} }] = observed.spawns
  expect(command).toBe(process.execPath)
  expect((options.stdio as unknown[] | undefined)?.[0]).toBe('ignore')
  expect(options).not.toHaveProperty('input')
})

it('keeps the helper itself from reading the source through stdin', () => {
  const helper = readFileSync('apps/web/src/test/compile-source-copy.ts', 'utf8')
  expect(helper).not.toMatch(/readFileSync\(\s*0\b|\/dev\/stdin|process\.stdin/)
  expect(helper).not.toMatch(/\binput\s*:/)
  expect(helper).not.toMatch(/\bexec(?:File)?Sync\b/)
})

it('keeps web tests from compiling source copies through a stdin pipe', () => {
  const root = 'apps/web/src'
  const offenders = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.test\.tsx?$/.test(file) && file !== 'test/compile-source-copy.test.ts')
    .filter((file) =>
      /transformSync\(|readFileSync\(0\b/.test(readFileSync(join(root, file), 'utf8')),
    )
  expect(offenders, 'compile source copies with compileSourceCopy').toEqual([])
})
