import type { components } from '../../../apps/web/src/api/schema.d.ts'
import { expect, test } from '../fixtures.ts'

for (const personal of [true, false]) {
  for (const language of ['en', 'zh-CN'] as const) {
    test(`${personal ? 'personal' : 'team'} event readiness stays readable in ${language}`, async ({
      page,
      app,
    }, testInfo) => {
      const ids = await app.authorizeTeamSession()
      const organizationId = personal ? ids.personalId : ids.teamId
      if (personal) {
        const switched = await page.request.post(`${app.url}/api/auth/organization/set-active`, {
          headers: { Origin: app.url },
          data: { organizationId },
        })
        expect(switched.ok()).toBe(true)
      }
      const response = await page.request.get(`${app.url}/api/v1/event-types`)
      expect(response.ok()).toBe(true)
      const { data } = (await response.json()) as { data: components['schemas']['EventType'][] }
      const event = data.find((item) => item.schedulingType === 'round_robin') ?? data[0]
      expect(Boolean(event)).toBe(true)
      if (!event) return
      const changed = await page.request.patch(`${app.url}/api/v1/event-types/${event.id}`, {
        headers: { Origin: app.url, 'X-Expected-Organization-Id': organizationId },
        data: { isHidden: true, isActive: false },
      })
      expect(changed.ok()).toBe(true)
      const width = testInfo.project.name === 'mobile' ? 320 : 1280
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(`${app.url}/app/event-types`)
      await page.getByRole('combobox', { name: 'Interface language' }).selectOption(language)
      await expect(page.locator('.event-checks')).not.toHaveCount(0)
      await expect(
        page.locator('.event-checks').filter({ hasText: /Checking configuration|正在检查配置/ }),
      ).toHaveCount(0)
      await page.evaluate(() => document.fonts.ready)
      const row = page.locator('.table-event-types tbody tr').filter({
        has: page.getByRole('rowheader', { name: event.title, exact: true }),
      })
      await expect(row.locator('.event-enablement .badge')).toHaveCount(personal ? 2 : 3)
      const contained = await page
        .locator('.table-event-types tbody tr, .event-enablement .badge, .event-checks .badge')
        .evaluateAll((elements) =>
          elements.every((element) => {
            const box = element.getBoundingClientRect()
            const cell = element.closest('td')?.getBoundingClientRect()
            return (
              box.left >= -1 &&
              box.right <= document.documentElement.clientWidth + 1 &&
              (!cell || (box.left >= cell.left - 1 && box.right <= cell.right + 1))
            )
          }),
        )
      expect(contained).toBe(true)
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true)
      if (width === 1280) {
        // A non-overflowing column can still squeeze Chinese or English badges into letters.
        expect(
          await row
            .locator('.event-enablement .badge')
            .evaluateAll((badges) =>
              badges.every(
                (badge) =>
                  badge.getBoundingClientRect().height <=
                  Number.parseFloat(getComputedStyle(badge).lineHeight) + 3,
              ),
            ),
        ).toBe(true)
        expect(
          await page.locator('.event-checks > .badge').evaluateAll((badges) =>
            badges.every((badge) => {
              const text = badge.firstChild
              const firstWord = text?.textContent?.match(/^\S+/u)?.[0]
              if (!text || text.nodeType !== Node.TEXT_NODE || !firstWord) return false
              const range = document.createRange()
              range.setStart(text, 0)
              range.setEnd(text, firstWord.length)
              return (
                new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size === 1
              )
            }),
          ),
        ).toBe(true)
      }
    })
  }
}
