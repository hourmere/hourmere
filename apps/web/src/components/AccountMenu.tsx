import { useId } from 'react'
import { LanguageSwitcher, useI18n } from '../i18n/runtime.tsx'
import type { Me } from '../session.tsx'
import { ShellIcon } from './ShellIcon.tsx'
import { useShellDisclosure } from './use-shell-disclosure.ts'

export function AccountMenu({
  user,
  confirmLeave,
  onSignOut,
}: {
  user: Me['user']
  confirmLeave: () => boolean
  onSignOut: () => Promise<void>
}) {
  const { t } = useI18n()
  const menu = useShellDisclosure()
  const buttonId = useId()
  const initials = (user.name.trim() || user.email)
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join('')
    .toUpperCase()

  return (
    <div className="account-menu" {...menu.containerProps}>
      <button type="button" className="account-toggle" id={buttonId} {...menu.triggerProps}>
        <span className="account-initials" aria-hidden="true">
          {initials}
        </span>
        <span className="account-label">{t('Account menu')}</span>
        <ShellIcon name="chevron" />
      </button>
      <section
        id={menu.panelId}
        className="account-panel"
        aria-labelledby={buttonId}
        hidden={!menu.open}
      >
        <p className="account-email">{user.email}</p>
        <LanguageSwitcher />
        <button
          type="button"
          className="button button-small"
          onClick={() => {
            if (!confirmLeave()) return
            menu.closeAndRestoreFocus()
            void onSignOut()
          }}
        >
          {t('Sign out')}
        </button>
      </section>
    </div>
  )
}
