import type { Page } from '@playwright/test'
import type { FixtureApp } from './fixtures.ts'

/** Near the 64-character slug limit: a nowrap path this long must not size its column. */
export const LONG_BOOKING_SLUG = 'paused-very-long-slug-for-the-booking-link-truncation-check-r3'

/** Gives the audit event type the long slug through the API, as a signed-in host would. */
export async function setLongBookingSlug(page: Page, app: FixtureApp): Promise<void> {
  const state = await app.auditState()
  await app.auditSignIn(true)
  const response = await page.request.patch(`${app.url}/api/v1/event-types/${state.eventTypeId}`, {
    headers: { origin: app.url },
    data: { slug: LONG_BOOKING_SLUG },
  })
  if (response.status() !== 200) throw new Error('Could not give the audit event type a long slug')
}

/** Sets the long slug, then reloads the open event-types list until it shows the slug. */
export async function useLongBookingSlug(page: Page, app: FixtureApp): Promise<void> {
  await setLongBookingSlug(page, app)
  await page.reload()
  await page.locator('.booking-link a').filter({ hasText: LONG_BOOKING_SLUG }).waitFor()
}

export interface EventTypesTableGeometry {
  /** Column headers are laid out (true) rather than clipped away for card mode. */
  tableMode: boolean
  tableWidth: number
  titleColumnWidth: number
  linkColumnWidth: number
  titleLines: number
  linkLines: number
  /** The anchor itself clips its path; the page does not scroll sideways. */
  linkOverflow: boolean
  /** The copy button shares the link's line (table mode) rather than wrapping under it. */
  copyBeside: boolean
  linkEllipsis: string
  documentOverflow: boolean
}

/** Measures the row that shows `slug` in the event-types list, in table or card mode. */
export function measureEventTypesTable(page: Page, slug: string): Promise<EventTypesTableGeometry> {
  return page.evaluate((slug) => {
    const table = document.querySelector<HTMLTableElement>('.table-event-types')
    const row = [...(table?.querySelectorAll<HTMLTableRowElement>('tbody tr') ?? [])].find((tr) =>
      tr.querySelector('.booking-link a')?.textContent?.includes(slug),
    )
    const thead = table?.querySelector('thead')
    const title = row?.querySelector<HTMLElement>('th[scope="row"]')
    const titleLink = title?.querySelector('a')
    const linkCell = row?.querySelector<HTMLElement>('.link-cell')
    const link = row?.querySelector<HTMLAnchorElement>('.booking-link a')
    const copy = row?.querySelector<HTMLButtonElement>('.booking-link .copy button')
    if (!table || !row || !thead || !title || !titleLink || !linkCell || !link || !copy)
      throw new Error('Event-types table row missing')
    const lines = (node: Node | null) => {
      if (!node) return 0
      const range = document.createRange()
      range.selectNodeContents(node)
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
    }
    return {
      tableMode: getComputedStyle(thead).position !== 'absolute',
      tableWidth: table.getBoundingClientRect().width,
      titleColumnWidth: title.getBoundingClientRect().width,
      linkColumnWidth: linkCell.getBoundingClientRect().width,
      titleLines: lines(titleLink.firstChild),
      linkLines: lines(link.firstChild),
      linkOverflow: link.scrollWidth > link.clientWidth,
      copyBeside: copy.getBoundingClientRect().top < link.getBoundingClientRect().bottom,
      linkEllipsis: getComputedStyle(link).textOverflow,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  }, slug)
}
