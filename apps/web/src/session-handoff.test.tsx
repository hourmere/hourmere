import { act, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SessionProvider, useSession } from './session.tsx'
import { fakeApi, json, later, ME, signedIn } from './test/fake-api.tsx'

const TEAM_ME = {
  ...ME,
  organization: { ...ME.organization, id: 'team', name: 'Team', personal: false },
}

function Consumer() {
  const { state, accept, refresh, signOut } = useSession()
  return (
    <>
      <output>{state.status === 'signed-in' ? state.me.organization.id : state.status}</output>
      <button type="button" onClick={() => accept(TEAM_ME)}>
        Accept team
      </button>
      <button
        type="button"
        onClick={() => accept({ ...TEAM_ME, user: { ...ME.user, id: 'another-user' } })}
      >
        Accept another user
      </button>
      <button type="button" onClick={() => void refresh()}>
        Refresh
      </button>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  )
}

async function open() {
  render(
    <SessionProvider>
      <Consumer />
    </SessionProvider>,
  )
  await screen.findByText(ME.organization.id)
}

describe('a confirmed organization handoff', () => {
  it('applies the same caller and rejects a snapshot belonging to another caller', async () => {
    fakeApi(signedIn)
    await open()
    act(() => screen.getByText('Accept another user').click())
    expect(screen.getByRole('status').textContent).toBe(ME.organization.id)
    act(() => screen.getByText('Accept team').click())
    expect(screen.getByRole('status').textContent).toBe('team')
  })

  it('does not let an older background response undo the deliberate switch', async () => {
    const pending = later()
    let reads = 0
    fakeApi({
      ...signedIn,
      'GET /api/v1/me': () => (++reads === 1 ? json(200, ME) : pending.response),
    })
    await open()
    act(() => screen.getByText('Refresh').click())
    await waitFor(() => expect(reads).toBe(2))
    act(() => screen.getByText('Accept team').click())
    await pending.answer(json(200, ME))
    expect(screen.getByRole('status').textContent).toBe('team')
  })

  it('cannot use a late handoff to sign a signed-out caller back in', async () => {
    fakeApi({ ...signedIn, 'POST /api/auth/sign-out': () => json(200, { success: true }) })
    await open()
    act(() => screen.getByText('Sign out').click())
    await screen.findByText('signed-out')
    act(() => screen.getByText('Accept team').click())
    expect(screen.getByRole('status').textContent).toBe('signed-out')
  })
})
