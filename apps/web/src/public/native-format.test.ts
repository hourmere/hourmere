import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('allows native Node audit tools to import the product date formatters without Vite', () => {
  const format = pathToFileURL(resolve('apps/web/src/format.ts')).href
  const time = pathToFileURL(resolve('apps/web/src/public/time.ts')).href
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import assert from 'node:assert/strict'
      import { zoned } from ${JSON.stringify(format)}
      import { formatDate, formatTime } from ${JSON.stringify(time)}
      const start = '2026-11-02T14:00:00Z'
      for (const locale of ['en-GB', 'zh-CN', 'de-DE']) {
        const formatter = zoned('America/New_York', locale)
        assert.equal(formatter.longDate(start), formatDate(Date.parse(start), 'America/New_York', locale))
        assert.equal(formatter.time(start), formatTime(Date.parse(start), 'America/New_York', locale))
      }
    `,
    ],
    { encoding: 'utf8', timeout: 10000 },
  )
  expect(result.status, result.stderr).toBe(0)
})
