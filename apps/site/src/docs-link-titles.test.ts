import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const siteDocs = 'apps/site/src/content/docs/docs'

describe('published guide link labels', () => {
  it.each([
    `${siteDocs}/api-conventions.md`,
    `${siteDocs}/cli.md`,
    `${siteDocs}/mcp.md`,
    `${siteDocs}/notifications.md`,
    'docs/data-model.md',
  ])('uses readable page titles instead of filenames in %s', (path) => {
    const source = readFileSync(join(root, path), 'utf8')
    const links = [...source.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].filter(([, , target]) =>
      target?.match(/^(?:https:\/\/hourmere\.com)?\/docs(?:\/|#|$)/),
    )
    expect(links.length).toBeGreaterThan(0)
    for (const [, label, target] of links) {
      expect(label, `${path}: ${target}`).not.toMatch(/\.md\b/)
    }
  })
})
