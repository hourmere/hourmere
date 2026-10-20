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
  nodes: unknown[]
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
    findings.push({
      code: violation.impact === 'critical' ? 'axe-critical' : 'axe-serious',
      rule: violation.id,
      count: violation.nodes.length,
    })
  }
  return { findings, exempted }
}
