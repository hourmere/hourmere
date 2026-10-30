import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSatteriMarkdownProcessor } from '@astrojs/markdown-satteri'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import docsTablesPlugin, {
  classifyCell,
  type Node,
  SHORT_CODE_LENGTH,
  SHORT_TEXT_LENGTH,
  splitAtSeparators,
  transformTable,
  WHOLE_CODE_LENGTH,
  wrapsAtSeparators,
} from './docs-tables.ts'

const text = (value: string): Node => ({ type: 'text', value })
const element = (tagName: string, children: Node[] = [], properties = {}): Node => ({
  type: 'element',
  tagName,
  properties,
  children,
})
const code = (value: string) => element('code', [text(value)])
const serialize = (node: Node): string =>
  node.type === 'text'
    ? (node.value ?? '')
    : node.tagName === 'wbr'
      ? '<wbr>'
      : (node.children ?? []).map(serialize).join('')

describe('documentation table cell classification', () => {
  it.each([
    ['an identifier', [code('DATABASE_URL')], 'short'],
    ['a long identifier', [code('MICROSOFT_CALENDAR_CLIENT_SECRET')], 'short'],
    [
      'several identifiers',
      [code('GOOGLE_CLIENT_ID'), text(' / '), code('GOOGLE_CLIENT_SECRET')],
      'code',
    ],
    ['a short URL', [code('https://hourmere.com')], 'code'],
    ['a long path', [code('/api/v1/conference-connections/{id}/authorize-meetings')], 'code'],
    ['a label', [text('Required')], 'short'],
    ['a method', [text('GET')], 'short'],
    ['a short sentence', [text('Own safe metadata and availability; never tokens')], 'prose'],
    ['a label with a link', [text('See '), element('a', [text('docs')])], 'prose'],
    [
      'running text with code',
      [text('Required with SMTP, such as '), code('x'), text('.')],
      'prose',
    ],
    ['whitespace around an identifier', [text(' '), code('PORT'), text(' ')], 'short'],
  ])('classifies %s as %s', (_, children, kind) => {
    expect(classifyCell(element('td', children))).toBe(kind)
  })

  it('bounds the identifier and label lengths that stay on one line', () => {
    expect(classifyCell(element('td', [code('A'.repeat(SHORT_CODE_LENGTH))]))).toBe('short')
    expect(classifyCell(element('td', [code('A'.repeat(SHORT_CODE_LENGTH + 1))]))).toBe('code')
    expect(classifyCell(element('td', [text('a'.repeat(SHORT_TEXT_LENGTH))]))).toBe('short')
    expect(classifyCell(element('td', [text('a'.repeat(SHORT_TEXT_LENGTH + 1))]))).toBe('prose')
  })
})

describe('documentation table code wrapping', () => {
  it('keeps code up to the whole-code length intact and splits URLs and longer code', () => {
    expect(wrapsAtSeparators('A'.repeat(WHOLE_CODE_LENGTH))).toBe(false)
    expect(wrapsAtSeparators('A'.repeat(WHOLE_CODE_LENGTH + 1))).toBe(true)
    expect(wrapsAtSeparators('https://hourmere.com')).toBe(true)
  })

  it('adds a wrap opportunity after each run of separators, never inside a word', () => {
    const parts = splitAtSeparators('{PUBLIC_URL}/api/auth?x=1&y=2.json')
    expect(serialize(element('code', parts))).toBe(
      '{PUBLIC_<wbr>URL}/<wbr>api/<wbr>auth?<wbr>x=<wbr>1&<wbr>y=<wbr>2.<wbr>json',
    )
    expect(
      serialize(element('code', splitAtSeparators('postgres://hourmere@db:5432/hourmere'))),
    ).toBe('postgres://<wbr>hourmere@db:5432/<wbr>hourmere')
    expect(serialize(element('code', splitAtSeparators('conference-connections')))).toBe(
      'conference-connections',
    )
    // Leading and trailing separators offer no wrap point of their own.
    expect(splitAtSeparators('/api/')).toEqual([text('/api/')])
    expect(serialize(element('code', splitAtSeparators('/api/v1/')))).toBe('/api/<wbr>v1/')
    expect(splitAtSeparators('plain')).toEqual([text('plain')])
  })
})

