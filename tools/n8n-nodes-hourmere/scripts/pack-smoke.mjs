import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
const documentation = ['README.md', 'CHANGELOG.md', 'LICENSE']
const [releaseTarball] = process.argv.slice(2)
const scratch = await mkdtemp(join(tmpdir(), 'hourmere-n8n-pack-'))
try {
  await writeFile(join(scratch, 'user.npmrc'), '')
  await writeFile(join(scratch, 'global.npmrc'), '')
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    npm_config_cache: join(scratch, 'cache'),
    npm_config_userconfig: join(scratch, 'user.npmrc'),
    npm_config_globalconfig: join(scratch, 'global.npmrc'),
    npm_config_offline: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }
  const npm = (args, cwd = packageDirectory) =>
    execFileSync('npm', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'))
  assert.equal(manifest.private, true)
  assert.deepEqual(manifest.publishConfig, { registry: 'https://registry.invalid/' })
  let packDirectory = packageDirectory
  if (releaseTarball) {
    // Run the committed guard explicitly: npm skips prepublishOnly for a tarball.
    execFileSync('npm', ['run', 'prepublishOnly', '--ignore-scripts=false'], {
      cwd: packageDirectory,
      env: { ...env, HOURMERE_N8N_PUBLISH: process.env.HOURMERE_N8N_PUBLISH },
      stdio: 'inherit',
    })
    packDirectory = join(scratch, 'release')
    await mkdir(packDirectory)
    await cp(join(packageDirectory, 'dist'), join(packDirectory, 'dist'), { recursive: true })
    for (const file of documentation) {
      await copyFile(join(packageDirectory, file), join(packDirectory, file))
    }
    delete manifest.private
    delete manifest.scripts.prepublishOnly
    manifest.publishConfig = { registry: 'https://registry.npmjs.org/' }
    await writeFile(join(packDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }
  const [pack] = JSON.parse(
    npm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], packDirectory),
  )
  const paths = pack.files.map(({ path }) => path)
  const rootFiles = [...documentation, 'package.json']
  assert.deepEqual(paths.filter((path) => !path.includes('/')).sort(), rootFiles.sort())
  assert(
    paths.every(
      (path) => rootFiles.includes(path) || /^dist\/.+\.(?:js|d\.ts|json|svg)$/.test(path),
    ),
    'Tarball contains an unexpected file',
  )
  assert(paths.every((path) => !/\.test\.|\.env|mutation/.test(path)))
  const install = join(scratch, 'install')
  // n8n supplies its own workflow peer. Keep this smoke install offline and install
  // the exact tested peer by linking the standalone copy after the tarball is unpacked.
  npm(
    [
      'install',
      '--prefix',
      install,
      '--ignore-scripts',
      '--legacy-peer-deps',
      '--omit=dev',
      '--no-package-lock',
      join(scratch, pack.filename),
    ],
    scratch,
  )
  const hostModules = join(install, 'node_modules')
  await symlink(
    dirname(require.resolve('n8n-workflow/package.json')),
    join(hostModules, 'n8n-workflow'),
  )
  const installed = join(hostModules, 'n8n-nodes-hourmere')
  const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.deepEqual(installedManifest, manifest)
  assert.deepEqual(installedManifest.peerDependencies, { 'n8n-workflow': '*' })
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const root = ${JSON.stringify(installed)};
    const p = require(path.join(root, 'package.json'));
    for (const file of [...p.n8n.nodes, ...p.n8n.credentials]) {
      const exports = require(path.join(root, file));
      const Constructor = Object.values(exports)[0];
      const instance = new Constructor();
      assert(instance.description || instance.authenticate);
      if (!instance.description) continue;
      for (const icon of Object.values(instance.description.icon)) {
        assert(fs.existsSync(path.join(root, path.dirname(file), icon.slice(5))));
      }
      assert(fs.existsSync(path.join(root, file.replace('.node.js', '.node.json'))));
      for (const locale of ['zh', 'zh-CN']) {
        assert(fs.existsSync(path.join(root, path.dirname(file), 'translations', locale,
          'n8n-nodes-hourmere.' + instance.description.name + '.json')));
      }
    }
  `
  execFileSync(process.execPath, ['-e', script], {
    cwd: install,
    env: { PATH: process.env.PATH },
    stdio: 'pipe',
  })
  console.log(
    `Packed install smoke passed: ${pack.files.length} files; both nodes, credentials, icons and translations load.`,
  )
  if (releaseTarball) {
    await copyFile(join(scratch, pack.filename), releaseTarball, constants.COPYFILE_EXCL)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
