import { constants, readFileSync } from 'node:fs'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'
import * as client from './client.ts'
import { type uploadLogo, version } from './client.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })))
})
async function file(data: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), 'hourmere-branding-cli-'))
  directories.push(directory)
  const path = join(directory, 'logo.png')
  await writeFile(path, data)
  return path
}
const env = { HOURMERE_URL: 'https://hourmere.example', HOURMERE_API_KEY: 'hm_synthetic_branding' }
async function run(argv: string[], fetcher: typeof fetch, input = {}, runner = runCli) {
  let stdout = ''
  let stderr = ''
  const code = await runner({
    argv,
    env,
    stdin: (async function* () {
      yield JSON.stringify(input)
    })(),
    stdout: (value) => {
      stdout += value
    },
    stderr: (value) => {
      stderr += value
    },
    fetch: fetcher,
  })
  return { code, stdout, stderr }
}
function copy(change?: readonly [string, string]): typeof uploadLogo {
  let source = readFileSync('tools/cli/src/client.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0])).toBe(true)
    source = source.replace(...change)
  }
  source = source.replace(
    /export const \{ version \} = JSON.parse\([\s\S]*?as \{ version: string \}/,
    '',
  )
  source = stripTypeScriptTypes(source.replace(/^import[^\n]+\n/gm, '')).replace(/\bexport /g, '')
  source = source
    .replace("  const { constants } = await import('node:fs')", '')
    .replace("  const { open } = await import('node:fs/promises')", '')
  return new Function('version', 'constants', 'open', `${source}; return uploadLogo`)(
    version,
    constants,
    open,
  ) as typeof uploadLogo
}

function cliCopy(change?: readonly [string, string]): typeof runCli {
  let source = readFileSync('tools/cli/src/cli.ts', 'utf8')
  if (change) {
    expect(source.includes(change[0])).toBe(true)
    source = source.replace(...change)
  }
  source = stripTypeScriptTypes(source.replace(/^import[\s\S]*?from '[^']+'\n/gm, '')).replace(
    /\bexport /g,
    '',
  )
  const bindings = { constants, open, ...client }
  return new Function(...Object.keys(bindings), `${source}; return runCli`)(
    ...Object.values(bindings),
  ) as typeof runCli
}

describe('branding CLI', () => {
  it.each([
    ['get', 'get_branding'],
    ['set', 'set_branding'],
  ])('dispatches branding %s through MCP', async (command, tool) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: { structuredContent: { brandPrimaryColor: '#123456' } },
      }),
    )
    expect(
      (await run(['branding', command, '--input', '-'], fetcher, { brandPrimaryColor: '#123456' }))
        .code,
    ).toBe(0)
    const body = JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)
    expect(body.params).toMatchObject({ name: tool, arguments: { brandPrimaryColor: '#123456' } })
  })
  it('sends raw image bytes to REST and never follows a credential-bearing redirect', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71])
    const path = await file(bytes)
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ brandLogo: 'a'.repeat(64) }))
    const result = await run(
      ['branding', 'upload', '--file', path, '--content-type', 'image/png'],
      fetcher,
    )
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).brandLogo).toBe('a'.repeat(64))
    const [url, request] = fetcher.mock.calls[0] ?? []
    expect(String(url)).toBe('https://hourmere.example/api/v1/branding/logo')
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      body: bytes,
      headers: { 'content-type': 'image/png' },
    })
  })
  it('refuses oversized files before sending a request', async () => {
    const path = await file(new Uint8Array(512 * 1024 + 1))
    const fetcher = vi.fn<typeof fetch>()
    const result = await run(
      ['branding', 'upload', '--file', path, '--content-type', 'image/png'],
      fetcher,
    )
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stderr).error).toBe('input_too_large')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('refuses SVG and conflicting JSON input before a request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (const args of [
      ['--file', 'logo.svg', '--content-type', 'image/svg+xml'],
      ['--file', 'logo.png', '--content-type', 'image/png', '--input', '-'],
    ]) {
      expect((await run(['branding', 'upload', ...args], fetcher)).code).toBe(1)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('kills source-copy removal of the upload type allowlist', async () => {
    const path = await file(new Uint8Array([1]))
    async function verify(runner: typeof runCli) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({ brandLogo: 'a'.repeat(64) }))
      const result = await run(
        ['branding', 'upload', '--file', path, '--content-type', 'image/svg+xml'],
        fetcher,
        {},
        runner,
      )
      expect(result.code).toBe(1)
      expect(fetcher).not.toHaveBeenCalled()
    }
    await verify(cliCopy())
    await expect(
      verify(
        cliCopy([
          "!['image/png', 'image/jpeg', 'image/webp'].includes(options.contentType ?? '')",
          'false',
        ]),
      ),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
  it('kills source-copy removal of the actual bounded read', async () => {
    const path = await file(new Uint8Array(512 * 1024 + 1))
    async function verify(upload: typeof uploadLogo) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({ brandLogo: 'a'.repeat(64) }))
      await expect(
        upload({
          url: new URL('https://hourmere.example/mcp'),
          key: env.HOURMERE_API_KEY,
          path,
          contentType: 'image/png',
          fetch: fetcher,
        }),
      ).rejects.toMatchObject({ code: 'input_too_large' })
      expect(fetcher).not.toHaveBeenCalled()
    }
    await verify(copy())
    await expect(
      verify(copy(['const limit = 512 * 1024', 'const limit = 1024 * 1024'])),
    ).rejects.toThrow(expect.objectContaining({ name: 'AssertionError' }))
  })
  it('source-copy mutation detects redirect protection removal', async () => {
    const path = await file(new Uint8Array([1]))
    async function verify(upload: typeof uploadLogo) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({ brandLogo: 'a'.repeat(64) }))
      await upload({
        url: new URL('https://hourmere.example/mcp'),
        key: env.HOURMERE_API_KEY,
        path,
        contentType: 'image/png',
        fetch: fetcher,
      })
      expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error')
    }
    await verify(copy())
    const mutant = copy([
      "new URL('/api/v1/branding/logo', options.url), {\n      method: 'POST',\n      redirect: 'error'",
      "new URL('/api/v1/branding/logo', options.url), {\n      method: 'POST',\n      redirect: 'follow'",
    ])
    await expect(verify(mutant)).rejects.toThrow()
  })
})
