import { explicitLanguage, localeRegistry } from '@hourmere/core/language'
import { screen, within } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'

/** Choose a public language without depending on the current translated trigger name. */
export async function selectPublicLanguage(
  user: ReturnType<typeof userEvent.setup>,
  language: string,
) {
  const code = explicitLanguage(language)
  if (!code) throw new Error(`Unknown public language fixture: ${language}`)
  const trigger = within(screen.getByRole('banner')).getByRole('button', { expanded: false })
  await user.click(trigger)
  await user.click(screen.getByRole('menuitemradio', { name: localeRegistry[code].nativeName }))
}
