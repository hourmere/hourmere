import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from '../site-fixtures.ts'

// Real-browser geometry belongs to CI. Local runs need an explicitly escalated shell.
test.skip(!process.env.CI, 'Static-site rendering regression runs in CI')

// Every documentation page whose Markdown holds a table, so a new page is covered as soon as
// it is written. The route drops the extension; index.md is the /docs landing page.
function pagesWithTables() {
  const directory = fileURLToPath(
    new URL('../../../apps/site/src/content/docs/docs/', import.meta.url),
  )
  return readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .filter((file) => /^\|[\s:-]*-[\s:|-]*\|\s*$/m.test(readFileSync(directory + file, 'utf8')))
    .map((file) => (file === 'index.md' ? '/docs' : `/docs/${file.slice(0, -3)}`))
    .sort()
}

// Minimum column widths by cell kind, in CSS pixels; see apps/site/src/styles/starlight.css.
const minimum = { code: 11 * 16, prose: 15 * 16, card: 16 * 16 }

async function tableLayout(page: Page) {
  return page.evaluate((minimum) => {
    const pixels = (value: number) => Math.round(value)
    function lineCount(rects: Iterable<DOMRect>) {
      const tops: number[] = []
      for (const rect of rects) {
        if (rect.width <= 0 || rect.height <= 0) continue
        if (!tops.some((top) => Math.abs(top - rect.top) < 4)) tops.push(rect.top)
      }
      return tops.length
    }
    function textNodes(element: Element) {
      const nodes: Text[] = []
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? '').trim()) nodes.push(node as Text)
      }
      return nodes
    }
    // Rendered lines of an element, counted from its text so inline code boxes do not count.
    function lines(element: Element) {
      const rects: DOMRect[] = []
      for (const node of textNodes(element)) {
        const range = document.createRange()
        range.selectNodeContents(node)
        rects.push(...range.getClientRects())
      }
      return lineCount(rects)
    }
    // Letter or digit runs rendered across several line boxes: a break inside a word.
    // Punctuation, spaces and the build-time <wbr> points are legitimate boundaries.
    function brokenWords(element: Element) {
      const broken: string[] = []
      for (const node of textNodes(element)) {
        for (const match of (node.textContent ?? '').matchAll(/[\p{L}\p{N}]+/gu)) {
          const range = document.createRange()
          range.setStart(node, match.index)
          range.setEnd(node, match.index + match[0].length)
          if (lineCount(range.getClientRects()) > 1) broken.push(match[0])
        }
      }
      return broken
    }
    const content = document.querySelector('.sl-markdown-content')
    if (!content) throw new Error('No documentation content')
    const contentWidth = content.getBoundingClientRect().width
    const tables = [...content.querySelectorAll('table')]
    const firstRow = tables[0]?.querySelector('tbody tr')
    const cards = firstRow ? getComputedStyle(firstRow).display === 'block' : false
    const cells = [...content.querySelectorAll('tbody td')]
    const kinds = cells.map((cell) => cell.getAttribute('data-cell'))
    const narrowColumns: string[] = []
    const label = (cell: Element) =>
      `${cell.getAttribute('data-label')}: ${(cell.textContent ?? '').trim().slice(0, 40)}`
    for (const table of tables) {
      for (const row of table.querySelectorAll('tbody tr')) {
        for (const cell of row.children) {
          const kind = cell.getAttribute('data-cell')
          const width = cell.getBoundingClientRect().width
          const floor = cards
            ? minimum.card
            : kind === 'prose'
              ? minimum.prose
              : kind === 'code'
                ? minimum.code
                : 0
          if (width + 1 < floor) narrowColumns.push(`${label(cell)} (${pixels(width)}px)`)
        }
      }
    }
    return {
      cards,
      contentWidth: pixels(contentWidth),
      overflow:
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
        document.documentElement.clientWidth,
      tables: tables.length,
      cells: cells.length,
      unclassified: cells.filter(
        (_, index) => !['short', 'code', 'prose'].includes(kinds[index] ?? ''),
      ).length,
      unlabelled: cells.filter((cell) => !cell.getAttribute('data-label')).length,
      // Tables wider than their container clip the page; scrolling ones must say so.
      wideTables: tables.filter((table) => table.getBoundingClientRect().width > contentWidth + 1)
        .length,
      unscrollable: tables.filter(
        (table) =>
          table.scrollWidth > table.clientWidth + 1 && getComputedStyle(table).overflowX !== 'auto',
      ).length,
      scrollingTables: tables.filter((table) => table.scrollWidth > table.clientWidth + 1).length,
      hiddenHeaders: tables.filter((table) => {
        const head = table.querySelector('thead')
        return head ? getComputedStyle(head).display === 'none' : true
      }).length,
      missingLabels: cards
        ? cells.filter(
            (cell) =>
              !getComputedStyle(cell, '::before').content.includes(
                cell.getAttribute('data-label') ?? '\u0000',
              ),
          ).length
        : 0,
      brokenHeaderWords: [...content.querySelectorAll('th')].flatMap(brokenWords),
      brokenWords: cells.flatMap((cell) => brokenWords(cell)),
      wrappedShortValues: cells
        .filter((cell) => cell.getAttribute('data-cell') === 'short' && lines(cell) > 1)
        .map(label),
      crowdedCode: [...content.querySelectorAll('td[data-cell="code"] code')]
        .map((code) => ({ code: code.textContent, lines: lines(code) }))
        .filter(({ lines }) => lines > 3),
      overflowingCells: cells.filter((cell) => cell.scrollWidth > cell.clientWidth + 1).map(label),
      narrowColumns,
      tallestRow: pixels(
        Math.max(
          0,
          ...[...content.querySelectorAll('tbody tr')].map(
            (row) => row.getBoundingClientRect().height,
          ),
        ),
      ),
    }
  }, minimum)
}

