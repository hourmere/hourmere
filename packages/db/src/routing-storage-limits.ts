// Test-only binding: SQL boundary probes derive their limits from the design register.
import { readFileSync } from 'node:fs'
import { expect } from 'vitest'

export function assertRoutingStorageLimits(source: string, dataModel: string) {
  const rows = Object.fromEntries(
    [...source.matchAll(/^\| ([a-z_]+) \| (\d+) \|/gm)].map(([, key, value]) => [
      key,
      Number(value),
    ]),
  )
  const limits = {
    forms_per_organization: rows.forms_per_organization,
    total_forms_per_organization: rows.total_forms_per_organization,
    versions_per_form: rows.versions_per_form,
  }
  expect(limits).toEqual({
    forms_per_organization: 100,
    total_forms_per_organization: 1000,
    versions_per_form: 1000,
  })
  const prose = dataModel.replaceAll(/\s+/g, ' ')
  expect(prose).toContain(`**${limits.forms_per_organization} non-archived forms**`)
  expect(prose).toContain(`**${limits.total_forms_per_organization} total forms**`)
  expect(prose).toContain(`**${limits.versions_per_form} published versions**`)
  return limits as {
    forms_per_organization: number
    total_forms_per_organization: number
    versions_per_form: number
  }
}

export function readRoutingStorageLimits() {
  return assertRoutingStorageLimits(
    readFileSync(new URL('../../../docs/routing-forms.md', import.meta.url), 'utf8'),
    readFileSync(new URL('../../../docs/data-model.md', import.meta.url), 'utf8'),
  )
}
