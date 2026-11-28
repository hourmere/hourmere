import { expect, test } from '../fixtures.ts'

// Computed values from the sign-in page before the token migration.
const themeStyles = {
  light: {
    tokens: {
      '--border-strong': '#7a8ab0',
      '--surface': '#ffffff',
      '--accent-soft': '#eaf0fd',
      '--accent-soft-text': '#0a1e4a',
      '--danger': '#b42318',
      '--danger-soft': '#fef0ee',
    },
    pageBackground: 'rgb(247, 249, 254)',
    pageText: 'rgb(14, 16, 21)',
    cardBackground: 'rgb(255, 255, 255)',
    cardBorder: 'rgb(214, 222, 239)',
    cardShadow: 'rgba(14, 16, 21, 0.06) 0px 1px 2px 0px, rgba(14, 16, 21, 0.06) 0px 2px 8px 0px',
    buttonBackground: 'rgb(31, 79, 216)',
  },
  dark: {
    tokens: {
      '--border-strong': '#64719a',
      '--surface': '#151c2e',
      '--accent-soft': '#16244a',
      '--accent-soft-text': '#dbe5ff',
      '--danger': '#d13438',
      '--danger-soft': '#2c1517',
    },
    pageBackground: 'rgb(14, 16, 21)',
    pageText: 'rgb(233, 237, 247)',
    cardBackground: 'rgb(21, 28, 46)',
    cardBorder: 'rgb(40, 50, 82)',
    cardShadow: 'none',
    buttonBackground: 'rgb(61, 104, 230)',
  },
} as const

test('sign-in keeps its computed design token values in light and dark', async ({ page, app }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(`${app.url}/sign-in`)
  const submit = page.getByRole('button', { name: 'Email me a sign-in link', exact: true })
  await expect(submit).toBeVisible()

  const root = page.locator('html')
  const card = page.locator('main .card')
  const heading = card.getByRole('heading', { level: 1 })
  for (const colorScheme of ['light', 'dark'] as const) {
    await test.step(colorScheme, async () => {
      await page.emulateMedia({ colorScheme })
      const styles = themeStyles[colorScheme]
      await expect(root).toHaveCSS('color-scheme', colorScheme)
      const expectedTokens = { ...styles.tokens, '--text-xs': '.8125rem', '--space-2': '8px' }
      const tokens = await root.evaluate((element, names) => {
        const style = getComputedStyle(element)
        return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]))
      }, Object.keys(expectedTokens))
      expect(tokens).toEqual(expectedTokens)

      const body = page.locator('body')
      await expect(body).toHaveCSS('background-color', styles.pageBackground)
      await expect(body).toHaveCSS('color', styles.pageText)
      await expect(body).toHaveCSS('font-size', '16px')
      await expect(heading).toHaveCSS('font-size', '24px')
      await expect(card).toHaveCSS('background-color', styles.cardBackground)
      await expect(card).toHaveCSS('border-top-color', styles.cardBorder)
      await expect(card).toHaveCSS('box-shadow', styles.cardShadow)
      await expect(card).toHaveCSS('border-radius', '10px')
      await expect(card).toHaveCSS('padding', '32px 24px')
      await expect(submit).toHaveCSS('background-color', styles.buttonBackground)
      await expect(submit).toHaveCSS('color', 'rgb(255, 255, 255)')
    })
  }
})
