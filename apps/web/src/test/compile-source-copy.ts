import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The esbuild transform options the web mutation tests use. */
export type SourceCopyOptions = {
  loader: 'ts' | 'tsx'
  format: 'cjs'
  jsxFactory?: string
  jsxFragment?: string
}

export const SOURCE_COPY_TIMEOUT_MS = 30_000

// esbuild refuses to load under jsdom (its `TextEncoder` result is not jsdom's `Uint8Array`),
// so the copy is compiled by a plain Node child. The source, the code and any error travel
// through files, never through stdin/stdout: on macOS a child blocked reading a socket
// stdin can miss the end-of-input wakeup and wait forever, hanging the test worker with it.
const CHILD = [
  "import { readFileSync, writeFileSync } from 'node:fs'",
  "import { transformSync } from 'esbuild'",
  'const [input, output, options] = process.argv.slice(1)',
  "writeFileSync(output, transformSync(readFileSync(input, 'utf8'), JSON.parse(options)).code)",
].join('\n')

/**
 * Compile an in-memory source copy (for example a mutated production file) to CommonJS with
 * esbuild. `name` identifies the copy in errors. A child that does not finish within
 * `timeoutMs` is killed and the call throws, so a stuck compiler fails the test instead of
 * hanging the suite.
 */
export function compileSourceCopy(
  name: string,
  source: string,
  options: SourceCopyOptions,
  timeoutMs = SOURCE_COPY_TIMEOUT_MS,
): string {
  const directory = mkdtempSync(join(tmpdir(), 'hourmere-source-copy-'))
  try {
    const input = join(directory, 'source')
    const output = join(directory, 'compiled.js')
    const errors = join(directory, 'stderr')
    writeFileSync(input, source)
    const stderr = openSync(errors, 'w')
    let run: ReturnType<typeof spawnSync>
    try {
      run = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', CHILD, input, output, JSON.stringify(options)],
        { stdio: ['ignore', 'ignore', stderr], timeout: timeoutMs, killSignal: 'SIGKILL' },
      )
    } finally {
      closeSync(stderr)
    }
    if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      throw new Error(
        `esbuild did not compile the source copy of ${name} within ${timeoutMs / 1000} s; the compiler process was killed`,
      )
    }
    if (run.error) {
      throw new Error(`Could not start esbuild for the source copy of ${name}`, {
        cause: run.error,
      })
    }
    if (run.status !== 0) {
      throw new Error(
        `esbuild could not compile the source copy of ${name} (${
          run.signal ? `signal ${run.signal}` : `exit ${run.status}`
        }):\n${readFileSync(errors, 'utf8')}`,
      )
    }
    return readFileSync(output, 'utf8')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
