import type { Locator } from '@playwright/test'

/** Open the real disclosure through its summary before interacting with a setting. */
export async function revealEventSetting(field: Locator) {
  await field.waitFor({ state: 'attached' })
  const group = field.locator('xpath=ancestor::details[1]')
  if (await group.count()) {
    if (!(await group.evaluate((element) => (element as HTMLDetailsElement).open)))
      await group.locator(':scope > summary').click()
  }
}
