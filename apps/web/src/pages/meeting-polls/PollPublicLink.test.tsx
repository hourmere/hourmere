import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '../../i18n/admin.ts'
import { InterfaceScope } from '../../i18n/runtime.tsx'
import { chooseLanguage } from '../../i18n/store.ts'
import { PollPublicLink } from './PollPublicLink.tsx'

const votingLink = 'https://hourmere.invalid/poll#synthetic-public-vote'

function Disclosure() {
  const [link, setLink] = useState<string | null>(votingLink)
  return (
    <InterfaceScope surface="admin">
      {link && <PollPublicLink link={link} onDismiss={() => setLink(null)} />}
    </InterfaceScope>
  )
}

describe('one-time poll link disclosure', () => {
  it.each([
    [
      'en',
      'Copy this link now. It will only be shown here once.',
      'Copy voting link',
      'Hide voting link',
    ],
    ['zh-CN', '请立即复制此链接。它只会在这里显示一次。', '复制投票链接', '隐藏投票链接'],
  ] as const)(
    'copies a transient link on request and clears it after dismissal in %s',
    async (locale, warning, copy, hide) => {
      chooseLanguage(locale)
      const writeStorage = vi.spyOn(Storage.prototype, 'setItem')
      const pushState = vi.spyOn(History.prototype, 'pushState')
      const replaceState = vi.spyOn(History.prototype, 'replaceState')
      const user = userEvent.setup()
      const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
      render(<Disclosure />)

      const disclosure = screen.getByTestId('meeting-poll-public-link')
      expect(within(disclosure).getByText(warning)).toBeTruthy()
      expect(document.activeElement).toBe(within(disclosure).getByRole('heading'))
      expect(within(disclosure).getByText(votingLink).hasAttribute('data-private')).toBe(true)
      expect(within(disclosure).queryByRole('link')).toBeNull()
      expect(clipboard).not.toHaveBeenCalled()
      await user.click(within(disclosure).getByRole('button', { name: copy }))
      expect(clipboard).toHaveBeenCalledExactlyOnceWith(votingLink)
      await user.click(within(disclosure).getByRole('button', { name: hide }))

      expect(screen.queryByText(votingLink)).toBeNull()
      expect(writeStorage).not.toHaveBeenCalled()
      expect(pushState).not.toHaveBeenCalled()
      expect(replaceState).not.toHaveBeenCalled()
    },
  )

  it('hides the capability in the page snapshot and clears it on back-forward restoration', () => {
    render(<Disclosure />)
    const disclosure = screen.getByTestId('meeting-poll-public-link')
    act(() => window.dispatchEvent(new Event('pagehide')))
    expect(disclosure.hidden).toBe(true)
    act(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    expect(screen.queryByText(votingLink)).toBeNull()
  })
})
