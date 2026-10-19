import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCliOutput, assertPackage, assertPackFiles } from './pack-check.ts'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'hourmere-cli-pack-'))
try {
  const userConfig = join(root, 'user.npmrc')
  const globalConfig = join(root, 'global.npmrc')
  await writeFile(userConfig, '')
  await writeFile(globalConfig, '')
  // Deliberately omit credentials, NODE_OPTIONS and user npm configuration. Neither packing
  // nor installing this dependency-free tarball needs registry access or lifecycle installs.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    npm_config_cache: join(root, 'cache'),
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }
  const npm = (args: string[], cwd = packageDirectory) =>
    execFileSync('npm', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
  assertPackage(manifest)
  const dryRun = JSON.parse(npm(['pack', '--dry-run', '--json'])) as {
    files: { path: string }[]
  }[]
  assertPackFiles(dryRun[0]?.files.map((file) => file.path) ?? [])
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', root])) as {
    filename: string
    files: { path: string }[]
  }[]
  assertPackFiles(packed[0]?.files.map((file) => file.path) ?? [])
  const tarball = join(root, packed[0]?.filename ?? '')
  const installDirectory = join(root, 'install')
  npm(
    [
      'install',
      '--prefix',
      installDirectory,
      '--ignore-scripts',
      '--omit=dev',
      '--no-package-lock',
      '--offline',
      tarball,
    ],
    root,
  )
  const installed = join(installDirectory, 'node_modules', '@hourmere', 'cli')
  const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assertPackage(installedManifest)
  const run = (flag: string) =>
    execFileSync(join(installDirectory, 'node_modules', '.bin', 'hourmere'), [flag], {
      cwd: root,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  assertCliOutput(run('--help'), run('--version'), manifest.version)
  // Also invoke the compiled entrypoint directly with plain Node, outside the workspace.
  const plainNodeVersion = execFileSync(
    process.execPath,
    [join(installed, 'dist/index.js'), '--version'],
    {
      cwd: root,
      env: {},
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  assertCliOutput(run('--help'), plainNodeVersion, manifest.version)
  console.log(`Packed ${manifest.name}@${manifest.version}: ${dryRun[0]?.files.length} files`)
  for (const { path } of dryRun[0]?.files ?? []) console.log(`  ${path}`)
  console.log('Packed CLI install, --help, --version and plain Node smoke checks passed.')
} finally {
  await rm(root, { recursive: true, force: true })
}
