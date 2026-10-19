// PUBLICATION PLACEHOLDER: the project lead supplies PRIVACY_PUBLICATION_DATE on the
// publication day. Never replace it with a scheduled release date or a CI fixture date.
export const PRIVACY_PUBLICATION_DATE_PLACEHOLDER = 'SET_ON_PUBLICATION_DAY'

export function resolvePrivacyPublicationDate(value: string | undefined): string {
  const date = value ?? PRIVACY_PUBLICATION_DATE_PLACEHOLDER
  const error =
    'Set PRIVACY_PUBLICATION_DATE to the privacy policy publication day (YYYY-MM-DD) before building the site.'

  if (date === PRIVACY_PUBLICATION_DATE_PLACEHOLDER || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(error)
  }

  const instant = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) {
    throw new Error(error)
  }

  return date
}
