import { Link } from 'react-router'
import { Logo } from '../components/Logo.tsx'
import { usePageTitle } from '../hooks.ts'
import { PATHS } from '../paths.ts'

export function NotFoundPage() {
  usePageTitle('Page not found')
  return (
    <main className="centered">
      <div className="card">
        <Logo />
        <h1>Page not found</h1>
        <p>There is nothing at this address.</p>
        <p>
          <Link to={PATHS.home}>Go to Hourmere</Link>
        </p>
      </div>
    </main>
  )
}

/** An address under /app that is no page, shown inside the app's frame. */
export function AppNotFoundPage() {
  usePageTitle('Page not found')
  return (
    <>
      <h1>Page not found</h1>
      <p>There is nothing at this address.</p>
      <p>
        <Link to={PATHS.home}>Go to your event types</Link>
      </p>
    </>
  )
}

/** A record the page was asked for that does not exist (any more), e.g. a deleted one. */
export function MissingRecord({
  title,
  message,
  back,
}: {
  title: string
  message: string
  back: { to: string; label: string }
}) {
  usePageTitle(title)
  return (
    <>
      <h1>{title}</h1>
      <p>{message}</p>
      <p>
        <Link to={back.to}>{back.label}</Link>
      </p>
    </>
  )
}
