import { type AuditLocale, auditLocales, auditPages } from './audit-pages.ts'

const maxPagesPerBatch = 32

// Keep consecutive states in the same browser when possible, but bound the work
// done before each Playwright test deadline.
export function a11yPageBatches(locale: AuditLocale) {
  const pages = auditPages.filter(({ id }) => auditLocales(id).includes(locale))
  return Array.from({ length: Math.ceil(pages.length / maxPagesPerBatch) }, (_, index) =>
    pages.slice(index * maxPagesPerBatch, (index + 1) * maxPagesPerBatch),
  )
}
