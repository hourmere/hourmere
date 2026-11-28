import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { parse } from 'yaml'
import { expect, test } from '../site-fixtures.ts'

// Real-browser geometry belongs to CI. Local runs need an explicitly escalated shell.
test.skip(!process.env.CI, 'Static-site rendering regression runs in CI')

const legalPages = [
  { path: '/privacy', firstSection: '#scope' },
  { path: '/terms', firstSection: '#the-service' },
]

for (const { path } of legalPages) {
  test(`${path} preserves its default legal layout sizes`, async ({
    page,
    siteOrigin,
  }, testInfo) => {
    await open(page, siteOrigin, path)
    const article = page.locator('article.legal')
    const narrow = testInfo.project.name === 'site-mobile'
    await expect(page.locator('html')).toHaveCSS('font-size', '16px')
    await expect(article).toHaveCSS('width', narrow ? '360px' : '800px')
    await expect(article).toHaveCSS('padding-block', '56px 80px')
    await expect(article.locator('h1')).toHaveCSS('font-size', narrow ? '34px' : '46px')
    await expect(article.locator('.eyebrow')).toHaveCSS('font-size', '14px')
    await expect(article.locator('.effective').first()).toHaveCSS('font-size', '17px')
    await expect(article.locator('.callout').first()).toHaveCSS('padding', '16px 20px')
    await expect(article.locator('.prose > h2').first()).toHaveCSS('font-size', '26px')
    await expect(article.locator('.toc ol')).toHaveCSS('column-width', '240px')
    await expect(article.locator('.back-to-contents a').first()).toHaveCSS('min-height', '44px')
  })
}

// Use a separate worker fixture for Chrome's default font size. The CSS viewport still stays at 320px.
const largeTextTest = test.extend({
  launchOptions: [{ args: ['--blink-settings=defaultFontSize=32'] }, { scope: 'worker' }],
})

for (const { path, firstSection } of legalPages) {
  largeTextTest(`${path} fits at 320px at 200% browser text size`, async ({ page, siteOrigin }) => {
    await page.setViewportSize({ width: 320, height: 844 })
    await open(page, siteOrigin, path)
    const article = page.locator('article.legal')
    const contents = article.getByRole('navigation', { name: 'Contents' })
    const returnLink = article.locator('.back-to-contents a').first()
    await expect(page.locator('html')).toHaveCSS('font-size', '32px')
    await expect(article.locator('h1')).toHaveCSS('font-size', '68px')
    await expect(article.locator('.eyebrow')).toHaveCSS('font-size', '28px')
    await expect(article.locator('.effective').first()).toHaveCSS('font-size', '34px')
    await expect(article.locator('.prose > h2').first()).toHaveCSS('font-size', '52px')
    await expect(contents.getByRole('heading')).toHaveCSS('font-size', '32px')
    await expect(returnLink).toHaveCSS('font-size', '30px')
    await expect(returnLink).toHaveCSS('min-height', '88px')

    const layout = await article.evaluate((element) => {
      const root = document.documentElement
      const blocks = [...element.querySelectorAll('h1, h2, h3, p, li')]
      // Inline glyph bounds can extend vertically beyond a heading's line box. Check
      // vertical clipping only where an overflow rule would actually hide content.
      const clipped = [element, ...element.querySelectorAll('*')]
        .filter((box) => {
          const { overflowX, overflowY } = getComputedStyle(box)
          return (
            (['hidden', 'clip'].includes(overflowX) && box.scrollWidth > box.clientWidth + 1) ||
            (['hidden', 'clip'].includes(overflowY) && box.scrollHeight > box.clientHeight + 1)
          )
        })
        .map((box) => box.textContent?.trim().slice(0, 60) ?? box.tagName)
      const overlapping: string[] = []
      let previousBottom = 0
      for (const block of blocks) {
        const bounds = block.getBoundingClientRect()
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue
          if (node.parentElement?.closest('h1, h2, h3, p, li') !== block) continue
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const rect of range.getClientRects()) {
            if (!rect.width) continue
            if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) {
              clipped.push(node.textContent.trim().slice(0, 60))
            }
          }
        }
        if (bounds.top < previousBottom - 1) {
          overlapping.push(block.textContent?.trim().slice(0, 60) ?? block.tagName)
        }
        // A parent list item can contain another checked block.
        if (!block.querySelector('h1, h2, h3, p, li')) {
          previousBottom = Math.max(previousBottom, bounds.bottom)
        }
      }
      return {
        viewport: root.clientWidth,
        scrollWidth: Math.max(root.scrollWidth, document.body.scrollWidth),
        clipped,
        overlapping,
      }
    })
    expect(layout).toEqual({ viewport: 320, scrollWidth: 320, clipped: [], overlapping: [] })

    await contents.getByRole('link').first().click()
    await expect(page).toHaveURL(new URL(path + firstSection, siteOrigin).href)
    await expect(article.locator(firstSection)).toBeInViewport()
    await returnLink.click()
    await expect(page).toHaveURL(new URL(`${path}#contents`, siteOrigin).href)
    await expect(contents.getByRole('heading')).toBeInViewport()
  })
}

