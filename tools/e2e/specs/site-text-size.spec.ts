import { expect, test } from '../site-fixtures.ts'

// Set Chrome's default font preference before navigation. The CSS viewport stays at 320px.
test.use({ launchOptions: { args: ['--blink-settings=defaultFontSize=32'] } })
test.skip(!process.env.CI, 'Static-site rendering regression runs in CI')

const legalPages = [
  { path: '/privacy', firstSection: '#scope' },
  { path: '/terms', firstSection: '#the-service' },
]

for (const { path, firstSection } of legalPages) {
  test(`${path} fits at 320px at 200% browser text size`, async ({ page, siteOrigin }) => {
    await page.setViewportSize({ width: 320, height: 844 })
    expect((await page.goto(new URL(path, siteOrigin).href))?.status()).toBe(200)
    await page.evaluate(() => document.fonts.ready)
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
