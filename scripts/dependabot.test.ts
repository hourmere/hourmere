import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

interface Update {
  'package-ecosystem': string
  directory: string
  schedule?: unknown
  cooldown?: unknown
  groups?: unknown
  ignore?: { 'dependency-name': string; 'update-types'?: string[] }[]
}

const root = resolve(import.meta.dirname, '..')
const { updates } = parse(readFileSync(resolve(root, '.github/dependabot.yml'), 'utf8')) as {
  updates: Update[]
}
const npm = updates.filter((update) => update['package-ecosystem'] === 'npm')

it('updates every committed npm lockfile on the root schedule and grouping', () => {
  // Standalone packages outside the root workspaces have their own lockfiles.
  const lockfiles = execFileSync('git', ['ls-files', '-z', '--', ':(glob)**/package-lock.json'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
  expect(lockfiles).toContain('tools/n8n-nodes-hourmere/package-lock.json')
  expect(lockfiles).toContain('tools/zapier-hourmere/package-lock.json')
  expect(npm.map((update) => update.directory).sort()).toEqual(
    lockfiles.map((path) => (path === 'package-lock.json' ? '/' : `/${dirname(path)}`)).sort(),
  )
  const policy = ({ schedule, cooldown, groups }: Update) => ({ schedule, cooldown, groups })
  const rootPolicy = policy(npm.find((update) => update.directory === '/') as Update)
  for (const update of npm) expect(policy(update), update.directory).toEqual(rootPolicy)
})

it('leaves the n8n workflow pin and TypeScript majors to manual updates', () => {
  const n8n = npm.find((update) => update.directory === '/tools/n8n-nodes-hourmere')
  expect(n8n?.ignore).toEqual([
    { 'dependency-name': 'n8n-workflow' },
    { 'dependency-name': 'typescript', 'update-types': ['version-update:semver-major'] },
  ])
})
