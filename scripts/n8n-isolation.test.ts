import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const forbidden =
  /(?:^|\/)(?:n8n(?:-[^/]*)?|@n8n|@langchain|langchain|openai|isolated-vm|ssh2|eslint-plugin-n8n-nodes-base)(?:\/|$)/

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
