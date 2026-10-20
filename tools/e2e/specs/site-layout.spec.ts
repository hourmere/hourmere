import type { Page } from '@playwright/test'
import { expect, test } from '../site-fixtures.ts'

// Real-browser geometry belongs to CI. Local runs need an explicitly escalated shell.
test.skip(!process.env.CI, 'Static-site rendering regression runs in CI')

async function tableLayout(page: Page) {
  return page.evaluate(() => {
    function lineCount(rects: DOMRectList) {
      const tops: number[] = []
      for (const rect of rects) {
        if (rect.width <= 0 || rect.height <= 0) continue
        if (!tops.some((top) => Math.abs(top - rect.top) < 1)) tops.push(rect.top)
      }
      return tops.length
    }
    const identifiers = [...document.querySelectorAll('.sl-markdown-content td:first-child code')]
    const headers = [...document.querySelectorAll('.sl-markdown-content th')]
    return {
      overflow:
        Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
        document.documentElement.clientWidth,
      tables: document.querySelectorAll('.sl-markdown-content table').length,
      identifiers: identifiers.length,
      crowdedIdentifiers: identifiers.flatMap((code) => {
        const range = document.createRange()
        range.selectNodeContents(code)
        const lineHeight = Number.parseFloat(getComputedStyle(code).lineHeight)
        const lines = lineCount(range.getClientRects())
        const heightInLines = range.getBoundingClientRect().height / lineHeight
        return lines > 2 || heightInLines > 2.15
          ? [{ identifier: code.textContent, lines, heightInLines }]
          : []
      }),
      headers: headers.length,
      brokenHeaderWords: headers.flatMap((header) => {
        const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT)
        const broken: string[] = []
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          // Punctuation and spaces are legal word boundaries; a letter/number word is not.
          for (const match of (node.textContent ?? '').matchAll(/[\p{L}\p{N}]+/gu)) {
            const range = document.createRange()
            range.setStart(node, match.index)
            range.setEnd(node, match.index + match[0].length)
            if (lineCount(range.getClientRects()) > 1) broken.push(match[0])
          }
        }
        return broken
      }),
    }
  })
}

function assertTables(layout: Awaited<ReturnType<typeof tableLayout>>, identifiers: boolean) {
  expect(layout.tables, 'The page contains real documentation tables').toBeGreaterThan(0)
  expect(layout.headers, 'The table headers were measured').toBeGreaterThan(0)
  if (identifiers)
    expect(layout.identifiers, 'The identifier column was measured').toBeGreaterThan(0)
  expect(layout.overflow, 'Documentation tables stay inside the page viewport').toBeLessThanOrEqual(
    1,
  )
  expect(
    layout.crowdedIdentifiers,
    'First-column identifiers use at most two rendered lines',
  ).toEqual([])
  expect(layout.brokenHeaderWords, 'Table headers never wrap inside a word').toEqual([])
}

async function open(page: Page, siteOrigin: string, path: string) {
  const response = await page.goto(siteOrigin + path)
  expect(response?.status(), 'The built documentation route exists').toBe(200)
  await page.evaluate(() => document.fonts.ready)
}

for (const path of ['/docs/configuration', '/docs/mcp', '/docs/comparison']) {
  test(`${path} keeps table identifiers and headers readable`, async ({ page, siteOrigin }) => {
    await open(page, siteOrigin, path)
    assertTables(await tableLayout(page), path !== '/docs/comparison')
  })
}

test('table geometry assertions reject arbitrary wrapping and page overflow', async ({
  page,
  siteOrigin,
}) => {
  await open(page, siteOrigin, '/docs/configuration')
  const regression = await page.addStyleTag({
    // Restore the rejected blanket wrapping rule. Constrain the first cells as well so
    // each oracle has a deterministic negative control independently of font metrics.
    content: `
      .sl-markdown-content :is(th, td),
      .sl-markdown-content :is(th, td) code {
        overflow-wrap: anywhere !important;
        white-space: normal !important;
        word-break: normal !important;
      }
      .sl-markdown-content td:first-child { min-width: 0 !important; }
      .sl-markdown-content td:first-child code,
      .sl-markdown-content th:first-child {
        display: block !important;
        width: 3ch !important;
        min-width: 0 !important;
      }
    `,
  })
  try {
    const wrapped = await tableLayout(page)
    expect(wrapped.crowdedIdentifiers.length).toBeGreaterThan(0)
    expect(wrapped.brokenHeaderWords.length).toBeGreaterThan(0)
    expect(() => assertTables({ ...wrapped, overflow: 0, brokenHeaderWords: [] }, true)).toThrow(
      'First-column identifiers use at most two rendered lines',
    )
    expect(() => assertTables({ ...wrapped, overflow: 0, crowdedIdentifiers: [] }, true)).toThrow(
      'Table headers never wrap inside a word',
    )
  } finally {
    await regression.evaluate((element) => element.parentNode?.removeChild(element))
  }
  const uncontained = await page.addStyleTag({
    content:
      '.sl-markdown-content table { width: 200vw !important; max-width: none !important; overflow: visible !important; }',
  })
  try {
    const overflow = await tableLayout(page)
    expect(() => assertTables(overflow, true)).toThrow(
      'Documentation tables stay inside the page viewport',
    )
  } finally {
    await uncontained.evaluate((element) => element.parentNode?.removeChild(element))
  }
  assertTables(await tableLayout(page), true)
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
