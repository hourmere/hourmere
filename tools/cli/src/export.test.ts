import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'
import { downloadCsv, version } from './client.ts'

const origin = new URL('https://hourmere.example/mcp')
const path = '/api/v1/bookings/export.csv?from=2026-01-01T00%3A00%3A00Z'
const csv = '\ufeffname,answer\r\n中文,"line\nnext"\r\n'
const csvResponse = () =>
  new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8' } })

describe('CSV CLI', () => {
  it('streams CSV bytes to stdout or a new private file, preserving BOM and Unicode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-export-'))
    try {
      for (const output of [undefined, join(directory, 'bookings.csv')]) {
        let stdout = ''
        const fetcher = vi.fn<typeof fetch>(async (_url, options) =>
          options?.method === 'POST'
            ? Response.json({
                jsonrpc: '2.0',
                id: 1,
                result: { structuredContent: { downloadPath: path } },
              })
            : csvResponse(),
        )
        const code = await runCli({
          argv: ['export', ...(output ? ['--output', output] : [])],
          env: { HOURMERE_URL: origin.origin, HOURMERE_API_KEY: 'hm_test' },
          stdin: (async function* () {})(),
          stdout: (text) => {
            stdout += text
          },
          stderr: () => {},
          fetch: fetcher,
        })
        expect(code).toBe(0)
        expect(output ? await readFile(output, 'utf8') : stdout).toBe(csv)
        if (output) expect((await stat(output)).mode & 0o777).toBe(0o600)
        expect(fetcher).toHaveBeenCalledTimes(2)
      }
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  async function security(download = downloadCsv) {
    for (const unsafe of [
      'https://evil.example/api/v1/bookings/export.csv?',
      '/api/v1/bookings/export.csv?x=1#fragment',
    ]) {
      const fetcher = vi.fn<typeof fetch>(async () => csvResponse())
      await expect(
        download({
          url: origin,
          key: 'hm_test',
          path: unsafe,
          fetch: fetcher,
          write: async () => {},
        }),
      ).rejects.toThrow('invalid_response')
      expect(fetcher).not.toHaveBeenCalled()
    }
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.redirect).toBe('error')
      return csvResponse()
    })
    await download({ url: origin, key: 'hm_test', path, fetch: fetcher, write: async () => {} })
  }
  it('refuses untrusted pointers and redirects before forwarding credentials', async () =>
    security())
  it('awaits each output write before reading more and handles split Unicode', async () => {
    const bytes = new TextEncoder().encode(csv)
    let completed = 0
    let text = ''
    await downloadCsv({
      url: origin,
      key: 'hm_test',
      path,
      fetch: async () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                if (completed >= bytes.length) return controller.close()
                controller.enqueue(bytes.subarray(completed, completed + 1))
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { 'content-type': 'text/csv' } },
        ),
      write: async (chunk) => {
        await Promise.resolve()
        text += chunk
        completed++
      },
    })
    expect(text).toBe(csv)
  })
  it('kills removed redirect protection in a source copy', async () => {
    let source = readFileSync('tools/cli/src/client.ts', 'utf8')
    source = source.replace(
      /export const \{ version \} = JSON.parse\([\s\S]*?as \{ version: string \}/,
      '',
    )
    source = stripTypeScriptTypes(source.replace(/^import[^\n]+\n/gm, '')).replace(/\bexport /g, '')
    const baseline = new Function('version', `${source}; return downloadCsv`)(
      version,
    ) as typeof downloadCsv
    await security(baseline)
    const mutant = new Function(
      'version',
      `${source.replaceAll("redirect: 'error'", "redirect: 'follow'")}; return downloadCsv`,
    )(version) as typeof downloadCsv
    await expect(security(mutant)).rejects.toThrow()
  })
})
