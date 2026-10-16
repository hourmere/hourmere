import { useEffect, useState } from 'react'

type Health = { status: 'ok' | 'degraded'; database: 'ok' | 'unreachable' }

export function App() {
  const [health, setHealth] = useState<Health | 'error' | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth('error'))
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 32 }}>
      <h1>Hourmere</h1>
      <p>Open-source scheduling for people and AI agents.</p>
      <p>
        API:{' '}
        {health === null
          ? 'checking…'
          : health === 'error'
            ? 'unreachable'
            : `${health.status} (database ${health.database})`}
      </p>
    </main>
  )
}
