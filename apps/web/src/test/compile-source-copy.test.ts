import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { compileSourceCopy, type SourceCopyOptions } from './compile-source-copy.ts'

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
})

it('kills a compiler that does not finish in time and names the copy', () => {
  const started = Date.now()
  expect(() => compileSourceCopy('Slow.tsx', 'export const a = 1', TSX, 1)).toThrowError(
    'esbuild did not compile the source copy of Slow.tsx within 0.001 s; the compiler process was killed',
  )
  expect(Date.now() - started).toBeLessThan(10_000)
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