// Every published documentation page whose Markdown holds a table. The route drops the
// extension, and index.md is the /docs landing page.
function pagesWithTables() {
  const directory = fileURLToPath(
    new URL('../../../apps/site/src/content/docs/docs/', import.meta.url),
  )
  return readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .filter((file) => {
      const source = readFileSync(directory + file, 'utf8')
      const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? ''
      return parse(frontmatter)?.draft !== true && /^\|[\s:-]*-[\s:|-]*\|\s*$/m.test(source)
    })
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
    let clippedHeaders = 0
    let visibleHeaders = 0
    const narrowColumns: string[] = []
    const label = (cell: Element) =>
      `${cell.getAttribute('data-label')}: ${(cell.textContent ?? '').trim().slice(0, 40)}`
    for (const table of tables) {
      const head = table.querySelector('thead')
      if (head) {
        const bounds = head.getBoundingClientRect()
        const style = getComputedStyle(head)
        if (style.position === 'absolute' && style.clipPath === 'inset(50%)') {
          if (bounds.width <= 1 && bounds.height <= 1) clippedHeaders++
        } else if (bounds.width > 1 && bounds.height > 1 && style.visibility === 'visible') {
          visibleHeaders++
        }
      }
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
      clippedHeaders,
      visibleHeaders,
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
    expect(layout.clippedHeaders, 'Stacked cards visually conceal the header row').toBe(
      layout.tables,
    )
    expect(layout.missingLabels, 'Every stacked cell shows its column header').toBe(0)
    expect(layout.scrollingTables, 'Stacked cards never scroll horizontally').toBe(0)
  } else {
    expect(layout.visibleHeaders, 'Table headers are visible').toBe(layout.tables)
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

test('the configuration tables stack at 1200px and preserve the URL breakpoints', async ({
  page,
  siteOrigin,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'site-desktop', 'Desktop viewport coverage')
  await page.setViewportSize({ width: 1200, height: 1000 })
  await open(page, siteOrigin, '/docs/configuration')

  const layout = await tableLayout(page)
  expect(layout.cards, 'The documentation column between both sidebars uses cards').toBe(true)
  assertTables(layout)

  const url = 'postgres://hourmere@db:5432/hourmere'
  const example = page.locator('td code').filter({ hasText: url })
  await expect(example).toHaveText(url)
  expect(
    await example
      .locator('wbr')
      .evaluateAll((breaks) => breaks.map((point) => point.previousSibling?.textContent)),
  ).toEqual(['postgres://', 'hourmere@db:5432/'])
})

test('at 320px the full identifier fits and table headers remain accessible', async ({
  page,
  siteOrigin,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'site-mobile', 'Mobile viewport coverage')
  await page.setViewportSize({ width: 320, height: 844 })
  await open(page, siteOrigin, '/docs/configuration')

  const layout = await tableLayout(page)
  expect(layout.cards).toBe(true)
  expect(layout.clippedHeaders, 'Every header row is visually clipped').toBe(layout.tables)
  expect(layout.missingLabels).toBe(0)
  expect(layout.overflow).toBeLessThanOrEqual(1)
  expect(layout.scrollingTables).toBe(0)

  const identifier = 'MICROSOFT_CALENDAR_CLIENT_SECRET'
  const cell = page.locator('td[data-label="Variable"]').filter({ hasText: identifier })
  const table = page.getByRole('table').filter({ has: cell })
  await expect(table.getByRole('columnheader', { name: 'Variable', exact: true })).toHaveCount(1)
  const code = cell.locator('code')
  await expect(code).toHaveText(identifier)
  expect(
    await code.evaluate((element) => {
      const bounds = element.closest('td')?.getBoundingClientRect()
      if (!bounds) throw new Error('Missing identifier cell')
      const range = document.createRange()
      range.selectNodeContents(element)
      const lines = [...range.getClientRects()].filter((rect) => rect.width > 0)
      return (
        lines.length > 0 &&
        lines.every(
          (rect) =>
            rect.left >= bounds.left - 1 &&
            rect.right <= bounds.right + 1 &&
            rect.top >= bounds.top - 1 &&
            rect.bottom <= bounds.bottom + 1,
        )
      )
    }),
    'The identifier is readable inside its own cell',
  ).toBe(true)
})

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
      .sl-markdown-content thead {
        position: static !important;
        clip-path: none !important;
        width: auto !important;
        height: auto !important;
        overflow: visible !important;
      }
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
  }, testInfo) => {
    if (testInfo.project.name === 'site-mobile') {
      await page.setViewportSize({ width: 320, height: 844 })
    }
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
