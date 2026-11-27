import { screen } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'

type User = ReturnType<typeof userEvent.setup>

export async function openAccountMenu(user: Pick<User, 'click'>) {
  const trigger = await screen.findByRole('button', { name: /^(Account menu|账户菜单)$/ })
  if (trigger.getAttribute('aria-expanded') === 'false') await user.click(trigger)
}

export async function selectAdminLanguage(
  user: Pick<User, 'click' | 'selectOptions'>,
  value: string,
) {
  await openAccountMenu(user)
  await user.selectOptions(
    screen.getByRole('combobox', { name: /^(Interface language|界面语言)$/ }),
    value,
  )
}
