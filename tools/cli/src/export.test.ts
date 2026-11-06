import { constants, readFileSync } from 'node:fs'
import { mkdtemp, open, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runCli } from './cli.ts'
import * as client from './client.ts'
import { downloadCsv, version } from './client.ts'

const origin = new URL('https://hourmere.example/mcp')
const path = '/api/v1/bookings/export.csv?from=2026-01-01T00%3A00%3A00Z'
const csv = '\ufeffname,answer\r\n中文,"line\nnext"\r\n'
const csvResponse = () =>
  new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8' } })

function sourceRunner(change: [string, string]): typeof runCli {
  let source = readFileSync('tools/cli/src/cli.ts', 'utf8')
  expect(source.includes(change[0])).toBe(true)
  source = stripTypeScriptTypes(
    source.replace(...change).replace(/^import[\s\S]*?from '[^']+'\n/gm, ''),
  ).replace(/\bexport /g, '')
  const bindings = { constants, open, unlink, ...client }
  return new Function(...Object.keys(bindings), `${source}; return runCli`)(
    ...Object.values(bindings),
  )
}

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

  it.each(['export_in_progress', 'organization_context_changed'])(
    'reports the API conflict code %s',
    async (code) => {
      await expect(
        downloadCsv({
          url: origin,
          key: 'hm_test',
          path,
          fetch: async () => Response.json({ error: code }, { status: 409 }),
          write: async () => {},
        }),
      ).rejects.toMatchObject({ code, status: 409 })
    },
  )
  async function failedFile(existing: boolean, runner = runCli) {
    const directory = await mkdtemp(join(tmpdir(), 'hourmere-export-failure-'))
    const output = join(directory, 'bookings.csv')
    try {
      if (existing) await writeFile(output, 'existing contents')
      let reads = 0
      const code = await runner({
        argv: ['export', '--output', output],
        env: { HOURMERE_URL: origin.origin, HOURMERE_API_KEY: 'hm_test' },
        stdin: (async function* () {})(),
        stdout: () => {},
        stderr: () => {},
        fetch: async (_url, options) =>
          options?.method === 'POST'
            ? Response.json({
                jsonrpc: '2.0',
                id: 1,
                result: { structuredContent: { downloadPath: path } },
              })
            : new Response(
                new ReadableStream(
                  {
                    pull(controller) {
                      if (reads++ === 0) controller.enqueue(new TextEncoder().encode('partial'))
                      else controller.error(new Error('connection lost'))
                    },
                  },
                  { highWaterMark: 0 },
                ),
                { headers: { 'content-type': 'text/csv' } },
              ),
      })
      expect(code).not.toBe(0)
      if (existing) expect(await readFile(output, 'utf8')).toBe('existing contents')
      else await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true })
    }
  }
  it.each([false, true])(
    'removes its failed export file and preserves existing files (%s)',
    async (existing) => failedFile(existing),
  )
  it('kills removal of failed-file cleanup in a source copy', async () => {
    await failedFile(false)
    await expect(
      failedFile(
        false,
        sourceRunner(['await unlink(exportOutputPath).catch(() => {})', 'void exportOutputPath']),
      ),
    ).rejects.toMatchObject({ name: 'AssertionError' })
    await failedFile(false)
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
    const conflict = async (download: typeof downloadCsv) => {
      await expect(
        download({
          url: origin,
          key: 'hm_test',
          path,
          fetch: async () => Response.json({ error: 'export_in_progress' }, { status: 409 }),
          write: async () => {},
        }),
      ).rejects.toMatchObject({ code: 'export_in_progress', status: 409 })
    }
    await conflict(baseline)
    const conflictMutant = new Function(
      'version',
      `${source.replace("safeCode(isObject(reply) ? reply.error : undefined, 'http_error')", "'http_error'").replace("safeCode(isObject(reply) ? reply.error : undefined, 'http_error')", "'http_error'")}; return downloadCsv`,
    )(version) as typeof downloadCsv
    await expect(conflict(conflictMutant)).rejects.toMatchObject({ name: 'AssertionError' })

    const mutant = new Function(
      'version',
      `${source.replaceAll("redirect: 'error'", "redirect: 'follow'")}; return downloadCsv`,
    )(version) as typeof downloadCsv
    await expect(security(mutant)).rejects.toThrow()
  })
})