describe('documentation table transform', () => {
  function table() {
    const th = (label: string) => element('th', [text(label)])
    const td = (children: Node[]) => element('td', children)
    const row = (cells: Node[]) => element('tr', [text('\n'), ...cells, text('\n')])
    const long = code('/api/v1/conference-connections/{id}/authorize-meetings')
    const short = code('DATABASE_URL')
    const cells = {
      short: td([short]),
      long: td([long]),
      prose: td([text('See '), code('docker-compose.yml:docker-compose.proxy.yml'), text('.')]),
    }
    const root = element('table', [
      element('thead', [row([th('Variable'), th('Path'), th('Meaning')])]),
      element('tbody', [row([cells.short, cells.long, cells.prose])]),
    ])
    return { root, cells, long, short }
  }

  it('labels, classifies and exposes each cell and only splits code that may wrap', () => {
    const { root, cells, long, short } = table()
    const properties: [Node, string, string][] = []
    const replaced: [Node, Node[]][] = []
    transformTable(root, {
      setProperty: (node, key, value) => properties.push([node, key, value]),
      replaceNode: (node, parts) => replaced.push([node, parts]),
    })
    const of = (node: Node) =>
      Object.fromEntries(properties.filter(([n]) => n === node).map(([, k, v]) => [k, v]))
    expect(of(root)).toEqual({ role: 'table' })
    expect(of(cells.short)).toEqual({
      role: 'cell',
      'data-cell': 'short',
      'data-label': 'Variable',
    })
    expect(of(cells.long)).toEqual({ role: 'cell', 'data-cell': 'code', 'data-label': 'Path' })
    expect(of(cells.prose)).toEqual({ role: 'cell', 'data-cell': 'prose', 'data-label': 'Meaning' })
    expect(properties.filter(([, key]) => key === 'role').map(([, , value]) => value)).toEqual([
      'table',
      'rowgroup',
      'rowgroup',
      'row',
      'row',
      'columnheader',
      'columnheader',
      'columnheader',
      'cell',
      'cell',
      'cell',
    ])
    // The identifier keeps a single text node; a <wbr> would break even unwrappable text.
    expect(replaced.map(([node]) => node)).not.toContain(short.children?.[0])
    expect(replaced).toHaveLength(2)
    expect(replaced[0]?.[0]).toBe(long.children?.[0])
    expect(serialize(element('code', replaced[0]?.[1] ?? []))).toBe(
      '/api/<wbr>v1/<wbr>conference-connections/<wbr>{id}/<wbr>authorize-meetings',
    )
    expect(serialize(element('code', replaced[1]?.[1] ?? []))).toBe(
      'docker-compose.<wbr>yml:docker-compose.<wbr>proxy.<wbr>yml',
    )
  })

  it('leaves existing roles alone and tolerates tables without a header row', () => {
    const cell = element('td', [text('Unset')])
    const root = element('table', [element('tbody', [element('tr', [cell])])], { role: 'grid' })
    const properties: [Node, string, string][] = []
    transformTable(root, {
      setProperty: (node, key, value) => properties.push([node, key, value]),
      replaceNode: () => {
        throw new Error('nothing to split')
      },
    })
    expect(properties.filter(([node]) => node === root)).toEqual([])
    expect(properties.filter(([node]) => node === cell)).toEqual([
      [cell, 'role', 'cell'],
      [cell, 'data-cell', 'short'],
    ])
  })
})

describe('documentation table rendering', () => {
  it('classifies the cells of a Markdown table through the Sätteri pipeline', async () => {
    const renderer = await createSatteriMarkdownProcessor({
      hastPlugins: [docsTablesPlugin()],
      syntaxHighlight: false,
    })
    const { code: html } = await renderer.render(
      [
        '| Variable | Default | Meaning |',
        '|---|---|---|',
        '| `DATABASE_URL` | Required | PostgreSQL URL, for example `postgres://hourmere@db:5432/hourmere`. |',
        '| `PUBLIC_URL` | `http://localhost:<PORT>` | Origin. |',
        '',
      ].join('\n'),
    )
    expect(html).toContain('<table role="table">')
    expect(html).toContain('<th role="columnheader">Variable</th>')
    expect(html).toContain(
      '<td role="cell" data-cell="short" data-label="Variable"><code>DATABASE_URL</code></td>',
    )
    expect(html).toContain('<td role="cell" data-cell="short" data-label="Default">Required</td>')
    expect(html).toContain(
      '<td role="cell" data-cell="prose" data-label="Meaning">PostgreSQL URL, for example <code>postgres://<wbr>hourmere@db:5432/<wbr>hourmere</code>.</td>',
    )
    expect(html).toContain(
      '<td role="cell" data-cell="code" data-label="Default"><code>http://<wbr>localhost:&lt;PORT&gt;</code></td>',
    )
    expect(html).toContain('<td role="cell" data-cell="short" data-label="Meaning">Origin.</td>')
  })
})

// Render the real newly published tables as well as the small synthetic classifier fixture.
const root = process.env.HOURMERE_DOCS_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))
const publishedTablePages = [
  ['webhooks', 4],
  ['cli', 1],
  ['notifications', 4],
  ['api-conventions', 6],
  ['google-calendar', 1],
  ['mcp', 3],
  ['zoom-connections', 2],
] as const

describe('published documentation table coverage', () => {
  it.each(publishedTablePages)('classifies and labels every cell in %s', async (page, count) => {
    const source = readFileSync(
      join(root, 'apps/site/src/content/docs/docs', `${page}.md`),
      'utf8',
    ).replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    const renderer = await createSatteriMarkdownProcessor({
      hastPlugins: [docsTablesPlugin()],
      syntaxHighlight: false,
    })
    const { code: html } = await renderer.render(source)
    const document = new JSDOM(html).window.document
    const tables = [...document.querySelectorAll('table')]
    expect(tables, page).toHaveLength(count)
    for (const table of tables) {
      expect(table.getAttribute('role')).toBe('table')
      const headers = [...table.querySelectorAll('thead th')].map((cell) =>
        (cell.textContent ?? '').trim(),
      )
      expect(headers.length).toBeGreaterThan(0)
      for (const row of table.querySelectorAll('tbody tr')) {
        const cells = [...row.querySelectorAll('td')]
        expect(cells).toHaveLength(headers.length)
        for (const [index, cell] of cells.entries()) {
          expect(cell.getAttribute('role')).toBe('cell')
          expect(['short', 'code', 'prose']).toContain(cell.getAttribute('data-cell'))
          expect(cell.getAttribute('data-label')).toBe(headers[index])
        }
      }
    }
  })
})
