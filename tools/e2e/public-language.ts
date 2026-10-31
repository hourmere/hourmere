import type { Locator, Page } from '@playwright/test'

export const publicLanguageName = /^(Language:|语言：)/

/** Public pages use a compact menu; the admin language select remains separate. */
export async function selectPublicLanguage(scope: Page | Locator, value: 'en' | 'zh-CN') {
  await scope.getByRole('button', { name: publicLanguageName }).click()
  await scope
    .getByRole('menuitemradio', { name: value === 'en' ? 'English' : '简体中文', exact: true })
    .click()
}
