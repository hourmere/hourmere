import type { Page } from '@playwright/test'

export function accountMenuButton(page: Page) {
  return page.getByRole('button', { name: /^(Account menu|账户菜单)$/ })
}

export function accountMenuPanel(page: Page) {
  return page.getByRole('region', { name: /^(Account menu|账户菜单)$/ })
}

export async function selectAdminLanguage(page: Page, value: 'en' | 'zh-CN') {
  const trigger = accountMenuButton(page)
  await trigger.click()
  await accountMenuPanel(page)
    .getByRole('combobox', { name: /^(Interface language|界面语言)$/ })
    .selectOption(value)
  await trigger.click()
}