type Layout = Awaited<ReturnType<typeof tableLayout>>

function assertTables(layout: Layout) {
  expect(layout.tables, 'The page contains real documentation tables').toBeGreaterThan(0)
  expect(layout.cells, 'The table cells were measured').toBeGreaterThan(0)
  expect(layout.unclassified, 'Every cell carries its build-time kind').toBe(0)
  expect(layout.unlabelled, 'Every cell carries its column header').toBe(0)
  expect(layout.overflow, 'Documentation tables stay inside the page viewport').toBeLessThanOrEqual(
    1,
  )
  expect(layout.wideTables, 'Tables never exceed the content column').toBe(0)
  expect(layout.unscrollable, 'A table wider than its content scrolls horizontally').toBe(0)
  expect(layout.brokenHeaderWords, 'Table headers never wrap inside a word').toEqual([])
  expect(layout.brokenWords, 'Prose and code never wrap inside a word').toEqual([])
  expect(layout.wrappedShortValues, 'Short values and identifiers stay on one line').toEqual([])
  expect(layout.crowdedCode, 'Long code wraps at a few separator points at most').toEqual([])
  expect(layout.overflowingCells, 'Cell content never overflows its cell').toEqual([])
  expect(layout.narrowColumns, 'Columns keep their readable minimum width').toEqual([])
  if (layout.cards) {
    expect(layout.hiddenHeaders, 'Stacked cards label cells instead of showing headers').toBe(
      layout.tables,
    )
    expect(layout.missingLabels, 'Every stacked cell shows its column header').toBe(0)
    expect(layout.scrollingTables, 'Stacked cards never scroll horizontally').toBe(0)
  } else {
    expect(layout.hiddenHeaders, 'Table headers are visible').toBe(0)
  }
}

async function open(page: Page, siteOrigin: string, path: string) {
  const response = await page.goto(siteOrigin + path)
  expect(response?.status(), 'The built documentation route exists').toBe(200)
  await page.evaluate(() => document.fonts.ready)
}

const pages = pagesWithTables()

test('the documentation pages with tables are known', () => {
  expect(pages).toEqual(
    expect.arrayContaining([
      '/docs/comparison',
      '/docs/configuration',
      '/docs/mcp',
      '/docs/zoom-connections',
    ]),
  )
})

for (const path of pages) {
  test(`${path} tables read well`, async ({ page, siteOrigin }, testInfo) => {
    await open(page, siteOrigin, path)
    const layout = await tableLayout(page)
    // The 360px project stacks rows as cards; the desktop project keeps the table grid.
    expect(layout.cards, 'Narrow screens stack rows; wide screens keep the grid').toBe(
      testInfo.project.name === 'site-mobile',
    )
    assertTables(layout)
  })
}

