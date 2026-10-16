import { Link } from 'react-router'
import { Logo } from '../components/Logo.tsx'
import { usePageTitle } from '../hooks.ts'

export function NotFoundPage() {
  usePageTitle('Page not found')
  return (
    <main className="centered">
      <div className="card">
        <Logo />
        <h1>Page not found</h1>
        <p>There is nothing at this address.</p>
        <p>
          <Link to="/">Go to Hourmere</Link>
        </p>
      </div>
    </main>
  )
}
