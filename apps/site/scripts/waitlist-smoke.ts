// Local-only integration probe. Build the site first; no Cloudflare account is needed.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'hourmere-waitlist-smoke-'))
const state = join(scratch, 'state')
const freshState = join(scratch, 'fresh')
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: 'false',
  XDG_CONFIG_HOME: join(scratch, 'config'),
  WRANGLER_LOG_PATH: join(scratch, 'wrangler.log'),
}
const wrangler = ['--yes', 'wrangler@4.151.0']

function command(args: string[], persistTo = state): string {
  const result = spawnSync(
    'npx',
    [...wrangler, ...args, '--env', 'development', '--persist-to', persistTo],
    { cwd, env, encoding: 'utf8', timeout: 120_000 },
  )
  assert.equal(result.status, 0, `Local Wrangler command failed: ${result.stderr}`)
  return result.stdout
}

function query(sql: string, persistTo = state): Record<string, unknown>[] {
  const output = command(
    ['d1', 'execute', 'WAITLIST_DB', '--local', '--command', sql, '--json'],
    persistTo,
  )
  const results = JSON.parse(output) as { results: Record<string, unknown>[] }[]
  return results.flatMap((result) => result.results)
}

function waitlistRows(persistTo = state) {
  // Read the actual local D1 file without starting npx between rate-limited requests.
  // Repeated CLI startup can outlast the binding's 60-second window.
  const files = globSync('v3/d1/**/*.sqlite', { cwd: persistTo })
  const matches = []
  for (const file of files) {
    const database = new DatabaseSync(join(persistTo, file), { readOnly: true })
    try {
      if (database.prepare("SELECT name FROM sqlite_schema WHERE name = 'waitlist'").get()) {
        matches.push(database.prepare('SELECT * FROM waitlist').all())
      }
    } finally {
      database.close()
    }
  }
  assert.equal(matches.length, 1, 'Exactly one local D1 file must contain the waitlist table')
  return matches[0] ?? []
}

function migrate(persistTo = state) {
  command(['d1', 'migrations', 'apply', 'WAITLIST_DB', '--local'], persistTo)
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
  return port
}

let worker: ReturnType<typeof spawn> | undefined
async function stopWorker() {
  if (worker?.pid && worker.exitCode === null) {
    const stopped = new Promise<void>((resolve) => worker?.once('exit', () => resolve()))
    // The detached process group contains only this probe's npx/Wrangler/workerd.
    process.kill(-worker.pid, 'SIGTERM')
    await stopped
  }
}

