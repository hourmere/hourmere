import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { attr, elements } from '../scripts/check-links.ts'
import { site } from './site.ts'

const root = process.env.HOURMERE_SITE_TEST_ROOT ?? fileURLToPath(new URL('../', import.meta.url))
const required = [
  'og:image',
  'og:image:width',
  'og:image:height',
  'og:image:alt',
  'twitter:card',
  'twitter:image',
  'twitter:image:alt',
]

describe('shared marketing and documentation head', () => {
  it('wires every marketing sharing field and the manifest into the shared layout', () => {
    const nodes = elements(readFileSync(join(root, 'src/layouts/Base.astro'), 'utf8'))
    for (const key of required) {
      expect(
        nodes.some(
          (node) =>
            node.tagName === 'meta' &&
            (attr(node, 'property') === key || attr(node, 'name') === key),
        ),
        key,
      ).toBe(true)
    }
    expect(
      nodes.some(
        (node) => attr(node, 'rel') === 'manifest' && attr(node, 'href') === '/site.webmanifest',
      ),
    ).toBe(true)
  })

  it('wires the same sharing metadata and manifest into the Starlight head', () => {
    const source = readFileSync(join(root, 'astro.config.ts'), 'utf8')
    const file = ts.createSourceFile('astro.config.ts', source, ts.ScriptTarget.Latest, true)
    let expression = ''
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'head')
        expression = node.initializer.getText(file)
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(expression).not.toBe('')
    const head = runInNewContext(`(${expression})`, { site, String }) as {
      tag: string
      attrs: Record<string, string>
    }[]
    for (const key of required)
      expect(
        head.some(
          (node) => node.tag === 'meta' && (node.attrs.property === key || node.attrs.name === key),
        ),
        key,
      ).toBe(true)
    expect(
      head.some((node) => node.attrs.rel === 'manifest' && node.attrs.href === '/site.webmanifest'),
    ).toBe(true)
  })
})
