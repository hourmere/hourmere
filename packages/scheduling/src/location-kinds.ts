/** Shared location vocabulary, independent of availability and event-type services. */
export const LOCATION_KINDS = ['google_meet', 'zoom', 'phone', 'in_person', 'link'] as const
export type LocationKind = (typeof LOCATION_KINDS)[number]
