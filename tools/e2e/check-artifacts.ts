import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface ProbeSuite {
  suites?: ProbeSuite[]
  specs?: { tests: { results: { errors?: { message?: string }[] }[] }[] }[]
}
interface ProbeReport extends ProbeSuite {
  errors: unknown[]
  stats: { unexpected: number; expected: number; skipped: number }
}
function messages(suite: ProbeSuite): string[] {
  return [
    ...(suite.specs ?? []).flatMap((spec) =>
      spec.tests.flatMap((test) =>
        test.results.flatMap((result) => (result.errors ?? []).map((error) => error.message ?? '')),
      ),
    ),
    ...(suite.suites ?? []).flatMap(messages),
  ]
}

const root = fileURLToPath(new URL('../../', import.meta.url))
await mkdir(join(root, 'temp'), { recursive: true })
const directory = await mkdtemp(join(root, 'temp/e2e-artifact-guard-'))
const config = join(directory, 'playwright.config.ts')
try {
  await writeFile(
    config,
    `import config from ${JSON.stringify(join(root, 'tools/e2e/playwright.config.ts'))}
if(process.env.HOURMERE_ARTIFACT_GUARD_CONTROL) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT
export default {...config,testDir:'.',testMatch:'guard.spec.ts',projects:[{name:'artifact-guard'}],timeout:15000,globalTimeout:30000,preserveOutput:'always',outputDir:'./output',reporter:'json'}
`,
  )
  await writeFile(
    join(directory, 'guard.spec.ts'),
    `import {test,expect} from ${JSON.stringify(join(root, 'tools/e2e/fixtures.ts'))}
test('intentional non-secret failure artifact probe',async({page})=>{
  await page.route('**/*',route=>route.abort('blockedbyclient'))
  const marker=['DOM','PRIVACY','CANARY','NONSECRET'].join('_')
  await page.setContent(\`<label>Private link<input readonly value="\${marker}"></label><p>\${marker}</p>\`)
  await expect(page.getByRole('heading',{name:'Absent non-secret heading'})).toBeVisible({timeout:500})
})
`,
  )
  for (const control of [false, true]) {
    const reportPath = join(directory, control ? 'control-report.json' : 'guarded-report.json')
    const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath }
    if (control) env.HOURMERE_ARTIFACT_GUARD_CONTROL = '1'
    else delete env.HOURMERE_ARTIFACT_GUARD_CONTROL
    const exit = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', '--config', config],
        { cwd: root, env, stdio: 'ignore' },
      )
      child.once('error', reject)
      child.once('close', resolve)
    })
    const reportText = await readFile(reportPath, 'utf8')
    const marker = ['DOM', 'PRIVACY', 'CANARY', 'NONSECRET'].join('_')
    if (!control && reportText.includes(marker))
      throw new Error('Guarded locator failure leaked DOM into its JSON report')
    const report = JSON.parse(reportText) as ProbeReport
    const expectedFailure = messages(report).some(
      (message) => message.includes('toBeVisible') && message.includes('Expected:'),
    )
    if (
      exit !== 1 ||
      report.errors.length ||
      report.stats.unexpected !== 1 ||
      report.stats.expected !== 0 ||
      report.stats.skipped !== 0 ||
      !expectedFailure
    )
      throw new Error('Artifact probe did not reach its intentional assertion failure')
    const output = join(directory, 'output')
    let captured = false
    for (const path of await readdir(output, { recursive: true })) {
      if (!path.endsWith('.md')) continue
      const text = await readFile(join(output, path), 'utf8')
      captured ||= text.includes(marker)
    }
    if (captured !== control)
      throw new Error('Failure DOM capture does not match the guarded/control expectation')
  }
  console.log('Failure artifact privacy guard passed; removed-guard control detected DOM capture')
} finally {
  await rm(directory, { recursive: true, force: true })
}
