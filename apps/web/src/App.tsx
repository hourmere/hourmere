import { type FormEvent, useEffect, useState } from 'react'

// Placeholder UI that proves the sign-in flow; the real app comes later.

type Me = {
  user: { id: string; name: string; email: string }
  organization: { id: string; name: string; slug: string; personal: boolean }
}

type State =
  | { kind: 'loading' }
  | { kind: 'signed-in'; me: Me }
  | { kind: 'signed-out'; error?: string }
  | { kind: 'link-sent'; email: string }

const postJson = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  // A failed magic link lands here with ?error=…; read it once, then clean up the URL.
  const [linkError] = useState(() => new URLSearchParams(window.location.search).get('error'))

  useEffect(() => {
    if (linkError) window.history.replaceState(null, '', window.location.pathname)
    fetch('/api/v1/me')
      .then(async (r) => {
        if (r.ok) return setState({ kind: 'signed-in', me: (await r.json()) as Me })
        setState({
          kind: 'signed-out',
          ...(linkError && { error: 'That sign-in link is invalid or has expired.' }),
        })
      })
      .catch(() => setState({ kind: 'signed-out', error: 'The server is unreachable.' }))
  }, [linkError])

  async function sendLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const email = String(new FormData(e.currentTarget).get('email'))
    const res = await postJson('/api/auth/sign-in/magic-link', { email, callbackURL: '/' }).catch(
      () => null,
    )
    setState(
      res?.ok
        ? { kind: 'link-sent', email }
        : { kind: 'signed-out', error: 'Could not send the link. Try again in a minute.' },
    )
  }

  async function signOut() {
    await postJson('/api/auth/sign-out', {})
    setState({ kind: 'signed-out' })
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 32, maxWidth: 480 }}>
      <h1>Hourmere</h1>
      {state.kind === 'loading' && <p>Loading…</p>}
      {state.kind === 'signed-out' && (
        <form onSubmit={sendLink}>
          {state.error && <p role="alert">{state.error}</p>}
          <label>
            Email
            <br />
            <input name="email" type="email" required autoComplete="email" />
          </label>{' '}
          <button type="submit">Email me a sign-in link</button>
        </form>
      )}
      {state.kind === 'link-sent' && (
        <p>Check your email: we sent a sign-in link to {state.email}.</p>
      )}
      {state.kind === 'signed-in' && (
        <>
          <p>
            Signed in as{' '}
            {state.me.user.name
              ? `${state.me.user.name} (${state.me.user.email})`
              : state.me.user.email}
            .
          </p>
          <p>
            Organization: {state.me.organization.name}
            {state.me.organization.personal && ' (personal)'}
          </p>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </>
      )}
    </main>
  )
}
