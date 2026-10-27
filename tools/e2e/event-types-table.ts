import type { Locator, Page } from '@playwright/test'
import type { FixtureApp } from './fixtures.ts'

/** The fixture host's own short link, which fits the list and the editor preview whole. */
export const SHORT_BOOKING_SLUG = 'call'

/** Near the 64-character slug limit: a nowrap path this long must not size its column. */
export const LONG_BOOKING_SLUG = 'paused-very-long-slug-for-the-booking-link-truncation-check-r3'
// A realistic long handle within the API's 40-character limit.
export const LONG_BOOKING_HANDLE = 'alexandria-review-very-long-host-handle'

/** Gives the audit event type the long slug through the API, as a signed-in host would. */
export async function setLongBookingSlug(page: Page, app: FixtureApp): Promise<void> {
  const state = await app.auditState()
  await app.auditSignIn(true)
  const response = await page.request.patch(`${app.url}/api/v1/event-types/${state.eventTypeId}`, {
    headers: { origin: app.url, 'X-Expected-Organization-Id': state.organizationId },
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
  slugOverflow: boolean
  /** Link width neither segment uses: a clipped handle must fill what the slug leaves. */
  unusedPathWidth: number
  slugStartVisible: boolean
  fullUrlTitle: boolean
  documentOverflow: boolean
}

export interface BookingLinkPreviewGeometry {
  lines: number
  handleOverflow: boolean
  slugOverflow: boolean
  /** Preview width neither segment uses: a clipped handle must fill what the slug leaves. */
  unusedPathWidth: number
  slugStartVisible: boolean
  ellipsis: string
  fullUrlTitle: boolean
  documentFits: boolean
}

/** Measures the editor's booking-link preview: its handle and slug segments and their clipping. */
export function measureBookingLinkPreview(preview: Locator): Promise<BookingLinkPreviewGeometry> {
  return preview.evaluate((node) => {
    const handle = node.querySelector<HTMLElement>('.booking-link-handle')
    const slug = node.querySelector<HTMLElement>('.booking-link-slug')
    if (!handle?.firstChild || !slug?.firstChild) throw new Error('Preview path missing')
    // Firefox and WebKit can round scrollWidth up and clientWidth down on a fractional box,
    // so a whole segment may read 1px over; a clipped one is over by at least a cell.
    const clips = (segment: HTMLElement) => segment.scrollWidth > segment.clientWidth + 1
    // Each segment's own text rows: the two flex items' boxes can differ by a subpixel.
    const lines = (segment: HTMLElement) => {
      const range = document.createRange()
      range.selectNodeContents(segment)
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
    }
    const start = document.createRange()
    start.setStart(slug.firstChild, 0)
    start.setEnd(slug.firstChild, Math.min(7, slug.firstChild.textContent?.length ?? 0))
    const slugRect = slug.getBoundingClientRect()
    const startRect = start.getBoundingClientRect()
    const previewRect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const contentWidth =
      previewRect.width -
      ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce(
        (sum, property) => sum + Number.parseFloat(style[property as 'paddingLeft']),
        0,
      )
    return {
      lines: Math.max(lines(handle), lines(slug)),
      handleOverflow: clips(handle),
      slugOverflow: clips(slug),
      unusedPathWidth: contentWidth - handle.getBoundingClientRect().width - slugRect.width,
      slugStartVisible:
        startRect.width > 0 &&
        startRect.left >= Math.max(slugRect.left, previewRect.left) - 1 &&
        startRect.right <= Math.min(slugRect.right, previewRect.right) + 1,
      ellipsis: getComputedStyle(slug).textOverflow,
      fullUrlTitle: node.getAttribute('title') === `${window.location.origin}${node.textContent}`,
      documentFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    }
  })
}

/** Measures the row whose booking link ends in `/slug`, in table or card mode. */
export function measureEventTypesTable(page: Page, slug: string): Promise<EventTypesTableGeometry> {
  return page.evaluate((slug) => {
    const table = document.querySelector<HTMLTableElement>('.table-event-types')
    const row = [...(table?.querySelectorAll<HTMLTableRowElement>('tbody tr') ?? [])].find(
      (tr) => tr.querySelector('.booking-link a .booking-link-slug')?.textContent === `/${slug}`,
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
    const linkStyle = getComputedStyle(link)
    const linkContentWidth =
      linkRect.width -
      ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce(
        (sum, property) => sum + Number.parseFloat(linkStyle[property as 'paddingLeft']),
        0,
      )
    const lines = (node: Node | null) => {
      if (!node) return 0
      const range = document.createRange()
      range.selectNodeContents(node)
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
    }
    // Firefox and WebKit can round scrollWidth up and clientWidth down on a fractional box,
    // so a whole segment may read 1px over; a clipped one is over by at least a cell.
    const clips = (segment: HTMLElement) => segment.scrollWidth > segment.clientWidth + 1
    return {
      tableMode: getComputedStyle(thead).position !== 'absolute',
      tableWidth: table.getBoundingClientRect().width,
      titleColumnWidth: title.getBoundingClientRect().width,
      linkColumnWidth: linkCell.getBoundingClientRect().width,
      titleLines: lines(titleLink.firstChild),
      linkLines: Math.max(lines(handle), lines(slugPart)),
      linkOverflow: clips(handle) || clips(slugPart),
      copyBeside: copy.getBoundingClientRect().top < link.getBoundingClientRect().bottom,
      linkEllipsis: getComputedStyle(slugPart).textOverflow,
      handleOverflow: clips(handle),
      slugOverflow: clips(slugPart),
      unusedPathWidth: linkContentWidth - handle.getBoundingClientRect().width - slugRect.width,
      slugStartVisible:
        startRect.width > 0 &&
        startRect.left >= Math.max(slugRect.left, linkRect.left) - 1 &&
        startRect.right <= Math.min(slugRect.right, linkRect.right) + 1,
      fullUrlTitle: link.title === link.href,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }
  }, slug)
}
