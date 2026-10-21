import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import type { AuditFinding } from './reports.ts'

export const axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
export interface A11yExemption {
  page: string
  rule: string
  expires: string
  reason: string
  issue: string
}
interface AxeViolation {
  id: string
  impact?: string | null
  nodes: { element?: AuditFinding['element'] }[]
}

// The same scanner and node-to-selector pipeline serves product scans and the
// known-violation canary. Raw axe HTML/targets stay out of the report schema.
export async function scanA11y(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(axeTags).analyze()
  const targets = result.violations.map((violation) => violation.nodes.map((node) => node.target))
  const elements = await page.evaluate((groups) => {
    const all = [...document.querySelectorAll('*')]
    return groups.map((nodes) =>
      nodes.map((selectors) => {
        let element: Element | null = null
        try {
          if (typeof selectors[0] === 'string') element = document.querySelector(selectors[0])
        } catch {
          /* A complex/shadow target gets a safe root hint. */
        }
        element ??= document.documentElement
        const tag = element.tagName
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .slice(0, 21)
        const tokens = [...element.classList]
          .filter(
            (token) =>
              /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(token) &&
              !/(?:token|secret|canary)/i.test(token),
          )
          .slice(0, 8)
        const testId = element.getAttribute('data-testid') ?? ''
        return {
          tag,
          index: all.indexOf(element),
          selector: `${tag}${tokens.map((token) => `.${token}`).join('')}${/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(testId) && !/(?:token|secret|canary)/i.test(testId) ? `[data-testid="${testId}"]` : ''}`,
        }
      }),
    )
  }, targets)
  return {
    violations: result.violations.map((violation, rule) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((_node, node) => ({ element: elements[rule]?.[node] })),
    })),
    passes: result.passes.length,
    incomplete: result.incomplete.length,
    incompleteRules: result.incomplete.map((rule) => rule.id),
  }
}

export function a11yFindings(
  page: string,
  violations: AxeViolation[],
  exemptions: unknown,
  today = new Date().toISOString().slice(0, 10),
): { findings: AuditFinding[]; exempted: number } {
  const findings: AuditFinding[] = [],
    current: A11yExemption[] = []
  if (!Array.isArray(exemptions)) findings.push({ code: 'invalid-exemption', phase: 'exemptions' })
  else
    for (const exemption of exemptions) {
      if (
        !exemption ||
        typeof exemption !== 'object' ||
        typeof exemption.page !== 'string' ||
        !/^[a-z][a-z-]{0,40}$/.test(exemption.page) ||
        typeof exemption.rule !== 'string' ||
        !/^[a-z][a-z0-9-]{0,79}$/.test(exemption.rule) ||
        typeof exemption.expires !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(exemption.expires) ||
        !Number.isFinite(Date.parse(`${exemption.expires}T00:00:00Z`)) ||
        new Date(`${exemption.expires}T00:00:00Z`).toISOString().slice(0, 10) !==
          exemption.expires ||
        typeof exemption.reason !== 'string' ||
        !exemption.reason.trim() ||
        typeof exemption.issue !== 'string' ||
        !exemption.issue.trim()
      ) {
        findings.push({ code: 'invalid-exemption', phase: 'exemptions' })
        continue
      }
      if (exemption.expires < today)
        findings.push({ code: 'expired-exemption', phase: 'exemptions' })
      else current.push(exemption as A11yExemption)
    }
  let exempted = 0
  for (const violation of violations) {
    if (violation.impact !== 'serious' && violation.impact !== 'critical') continue
    if (current.some((entry) => entry.page === page && entry.rule === violation.id)) {
      exempted += violation.nodes.length
      continue
    }
    for (const node of violation.nodes)
      findings.push({
        code: violation.impact === 'critical' ? 'axe-critical' : 'axe-serious',
        rule: violation.id,
        count: 1,
        ...(node.element ? { element: node.element } : {}),
      })
  }
  return { findings, exempted }
}

export function assertAxeCanary(scan: ReturnType<typeof a11yFindings>) {
  const rules = new Set(scan.findings.map((finding) => finding.rule))
  if (!rules.has('button-name') || !rules.has('image-alt'))
    throw new Error('The in-browser axe canary did not detect both known violations')
}
