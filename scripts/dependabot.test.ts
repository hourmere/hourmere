import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

// Dependabot must keep opening version updates in every npm directory. A configuration whose
// result is zero updates counts as updates off, whichever setting causes it. updatesOff()
// judges each npm entry, and each fixture is the real configuration with one such change.
// It rejects:
// - a pull request limit that is not a positive number;
// - an ignore rule named only "*", whatever versions or update types it lists;
// - ignore and allow rules, "*" wildcards included, that leave no direct dependency;
// - versioning-strategy lockfile-only when every dependency left is an exact version;
// - any target-branch, because a branch that does not exist cannot be detected offline;
// - a schedule that is not a fixed interval, because a cron expression may never fire.
// Where a rule cannot be judged exactly, it errs towards "off": an ignore rule with versions
// counts as silencing its dependencies, an allow rule for indirect dependencies allows no
// direct one, and peer dependencies are not counted.
// Limits, not judged: whether new versions exist upstream; ignore rules that keep one update
// type, such as majors only, for every dependency; and settings this test does not model,
// such as exclude-paths, registries or milestone.

interface Update {
  'package-ecosystem': string
  directory: string
  schedule?: unknown
  cooldown?: unknown
  groups?: unknown
  'open-pull-requests-limit'?: unknown
  ignore?: { 'dependency-name': string; versions?: string[]; 'update-types'?: string[] }[]
  allow?: { 'dependency-name'?: string; 'dependency-type'?: string }[]
  'versioning-strategy'?: string
  'target-branch'?: string
}
interface Config {
  updates: Update[]
}

const root = resolve(import.meta.dirname, '..')
const config = parse(readFileSync(resolve(root, '.github/dependabot.yml'), 'utf8')) as Config
const npmOf = ({ updates }: Config) =>
  updates.filter((update) => update['package-ecosystem'] === 'npm')
const npm = npmOf(config)

interface Manifest {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}
// A lockfile's own entries (the package and, at the root, its workspaces) mirror the
// package.json files Dependabot reads. Workspaces depend on each other with "*" and are
// never updated, so they are left out.
function directDependencies(directory: string) {
  const lockfile = resolve(root, directory.slice(1), 'package-lock.json')
  const { packages } = JSON.parse(readFileSync(lockfile, 'utf8')) as {
    packages: Record<string, Manifest>
  }
  const own = Object.entries(packages).filter(([path]) => !path.includes('node_modules/'))
  const workspaces = new Set(own.map(([, manifest]) => manifest.name))
  return own.flatMap(([, manifest]) =>
    (['dependencies', 'devDependencies', 'optionalDependencies'] as const).flatMap((type) =>
      Object.entries(manifest[type] ?? {})
        .filter(([name]) => !workspaces.has(name))
        .map(([name, spec]) => ({ name, spec, type })),
    ),
  )
}

const levels = ['major', 'minor', 'patch'].map((level) => `version-update:semver-${level}`)
type Rule = NonNullable<Update['ignore']>[number]
// Dependabot's "*" matches any run of characters, without regard to case.
const matches = (pattern: string, name: string) =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  ).test(name)
// A rule silences a dependency unless it keeps some update type. A versions list counts as
// silencing too, because this test cannot tell which versions it leaves.
const silences = (rule: Rule, name: string) =>
  matches(rule['dependency-name'], name) &&
  levels.every((level) => rule['update-types']?.includes(level) ?? true)

// With an allow list, only the direct dependencies one of its rules matches are updated.
// "indirect", or a type this test does not know, matches no direct dependency here.
const dependencyTypes: Record<string, string[]> = {
  all: ['dependencies', 'devDependencies', 'optionalDependencies'],
  direct: ['dependencies', 'devDependencies', 'optionalDependencies'],
  production: ['dependencies'],
  development: ['devDependencies'],
}
const allows = (rule: NonNullable<Update['allow']>[number], name: string, type: string) =>
  matches(rule['dependency-name'] ?? '*', name) &&
  (dependencyTypes[rule['dependency-type'] ?? 'all'] ?? []).includes(type)

// An exact version, optionally behind an npm: alias, is a range lockfile-only cannot leave.
const exact = (spec: string) =>
  /^=?v?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(spec.replace(/^npm:(?:@[^/]+\/)?[^@]+@/, ''))

const intervals = ['daily', 'weekly', 'monthly', 'quarterly', 'semiannually', 'yearly']

