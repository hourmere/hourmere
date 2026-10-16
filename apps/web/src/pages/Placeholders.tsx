// Pages whose API is still being built; each becomes a real screen once its endpoints are
// in the OpenAPI document (npm run api:types).
import type { ReactNode } from 'react'
import { usePageTitle } from '../hooks.ts'
import { useMe } from '../session.tsx'

function Placeholder({ title, children }: { title: string; children: ReactNode }) {
  usePageTitle(title)
  return (
    <>
      <h1>{title}</h1>
      <div className="empty">{children}</div>
    </>
  )
}

export function EventTypesPage() {
  return (
    <Placeholder title="Event types">
      <p>The kinds of meetings people can book with you will be listed here.</p>
      <p className="muted">Coming soon.</p>
    </Placeholder>
  )
}

export function AvailabilityPage() {
  return (
    <Placeholder title="Availability">
      <p>Your weekly hours and time zone will be set here.</p>
      <p className="muted">Coming soon.</p>
    </Placeholder>
  )
}

export function BookingsPage() {
  return (
    <Placeholder title="Bookings">
      <p>Meetings people have booked with you will appear here.</p>
      <p className="muted">Coming soon.</p>
    </Placeholder>
  )
}

export function SettingsPage() {
  const me = useMe()
  return (
    <Placeholder title="Settings">
      <dl className="details">
        <dt>Name</dt>
        <dd>{me.user.name || <span className="muted">Not set</span>}</dd>
        <dt>Email</dt>
        <dd>{me.user.email}</dd>
        <dt>Organization</dt>
        <dd>
          {me.organization.name}
          {me.organization.personal && <span className="muted"> (personal)</span>}
        </dd>
      </dl>
      <p className="muted">Profile and account settings are coming soon.</p>
    </Placeholder>
  )
}
