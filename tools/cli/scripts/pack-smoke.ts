import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertCliOutput,
  assertPackage,
  assertPackedScripts,
  assertPackFiles,
} from './pack-check.ts'

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
  // Exercise npm's actual publication lifecycle outside the five-second unit
  // test budget. Offline dry-run never sends the package to a registry.
  const unpublished = join(root, 'unpublished')
  await mkdir(unpublished)
  await writeFile(join(unpublished, 'package.json'), JSON.stringify(manifest))
  const publication = spawnSync('npm', ['publish', '--dry-run', '--offline'], {
    cwd: unpublished,
    env,
    encoding: 'utf8',
  })
  assert.equal(publication.status, 1)
  assert.match(publication.stdout, /node dist\/index.js --version/)
  assert.match(publication.stderr, /MODULE_NOT_FOUND/)

  // Compile the real Node compatibility probe for both inherited configs.
  // Keep this semantic check in the existing Node 22/24 integration job.
  for (const name of ['tsconfig.json', 'tsconfig.build.json']) {
    const directory = join(root, name)
    await mkdir(directory)
    const configPath = join(directory, 'tsconfig.json')
    await writeFile(
      join(directory, 'probe.ts'),
      `void fetch(new Request(new URL('https://hourmere.example.invalid/mcp'), {
        signal: AbortSignal.timeout(30_000),
      })).then((response: Response) => response.json())
      // @ts-expect-error Node 22 has no native Temporal API.
      Temporal.Now.instant()
      export {}
      `,
    )
    await writeFile(
      configPath,
      JSON.stringify({
        extends: join(packageDirectory, name),
        compilerOptions: {
          noEmit: true,
          rootDir: directory,
          typeRoots: [fileURLToPath(new URL('../../../node_modules/@types', import.meta.url))],
        },
        include: ['probe.ts'],
      }),
    )
    const compiler = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url))
    const diagnostics = execFileSync(compiler, ['-p', configPath, '--pretty', 'false'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.equal(diagnostics, '')
  }
  // Development scripts stay at the repository root, outside the published manifest.
  npm(['run', 'cli:build'], fileURLToPath(new URL('../../..', import.meta.url)))
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
      '--engine-strict',
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
  assertPackedScripts(installedManifest, packed[0]?.files.map((file) => file.path) ?? [])
  const run = (flag: string) =>
    execFileSync(join(installDirectory, 'node_modules', '.bin', 'hourmere'), [flag], {
      cwd: root,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  assertCliOutput(run('--help'), run('--version'), manifest.version)
  assertCliOutput(
    npm(['start', '--silent', '--', '--help'], installed),
    run('--version'),
    manifest.version,
  )
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
