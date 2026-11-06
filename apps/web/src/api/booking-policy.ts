/** Imported busy records retain management in their original scheduling system. */
export function isReadOnlyBooking(booking: {
  source?: string
  managementPolicy?: string
}): boolean {
  return booking.source === 'import' || booking.managementPolicy === 'local_only_read_only'
}
