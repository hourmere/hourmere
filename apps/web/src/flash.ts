// A one-time message for the page a navigation leads to, e.g. "Deleted “Intro call”." after
// deleting on the edit page and returning to the list. It travels in the history entry's
// state, and is taken out once read, so going back or reloading does not show it again.
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

export interface FlashState {
  flash: string
}

export const flash = (message: string): FlashState => ({ flash: message })

const isFlash = (state: unknown): state is FlashState =>
  typeof state === 'object' &&
  state !== null &&
  typeof (state as { flash?: unknown }).flash === 'string'

/** The message the navigation to this page brought, if any. */
export function useFlash(): string | null {
  const location = useLocation()
  const navigate = useNavigate()
  const [message] = useState(() => (isFlash(location.state) ? location.state.flash : null))

  useEffect(() => {
    if (isFlash(location.state)) {
      navigate(location.pathname + location.search, { replace: true, state: null })
    }
  }, [location, navigate])

  return message
}
