import { appendFileSync } from 'node:fs'
import type { FullConfig, Reporter, Suite } from '@playwright/test/reporter'

// Only counts cross the job boundary. Test names and diagnostics stay with Playwright.
export default class ShardCountReporter implements Reporter {
  private total = 0

  preprocess({ suite }: { suite: Suite }) {
    this.total = suite.allTests().length
    return Promise.resolve()
  }

  onBegin(_config: FullConfig, suite: Suite) {
    const { GITHUB_OUTPUT, HOURMERE_E2E_SHARD } = process.env
    if (!GITHUB_OUTPUT || !HOURMERE_E2E_SHARD) throw new Error('Missing CI shard output settings')
    appendFileSync(
      GITHUB_OUTPUT,
      `shard_${HOURMERE_E2E_SHARD}=${suite.allTests().length}:${this.total}\n`,
    )
  }

  printsToStdio() {
    return false
  }
}