// Reasons why Dependabot would open no version-update pull request for an npm directory.
function updatesOff(candidate: Config) {
  const reasons: string[] = []
  for (const update of npmOf(candidate)) {
    const off = (reason: string) => reasons.push(`${update.directory}: ${reason}`)
    // A fixed interval always comes round; a cron expression may never fire (30 February).
    const { interval } = (update.schedule ?? {}) as { interval?: unknown }
    if (!intervals.includes(interval as string)) off('the schedule is not a fixed interval')
    // Whether a named branch exists cannot be checked offline; unset, updates target the
    // default branch, which always exists.
    if (update['target-branch'] !== undefined) off('target-branch is set')
    const limit = update['open-pull-requests-limit'] ?? 5
    if (typeof limit !== 'number' || limit <= 0) off('pull request limit is not positive')
    const ignore = update.ignore ?? []
    if (ignore.some((rule) => /^\*+$/.test(rule['dependency-name'])))
      off('an ignore rule names every dependency')
    const eligible = directDependencies(update.directory).filter(
      ({ name, type }) =>
        (update.allow?.some((rule) => allows(rule, name, type)) ?? true) &&
        !ignore.some((rule) => silences(rule, name)),
    )
    if (eligible.length === 0) off('no direct dependency is left for version updates')
    if (
      update['versioning-strategy'] === 'lockfile-only' &&
      eligible.every(({ spec }) => exact(spec))
    )
      off('lockfile-only cannot move an exact version')
  }
  return reasons
}

const entry = (candidate: Config, directory: string) =>
  npmOf(candidate).find((update) => update.directory === directory) as Update
const fixtures: { name: string; change: (candidate: Config) => void; reason: string }[] = [
  {
    name: 'a zero pull request limit',
    change: (candidate) => {
      entry(candidate, '/tools/n8n-nodes-hourmere')['open-pull-requests-limit'] = 0
    },
    reason: '/tools/n8n-nodes-hourmere: pull request limit is not positive',
  },
  {
    name: 'a pull request limit written as text',
    change: (candidate) => {
      entry(candidate, '/tools/n8n-nodes-hourmere')['open-pull-requests-limit'] = '0'
    },
    reason: '/tools/n8n-nodes-hourmere: pull request limit is not positive',
  },
  {
    name: 'an ignore of "*"',
    change: (candidate) => {
      entry(candidate, '/tools/zapier-hourmere').ignore = [{ 'dependency-name': '*' }]
    },
    reason: '/tools/zapier-hourmere: an ignore rule names every dependency',
  },
  {
    name: 'an ignore list naming every dependency',
    change: (candidate) => {
      entry(candidate, '/tools/zapier-hourmere').ignore = directDependencies(
        '/tools/zapier-hourmere',
      ).map(({ name }) => ({ 'dependency-name': name }))
    },
    reason: '/tools/zapier-hourmere: no direct dependency is left for version updates',
  },
  {
    name: 'prefix wildcards covering every name',
    change: (candidate) => {
      entry(candidate, '/tools/zapier-hourmere').ignore = [
        ...'@abcdefghijklmnopqrstuvwxyz0123456789',
      ].map((first) => ({ 'dependency-name': `${first}*` }))
    },
    reason: '/tools/zapier-hourmere: no direct dependency is left for version updates',
  },
  {
    name: 'an allow list of production dependencies where there are none',
    change: (candidate) => {
      entry(candidate, '/tools/n8n-nodes-hourmere').allow = [{ 'dependency-type': 'production' }]
    },
    reason: '/tools/n8n-nodes-hourmere: no direct dependency is left for version updates',
  },
  {
    name: 'lockfile-only updates of exact versions',
    change: (candidate) => {
      entry(candidate, '/tools/n8n-nodes-hourmere')['versioning-strategy'] = 'lockfile-only'
    },
    reason: '/tools/n8n-nodes-hourmere: lockfile-only cannot move an exact version',
  },
  {
    name: 'a target branch that does not exist',
    change: (candidate) => {
      entry(candidate, '/tools/zapier-hourmere')['target-branch'] = 'no-such-branch'
    },
    reason: '/tools/zapier-hourmere: target-branch is set',
  },
  {
    name: 'one schedule that never fires on every npm entry',
    change: (candidate) => {
      for (const update of npmOf(candidate))
        update.schedule = { interval: 'cron', cronjob: '0 0 30 2 *' }
    },
    reason: '/: the schedule is not a fixed interval',
  },
]

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

it('keeps version updates switched on in every npm directory', () => {
  expect(updatesOff(config)).toEqual([])
})

it.each(fixtures)('counts $name as updates off', ({ change, reason }) => {
  const candidate = structuredClone(config)
  change(candidate)
  expect(updatesOff(candidate)).toContain(reason)
})

it('leaves the n8n workflow pin and TypeScript majors to manual updates', () => {
  const n8n = npm.find((update) => update.directory === '/tools/n8n-nodes-hourmere')
  expect(n8n?.ignore).toEqual([
    { 'dependency-name': 'n8n-workflow' },
    { 'dependency-name': 'typescript', 'update-types': ['version-update:semver-major'] },
  ])
})
