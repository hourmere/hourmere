import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditShardArgs } from './layout-shards.ts'

const suite = process.argv[2]
if (!suite || !['layout', 'a11y', 'visual', 'cross-engine'].includes(suite)) {
  throw new Error('Expected layout, a11y, visual or cross-engine')
}
const root = fileURLToPath(new URL('../../', import.meta.url))
const directory = resolve(root, process.env.HOURMERE_UI_REPORT_DIR ?? 'temp/ui-audit-reports')
const blocking = process.env.HOURMERE_UI_BLOCKING === '1'
const failOnExit = process.env.HOURMERE_UI_FAIL_ON_EXIT === '1'
const playwrightArgs = process.argv.slice(3)
const shardFlag = playwrightArgs.indexOf('--shard')
const separatedShard = playwrightArgs[shardFlag + 1]
if (shardFlag >= 0 && separatedShard)
  playwrightArgs.splice(shardFlag, 2, `--shard=${separatedShard}`)
const args = playwrightArgs.flatMap((arg) =>
  arg.startsWith('--shard=') ? auditShardArgs(suite, arg.slice(8)) : [arg],
)
await mkdir(directory, { recursive: true })
const exitCode = await new Promise<number>((resolveExit) => {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve('@playwright/test/cli')),
      'test',
      '--config',
      'tools/e2e/playwright.audit.config.ts',
      ...args,
    ],
    {
      cwd: root,
      env: { ...process.env, HOURMERE_UI_SUITE: suite, HOURMERE_UI_REPORT_DIR: directory },
      stdio: 'inherit',
    },
  )
  child.once('error', () => resolveExit(1))
  child.once('close', (code) => resolveExit(code ?? 1))
})
await writeFile(
  resolve(directory, `${suite}-execution.json`),
  `${JSON.stringify({ schemaVersion: 1, kind: 'execution', suite, exitCode, blocking }, null, 2)}\n`,
)
console.log(`UI measurement ${suite}: browser exit ${exitCode}; blocking=${blocking}`)
process.exitCode = blocking || failOnExit ? exitCode : 0
