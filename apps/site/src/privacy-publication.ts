import { LEGAL_PUBLICATION_DATE } from './data/legal.ts'

export function resolveLegalPublicationDate(): string {
  const date = LEGAL_PUBLICATION_DATE
  const error =
    'Set LEGAL_PUBLICATION_DATE in apps/site/src/data/legal.ts to the publication day (YYYY-MM-DD) before building the site.'

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(error)
  }

  const instant = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) {
    throw new Error(error)
  }

  return date
}
