import type { Schemas } from '../api/client.ts'
import { json, type Routes } from './fake-api.tsx'

/** List fixtures also serve their explicitly declared detail records through the new read. */
export function teamBookingPanelApi(routes: Routes): Routes {
  const records = new Map<string, Schemas['TeamAdminBooking']>()
  const list = routes['GET /api/v1/team/bookings']
  if (!list) throw new Error('A team booking list fixture is required')
  const details: Routes = {}
  for (const suffix of ['001', '002', '003']) {
    const id = `b0000000-0000-7000-8000-000000000${suffix}`
    details[`GET /api/v1/team/bookings/${id}`] = () => {
      const booking = records.get(id)
      return booking ? json(200, booking) : json(404, { error: 'booking_not_found' })
    }
  }
  return {
    ...details,
    ...routes,
    'GET /api/v1/team/bookings': async (call) => {
      const response = await list(call)
      if (response.ok) {
        const page = (await response.clone().json()) as { data: Schemas['TeamAdminBooking'][] }
        for (const booking of page.data) records.set(booking.id, booking)
      }
      return response
    },
  }
}