try {
  // The first D1 migration has no predecessor waitlist schema. An unrelated populated
  // table proves applying it preserves data already in the database.
  query(
    "CREATE TABLE predecessor_probe (value TEXT); INSERT INTO predecessor_probe VALUES ('keep')",
  )
  migrate()
  assert.deepEqual(query('SELECT value FROM predecessor_probe'), [{ value: 'keep' }])
  migrate(freshState)
  const expectedColumns = ['email', 'created_at', 'source', 'locale', 'consent_text_version']
  for (const persistTo of [state, freshState]) {
    assert.deepEqual(
      query('PRAGMA table_info(waitlist)', persistTo).map((column) => column.name),
      expectedColumns,
    )
    assert.deepEqual(query('SELECT count(*) AS count FROM waitlist', persistTo), [{ count: 0 }])
  }

  async function startWorker(persistTo = state) {
    const port = await freePort()
    const origin = `http://127.0.0.1:${port}`
    let workerOutput = ''
    worker = spawn(
      'npx',
      [
        ...wrangler,
        'dev',
        '--local',
        '--env',
        'development',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--inspector-port',
        '0',
        '--persist-to',
        persistTo,
        '--log-level',
        'error',
      ],
      { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    worker.stdout?.on('data', (chunk: Buffer) => {
      workerOutput += chunk.toString()
    })
    worker.stderr?.on('data', (chunk: Buffer) => {
      workerOutput += chunk.toString()
    })
    let ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      assert.equal(worker.exitCode, null, `Local Worker exited: ${workerOutput}`)
      try {
        ready = (await fetch(origin)).ok
      } catch {
        // Only this newly started loopback listener is polled.
      }
      if (ready) break
      await delay(200)
    }
    assert(ready, `Local Worker did not become ready: ${workerOutput}`)
    return origin
  }
  let origin = await startWorker()

  for (const [path, file] of [
    ['/', 'index.html'],
    ['/privacy', 'privacy.html'],
    ['/terms', 'terms.html'],
    ['/docs/self-hosting', 'docs/self-hosting.html'],
    ['/missing-waitlist-smoke-page', '404.html'],
  ]) {
    assert(path && file)
    const response = await fetch(`${origin}${path}`, { redirect: 'manual' })
    assert.equal(response.status, path.startsWith('/missing-') ? 404 : 200)
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      await readFile(join(cwd, 'dist', file)),
    )
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY')
    assert.equal(response.headers.get('Referrer-Policy'), 'strict-origin-when-cross-origin')
    assert.equal(
      response.headers.get('Permissions-Policy'),
      'camera=(), microphone=(), geolocation=()',
    )
  }
  const canonical = await fetch(`${origin}/privacy/`, { redirect: 'manual' })
  assert.equal(canonical.status, 307)
  assert.equal(new URL(canonical.headers.get('Location') ?? '', origin).pathname, '/privacy')

  async function post(body: unknown) {
    const response = await fetch(`${origin}/api/waitlist`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    return response.text()
  }
  const first = await post({ email: ' Smoke@Example.test ', source: 'cloud', locale: 'en' })
  assert(!first.includes('smoke@example.test'))
  const stored = waitlistRows()
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.email, 'smoke@example.test')
  assert.equal(stored[0]?.source, 'cloud')
  assert.equal(stored[0]?.locale, 'en')
  assert.equal(stored[0]?.consent_text_version, '2026-10-22')
  assert(Number.isFinite(Date.parse(String(stored[0]?.created_at))))
  console.log('Valid address: HTTP 200; one normalized row stored.')
  const duplicate = await post({ email: 'smoke@example.test', source: 'pricing' })
  assert.equal(first, duplicate)
  assert.deepEqual(waitlistRows(), stored)
  console.log('Duplicate: HTTP 200; identical response and original metadata retained.')
  const honeypot = await post({ email: 'bot@example.test', hm_extra: 'filled' })
  assert.equal(first, honeypot)
  assert.deepEqual(waitlistRows(), stored)
  console.log('Honeypot: HTTP 200; identical response and no honeypot row stored.')

  const form = await fetch(`${origin}/api/waitlist`, {
    method: 'POST',
    headers: { Origin: origin },
    body: new URLSearchParams({
      email: 'smoke@example.test',
      source: 'faq',
      locale: 'en',
      hm_extra: '',
    }),
    redirect: 'manual',
  })
  assert.equal(form.status, 303)
  assert.equal(form.headers.get('Cache-Control'), 'no-store')
  assert.match(form.headers.get('Location') ?? '', /^\/\?waitlist=success#cloud-waitlist-success$/)
  assert.deepEqual(waitlistRows(), stored)

  // The site's JavaScript submits FormData and asks for a JSON response.
  const multipart = new FormData()
  multipart.set('email', 'smoke@example.test')
  multipart.set('source', 'cloud')
  multipart.set('locale', 'en')
  multipart.set('hm_extra', '')
  const enhancedForm = await fetch(`${origin}/api/waitlist`, {
    method: 'POST',
    headers: { Origin: origin, Accept: 'application/json' },
    body: multipart,
  })
  assert.equal(enhancedForm.status, 200)
  assert.equal(enhancedForm.headers.get('Cache-Control'), 'no-store')
  assert.equal(await enhancedForm.text(), first)
  assert.deepEqual(waitlistRows(), stored)

  // The preceding five requests share the actual local binding counter. Assert
  // rejected requests cannot write, including the native no-JavaScript response.
  for (let attempt = 0; attempt < 3; attempt++) {
    const limited = await fetch(`${origin}/api/waitlist`, {
      method: 'POST',
      headers: { Origin: origin },
      body: new URLSearchParams({ email: 'limited@example.test' }),
      redirect: 'manual',
    })
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('Retry-After'), '60')
    assert.equal(limited.headers.get('Cache-Control'), 'no-store')
    assert.match(await limited.text(), /Too many requests\. Please wait a minute and try again\./)
    assert.deepEqual(waitlistRows(), stored)
  }
  console.log('Rate limit: next three attempts HTTP 429 with Retry-After: 60; no row stored.')

  // Use this probe's separate fresh state and a new port for the validation case.
  // Miniflare supplies the client IP and can persist local binding counters, so
  // callers cannot select a second bucket by supplying a synthetic IP header.
  await stopWorker()
  origin = await startWorker(freshState)
  const invalid = await fetch(`${origin}/api/waitlist`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: 'invalid-address' }),
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.headers.get('Cache-Control'), 'no-store')
  assert.match(await invalid.text(), /Enter one valid email address/)
  assert.deepEqual(waitlistRows(freshState), [])
  console.log('Invalid address: HTTP 400; no row stored.')

  const oversizedBody = JSON.stringify({ email: 'oversized@example.test' }).padEnd(4097, ' ')
  const oversized = await fetch(`${origin}/api/waitlist`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(oversizedBody)),
      Accept: 'application/json',
    },
    body: oversizedBody,
  })
  assert.equal(oversized.status, 400)
  assert.equal(oversized.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual(waitlistRows(freshState), [])
  console.log('Oversized Content-Length (4097 bytes): HTTP 400; no row stored.')

  migrate()
  assert.deepEqual(waitlistRows(), stored)
  assert.deepEqual(query('SELECT value FROM predecessor_probe'), [{ value: 'keep' }])
  console.log(
    'Local waitlist smoke passed: 5 byte-identical pages, headers/404/redirect, JSON/URL-encoded/multipart POST, duplicate/invalid/honeypot/oversized Content-Length/rate-limit, migration preservation/fresh/no-op.',
  )
} finally {
  await stopWorker()
  await rm(scratch, { recursive: true, force: true })
}
