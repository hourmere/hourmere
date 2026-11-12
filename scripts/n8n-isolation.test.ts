import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import rootConfig from '../vitest.config.ts'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const contractFile = 'tools/n8n-nodes-hourmere/contract.test.ts'
const forbidden =
  /(?:^|\/)(?:n8n(?:-[^/]*)?|@n8n|@n8n_io|@langchain|langchain|openai|isolated-vm|ssh2|eslint-plugin-n8n-nodes-base)(?:\/|$)/

it('includes the standalone n8n contract in the root node project', () => {
  expect(rootConfig.test?.projects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        test: expect.objectContaining({
          name: 'node',
          include: expect.arrayContaining([contractFile]),
        }),
      }),
    ]),
  )
})

it('collects the n8n contract through the root suite', async () => {
  // filesOnly checks discovery without loading tests or opening database pools.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      resolve(root, 'node_modules/vitest/vitest.mjs'),
      'list',
      contractFile,
      '--project',
      'node',
      '--filesOnly',
      '--json',
    ],
    { cwd: root, timeout: 15_000 },
  )
  expect(JSON.parse(stdout)).toEqual([{ file: resolve(root, contractFile), projectName: 'node' }])
}, 20_000)

it('keeps the n8n dependency graph outside root installs', () => {
  const manifest = JSON.parse(read('package.json'))
  expect(manifest.workspaces).toEqual([
    'apps/*',
    'packages/*',
    'tools/api-types',
    'tools/cli',
    'tools/e2e',
  ])
  const lock = JSON.parse(read('package-lock.json'))
  expect(lock.packages[''].workspaces).toEqual(manifest.workspaces)
  expect(Object.keys(lock.packages).filter((name) => forbidden.test(name))).toEqual([])
  for (const entry of Object.values(lock.packages) as Record<string, unknown>[]) {
    for (const kind of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      expect(
        Object.keys((entry[kind] ?? {}) as object).filter((name) => forbidden.test(name)),
      ).toEqual([])
    }
  }
  expect(manifest.scripts.lint).toBe('biome check .')
  const standalone = JSON.parse(read('tools/n8n-nodes-hourmere/package-lock.json'))
  expect(standalone.packages[''].name).toBe('n8n-nodes-hourmere')
  expect(standalone.packages['node_modules/n8n-workflow']).toBeDefined()
})

it('turns install scripts off by default in the standalone package', () => {
  const settings = read('tools/n8n-nodes-hourmere/.npmrc')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith(';'))
  expect(settings).toEqual(['ignore-scripts=true'])
})

it('keeps the standalone package private', () => {
  // The publication tests run only in n8n-compatibility; this keeps the guard in a required job.
  expect(JSON.parse(read('tools/n8n-nodes-hourmere/package.json')).private).toBe(true)
})

it('checks the standalone package in its own CI job', () => {
  const ci = parse(read('.github/workflows/ci.yml'))
  const job = ci.jobs['n8n-compatibility']
  expect(job.defaults.run['working-directory']).toBe('tools/n8n-nodes-hourmere')
  expect(
    job.steps.filter((step: { run?: string }) => step.run).map((step: { run: string }) => step.run),
  ).toEqual([
    'npm ci --ignore-scripts',
    'npm run lint',
    'npm run typecheck',
    'npm run build',
    'npm test',
  ])
  expect(
    job.steps.find(
      (step: { with?: Record<string, string> }) => step.with?.['cache-dependency-path'],
    )?.with['cache-dependency-path'],
  ).toBe('tools/n8n-nodes-hourmere/package-lock.json')
})
