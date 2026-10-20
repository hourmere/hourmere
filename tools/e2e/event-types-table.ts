import type { Page } from '@playwright/test'
import type { FixtureApp } from './fixtures.ts'

/** Near the 64-character slug limit: a nowrap path this long must not size its column. */
export const LONG_BOOKING_SLUG = 'paused-very-long-slug-for-the-booking-link-truncation-check-r3'
// A realistic long handle within the API's 40-character limit.
export const LONG_BOOKING_HANDLE = 'alexandria-review-very-long-host-handle'

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

/** Gives both list and editor previews a realistic long handle and slug. */
export async function setLongBookingPath(page: Page, app: FixtureApp): Promise<void> {
  await setLongBookingSlug(page, app)
  const profileResponse = await page.request.get(`${app.url}/api/v1/profile`)
  if (profileResponse.status() !== 200) throw new Error('Could not read the audit host profile')
  const profile = (await profileResponse.json()) as { timeZone: string; locale: string }
  const response = await page.request.put(`${app.url}/api/v1/profile`, {
    headers: { origin: app.url },
    data: { handle: LONG_BOOKING_HANDLE, timeZone: profile.timeZone, locale: profile.locale },
  })
  if (response.status() !== 200) throw new Error('Could not give the audit host a long handle')
}

/** Sets a long handle and slug, then reloads the open event-types list. */
export async function useLongBookingSlug(page: Page, app: FixtureApp): Promise<void> {
  await setLongBookingPath(page, app)
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
  /** Either path segment clips, without scrolling the page sideways. */
  linkOverflow: boolean
  /** The copy button shares the link's line (table mode) rather than wrapping under it. */
  copyBeside: boolean
  linkEllipsis: string
  handleOverflow: boolean
  /** Subpixel remainder after whole monospace cells: a partial cell looks like a URL space. */
  handleCellRemainder: number
  slugStartVisible: boolean
  fullUrlTitle: boolean
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
    const handle = link?.querySelector<HTMLElement>('.booking-link-handle')
    const slugPart = link?.querySelector<HTMLElement>('.booking-link-slug')
    if (
      !table ||
      !row ||
      !thead ||
      !title ||
      !titleLink ||
      !linkCell ||
      !link ||
      !copy ||
      !handle ||
      !slugPart?.firstChild
    )
      throw new Error('Event-types table row missing')
    // A visible first character alone is too weak: reserve enough width to identify the slug.
    const slugStart = document.createRange()
    slugStart.setStart(slugPart.firstChild, 0)
    slugStart.setEnd(slugPart.firstChild, Math.min(7, slugPart.firstChild.textContent?.length ?? 0))
    const startRect = slugStart.getBoundingClientRect()
    const slugRect = slugPart.getBoundingClientRect()
    const linkRect = link.getBoundingClientRect()
    const handleCells = document.createRange()
    if (!handle.firstChild) throw new Error('Booking handle text missing')
    const cellCount = Math.min(10, handle.firstChild.textContent?.length ?? 0)
    handleCells.setStart(handle.firstChild, 0)
    handleCells.setEnd(handle.firstChild, cellCount)
    const cellWidth = handleCells.getBoundingClientRect().width / cellCount
    const handleWidth = handle.getBoundingClientRect().width
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
      linkLines: Math.max(lines(handle), lines(slugPart)),
      linkOverflow:
        handle.scrollWidth > handle.clientWidth || slugPart.scrollWidth > slugPart.clientWidth,
      copyBeside: copy.getBoundingClientRect().top < link.getBoundingClientRect().bottom,
      linkEllipsis: getComputedStyle(slugPart).textOverflow,
      handleOverflow: handle.scrollWidth > handle.clientWidth,
      handleCellRemainder: Math.abs(handleWidth - Math.round(handleWidth / cellWidth) * cellWidth),
      slugStartVisible:
        startRect.width > 0 &&
        startRect.left >= Math.max(slugRect.left, linkRect.left) - 1 &&
        startRect.right <= Math.min(slugRect.right, linkRect.right) + 1,
      fullUrlTitle: link.title === link.href,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  }, slug)
}
