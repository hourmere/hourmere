import { test as base, expect } from './fixtures.ts'
import { startSiteFixture } from './site-server.ts'

// Serve only the built static site; this fixture creates no database or application server.
export const test = base.extend<{ siteNetwork: undefined }, { siteOrigin: string }>({
  siteOrigin: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring.
    async ({}, use) => {
      const site = await startSiteFixture()
      try {
        await use(site.origin)
      } finally {
        await site.close()
      }
    },
    { scope: 'worker' },
  ],
  siteNetwork: [
    async ({ context, siteOrigin }, use) => {
      const external: string[] = []
      await context.route('**/*', async (route) => {
        if (new URL(route.request().url()).origin === siteOrigin) await route.continue()
        else {
          external.push(route.request().resourceType())
          await route.abort('blockedbyclient')
        }
      })
      await use(undefined)
      expect(external, 'The static-site fixture makes no external requests').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
