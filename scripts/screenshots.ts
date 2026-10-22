/**
 * Rebuild and capture the README/docs product screenshots (no README edits):
 *
 *   npm ci --ignore-scripts
 *   HOURMERE_E2E_BOOTSTRAP_URL=postgres://hourmere:hourmere@localhost:5432/hourmere npm run screenshots
 *   # Regenerate into scratch space and compare with the committed set:
 *   HOURMERE_E2E_BOOTSTRAP_URL=postgres://hourmere:hourmere@localhost:5432/hourmere npm run screenshots -- --check
 *
 * Requires Node 26, PostgreSQL 18 with CREATE/DROP DATABASE permission, and installed
 * Google Chrome (the existing e2e chrome channel). In Codex this command MUST use
 * sandbox_permissions: "require_escalated" because it launches a browser.
 *
 * Reuses tools/e2e/fixtures.ts: a fresh helper-owned DB and real web-only server per
 * image, no .env/DATABASE_URL fallback, closed signup, no delivery workers or provider
 * credentials, and blocked non-fixture browser origins. Teardown verifies DB/listener
 * removal. Only synthetic English demo data is rendered. UTC, 2030-01-07T10:00Z,
 * 1280x720 desktop / 390x844 phone, device scale 2, reduced motion, disabled animations,
 * hidden carets, loaded fonts and settled layout are fixed. Chrome rasterization is
 * pinned to the CPU (--disable-gpu-rasterization) to avoid larger GPU border-AA outliers.
 * The one-time confirmation
 * management URL is replaced with a fixed hourmere.example.com example before capture.
 * No traces, videos or automatic failure screenshots.
 *
 * Uses the product's native system font stack without restyling it. Pixel comparisons
 * require the same OS/fonts and Chrome version; use one capture machine for a release.
 * No cross-platform pixel identity is promised. Like existing UI audits, only browser
 * time is pinned; advance the sample dates before January 2030 so server-side booking
 * validation still sees future meetings. Chrome can vary rounded-corner rasterisation:
 * images match only when dimensions match, every RGBA channel differs by at most 2,
 * and at most 64 pixels differ. --check uses this tolerance; write mode retains an
 * existing matching file's bytes to avoid PNG churn. sharp performs lossless PNG
 * compression with metadata stripped. The complete set must stay below 3 MB. Output
 * is staged and validated before replacing docs/assets/screenshots/*.png;
 * --check writes no assets.
 * Run again at the November 18 UI freeze and review every image before committing it.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { screenshotsWithinTolerance } from '../tools/e2e/screenshot-comparison.ts'
import {
  screenshotCases,
  validateScreenshotBytes,
  validateScreenshotImage,
  validateScreenshotSet,
} from '../tools/e2e/screenshot-plan.ts'

const root = fileURLToPath(new URL('../', import.meta.url))

async function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (status) => resolve(status ?? 1))
  })
  if (code !== 0) throw new Error(`Screenshot ${command} step exited ${code}`)
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check'))
    throw new Error('Usage: npm run screenshots [-- --check]')
  if (!process.env.HOURMERE_E2E_BOOTSTRAP_URL)
    throw new Error('Set HOURMERE_E2E_BOOTSTRAP_URL; no .env or DATABASE_URL fallback is used')
  const staging = await mkdtemp(join(tmpdir(), 'hourmere-product-screenshots-'))
  const destination = join(root, 'docs/assets/screenshots')
  try {
    const env = { ...process.env, TZ: 'UTC' }
    await run('npm', ['run', 'build', '--workspace', '@hourmere/web'], env)
    await run(
      process.execPath,
      [
        fileURLToPath(import.meta.resolve('@playwright/test/cli')),
        'test',
        '--config',
        'tools/e2e/playwright.screenshots.config.ts',
      ],
      {
        ...env,
        HOURMERE_SCREENSHOT_DIR: staging,
        HOURMERE_E2E_WEB_DIST: join(root, 'apps/web/dist'),
      },
    )
    validateScreenshotSet(await readdir(staging))
    const images = await Promise.all(
      screenshotCases.map(async ({ name }) => {
        const { data, info } = await sharp(await readFile(join(staging, name)))
          .png({ compressionLevel: 9, palette: false })
          .toBuffer({ resolveWithObject: true })
        validateScreenshotImage(name, info.width, info.height)
        const existing = await readFile(join(destination, name)).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        })
        const unchanged =
          existing !== undefined && (await screenshotsWithinTolerance(data, existing))
        return { name, data: unchanged ? existing : data, unchanged }
      }),
    )
    const bytes = images.reduce((sum, image) => sum + image.data.length, 0)
    validateScreenshotBytes(bytes)
    if (args[0] === '--check') {
      validateScreenshotSet(await readdir(destination))
      for (const { name, unchanged } of images)
        if (!unchanged) throw new Error(`Product screenshot differs: ${name}`)
    } else {
      await mkdir(destination, { recursive: true })
      for (const { name, data, unchanged } of images)
        if (!unchanged) await writeFile(join(destination, name), data)
    }
    console.log(
      `${images.length} product screenshots ${args[0] ? 'verified' : 'saved'} (${bytes} bytes)`,
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    // Child/browser/DB exceptions can include sensitive connection details.
    console.error(
      error instanceof Error &&
        /^(Usage:|Set HOURMERE|Product screenshot|Screenshot |Expected |Invalid |Unknown |Missing |Duplicate |Unexpected )/.test(
          error.message,
        )
        ? error.message
        : 'Product screenshot generation failed; inspect the fixture step above',
    )
    process.exitCode = 1
  })
