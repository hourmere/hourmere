import type { ReactNode } from 'react'
import type { Booking } from '../../api/resources.ts'
import {
  UserContentLines,
  UserContentList,
  UserContentMessage,
} from '../../components/UserContent.tsx'
import { useI18n } from '../../i18n/runtime.tsx'
import { bookingTitle } from './booking-format.ts'

export function BookingTitle({ booking }: { booking: Booking }) {
  const title = bookingTitle(booking)
  return 'literal' in title ? (
    <bdi>{title.literal}</bdi>
  ) : (
    <UserContentMessage message={title.key} values={title.values} />
  )
}

export function BookingAnswer({
  value,
  fallback = null,
}: {
  value: string | string[] | boolean | undefined
  fallback?: ReactNode
}) {
  const { t } = useI18n()
  if (typeof value === 'boolean') return t(value ? 'Yes' : 'No')
  if (Array.isArray(value)) return value.length ? <UserContentList values={value} /> : fallback
  return value?.trim() ? <UserContentLines text={value} /> : fallback
}