test('table geometry assertions reject squeezed columns, wrapped words and page overflow', async ({
  page,
  siteOrigin,
}) => {
  await open(page, siteOrigin, '/docs/configuration')
  const squeezed = await page.addStyleTag({
    // Reintroduce blanket wrapping and squeeze every cell, so each oracle has a deterministic
    // negative control independently of the font metrics. The stacked layout hides the
    // header row, so show it again for the header oracle.
    content: `
      .sl-markdown-content thead { display: block !important; }
      .sl-markdown-content :is(th, td),
      .sl-markdown-content td code {
        overflow-wrap: anywhere !important;
        white-space: normal !important;
        min-width: 0 !important;
        max-width: 5ch !important;
        width: 5ch !important;
        display: block !important;
      }
    `,
  })
  try {
    const wrapped = await tableLayout(page)
    expect(wrapped.brokenHeaderWords.length).toBeGreaterThan(0)
    expect(wrapped.brokenWords.length).toBeGreaterThan(0)
    expect(wrapped.wrappedShortValues.length).toBeGreaterThan(0)
    expect(wrapped.crowdedCode.length).toBeGreaterThan(0)
    expect(wrapped.narrowColumns.length).toBeGreaterThan(0)
    const clean = {
      ...wrapped,
      brokenHeaderWords: [],
      brokenWords: [],
      wrappedShortValues: [],
      crowdedCode: [],
      narrowColumns: [],
      overflowingCells: [],
    }
    for (const [key, message] of [
      ['brokenHeaderWords', 'Table headers never wrap inside a word'],
      ['brokenWords', 'Prose and code never wrap inside a word'],
      ['wrappedShortValues', 'Short values and identifiers stay on one line'],
      ['crowdedCode', 'Long code wraps at a few separator points at most'],
      ['narrowColumns', 'Columns keep their readable minimum width'],
    ] as const) {
      expect(() => assertTables({ ...clean, [key]: wrapped[key] })).toThrow(message)
    }
  } finally {
    await squeezed.evaluate((element) => element.parentNode?.removeChild(element))
  }
  const uncontained = await page.addStyleTag({
    content:
      '.sl-markdown-content table { width: 200vw !important; max-width: none !important; overflow: visible !important; }',
  })
  try {
    const overflow = await tableLayout(page)
    expect(() => assertTables(overflow)).toThrow(
      'Documentation tables stay inside the page viewport',
    )
  } finally {
    await uncontained.evaluate((element) => element.parentNode?.removeChild(element))
  }
  assertTables(await tableLayout(page))
})

async function copyLayout(page: Page) {
  return page.locator('.expressive-code .frame:has(.copy button)').evaluateAll((frames) =>
    frames.map((frame) => {
      const button = frame.querySelector('.copy button')
      const pre = frame.querySelector('pre')
      if (!button || !pre) return { overlapsCode: true, overlapsText: true }
      const buttonRect = button.getBoundingClientRect()
      const preRect = pre.getBoundingClientRect()
      const intersects = (rect: DOMRect) =>
        rect.left < buttonRect.right &&
        rect.right > buttonRect.left &&
        rect.top < buttonRect.bottom &&
        rect.bottom > buttonRect.top
      const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
      let overlapsText = false
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent ?? '').trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        overlapsText ||= [...range.getClientRects()].some(intersects)
      }
      return { overlapsCode: intersects(preRect), overlapsText }
    }),
  )
}

function assertCopy(layout: Awaited<ReturnType<typeof copyLayout>>) {
  expect(layout.length, 'The self-hosting code blocks were measured').toBeGreaterThan(0)
  expect(
    layout.filter((block) => block.overlapsCode || block.overlapsText),
    'Touch copy buttons clear both the code area and its text',
  ).toEqual([])
}

test.describe('touch copy controls', () => {
  test.use({ hasTouch: true })

  test('self-hosting copy buttons leave every code block readable', async ({
    page,
    siteOrigin,
  }) => {
    await open(page, siteOrigin, '/docs/self-hosting')
    assertCopy(await copyLayout(page))
    const regression = await page.addStyleTag({
      // Reintroduce upstream's overlay position, including on unwrapped dotenv code.
      content: `
        .expressive-code .frame > .copy {
          position: absolute !important;
          inset: 0 0 auto auto !important;
          padding: 0 !important;
          margin: 0 !important;
        }
      `,
    })
    try {
      const overlapped = await copyLayout(page)
      expect(() => assertCopy(overlapped)).toThrow(
        'Touch copy buttons clear both the code area and its text',
      )
    } finally {
      await regression.evaluate((element) => element.parentNode?.removeChild(element))
    }
    assertCopy(await copyLayout(page))
  })
})
