import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { screenshotsWithinTolerance } from '../tools/e2e/screenshot-comparison.ts'
import { validateScreenshotBytes } from '../tools/e2e/screenshot-plan.ts'

const source = readFileSync('scripts/screenshots.ts', 'utf8')
const destination = '/fixture/docs/assets/screenshots/example.png'

async function png(delta = 0, compressionLevel = 9) {
  const pixels = Buffer.alloc(10 * 10 * 4, 128)
  for (let pixel = 0; pixel < 100; pixel++) pixels[pixel * 4 + 3] = 255
  pixels[0] = 128 + delta
  return sharp(pixels, { raw: { width: 10, height: 10, channels: 4 } })
    .png({ compressionLevel, palette: false })
    .toBuffer()
}

// Execute the runner's main function from source, replacing only its I/O dependencies.
// Real sharp encoding and pixel comparison exercise both output modes without Chrome.
async function runOutput(capture: Buffer, existing?: Buffer, check = false, copy = source) {
  const files = new Map([['/staging/example.png', capture]])
  if (existing) files.set(destination, existing)
  const writes: string[] = []
  const removed: string[] = []
  let validatedBytes = 0
  const mainSource = stripTypeScriptTypes(
    copy.slice(copy.indexOf('export async function main'), copy.indexOf('\nif (import.meta.main)')),
  )
    .replace('export async function', 'async function')
    .replace("fileURLToPath(import.meta.resolve('@playwright/test/cli'))", "'playwright-cli'")
  const dependencies = {
    process: { env: { HOURMERE_E2E_BOOTSTRAP_URL: 'postgres://fixture.invalid/postgres' } },
    root: '/fixture',
    tmpdir: () => '/tmp',
    join,
    mkdtemp: async () => '/staging',
    mkdir: async () => {},
    rm: async (path: string) => removed.push(path),
    run: async () => {},
    readdir: async () => ['example.png'],
    readFile: async (path: string) => {
      const data = files.get(path)
      if (!data) throw Object.assign(new Error('Missing fixture file'), { code: 'ENOENT' })
      return data
    },
    writeFile: async (path: string, data: Buffer) => {
      writes.push(path)
      files.set(path, data)
    },
    sharp,
    screenshotsWithinTolerance,
    screenshotCases: [{ name: 'example.png' }],
    validateScreenshotSet: (names: string[]) => expect(names).toEqual(['example.png']),
    validateScreenshotImage: () => {},
    validateScreenshotBytes: (bytes: number) => {
      validatedBytes = bytes
      validateScreenshotBytes(bytes)
    },
    console: { log: () => {} },
  }
  const main = new Function(...Object.keys(dependencies), `${mainSource}; return main`)(
    ...Object.values(dependencies),
  ) as (args: string[]) => Promise<void>
  await main(check ? ['--check'] : [])
  expect(removed, 'runner cleans its staging directory').toEqual(['/staging'])
  return { files, writes, validatedBytes }
}

async function verifyTolerantWrite(copy = source) {
  const existing = await png(0, 0)
  const capture = await png(1)
  const { files, writes, validatedBytes } = await runOutput(capture, existing, false, copy)
  expect(files.get(destination), 'matching writes retain the original PNG bytes').toEqual(existing)
  expect(writes, 'matching files are not rewritten').toEqual([])
  expect(validatedBytes, 'size budget counts the retained file bytes').toBe(existing.length)
}

async function verifyTolerantCheck(copy = source) {
  const result = runOutput(await png(1), await png(), true, copy)
  await expect(result, 'check accepts jitter within tolerance').resolves.toBeDefined()
  const { writes } = await result
  expect(writes, 'check mode never writes assets').toEqual([])
}

describe('product screenshot output', () => {
  it('keeps existing bytes for a capture within tolerance', () => verifyTolerantWrite())
  it('accepts rasterisation jitter in check mode without writing assets', () =>
    verifyTolerantCheck())
  it('keeps differently encoded identical pixels in write mode', async () => {
    const existing = await png(0, 0)
    const capture = await png()
    expect(capture.equals(existing)).toBe(false)
    const { files, writes } = await runOutput(capture, existing)
    expect(files.get(destination)).toEqual(existing)
    expect(writes).toEqual([])
  })
  it('writes a new file and replaces changes beyond tolerance', async () => {
    const capture = await png(3)
    for (const existing of [undefined, await png()]) {
      const { files, writes } = await runOutput(capture, existing)
      expect(writes).toEqual([destination])
      expect(await screenshotsWithinTolerance(files.get(destination) as Buffer, capture)).toBe(true)
    }
  })
  it('rejects a changed or missing image in check mode', async () => {
    for (const existing of [undefined, await png()])
      await expect(runOutput(await png(3), existing, true)).rejects.toThrow(
        'Product screenshot differs: example.png',
      )
  })

  it('passes the unmutated source copy in both modes', async () => {
    await verifyTolerantWrite(source)
    await verifyTolerantCheck(source)
  })
  it('detects byte comparison replacing tolerant comparison', async () => {
    const mutant = source.replace(
      'await screenshotsWithinTolerance(data, existing)',
      'data.equals(existing)',
    )
    expect(mutant).not.toBe(source)
    await expect(verifyTolerantCheck(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects counting capture bytes instead of the retained file bytes', async () => {
    const mutant = source.replace('data: unchanged ? existing : data', 'data')
    expect(mutant).not.toBe(source)
    await expect(verifyTolerantWrite(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
  })
  it('detects rewriting a matching file', async () => {
    const mutant = source.replace('if (!unchanged) await writeFile', 'await writeFile')
    expect(mutant).not.toBe(source)
    await expect(verifyTolerantWrite(mutant)).rejects.toMatchObject({ name: 'AssertionError' })
  })
})
