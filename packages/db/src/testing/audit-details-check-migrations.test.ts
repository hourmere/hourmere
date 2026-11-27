import { expect, it } from 'vitest'
import {
  detailsCheckBranches,
  detailsCheckMigrationHistory,
} from '../audit-details-check-source.ts'

const webhookActions = [
  'webhook.created',
  'webhook.deleted',
  'webhook.paused',
  'webhook.resumed',
  'webhook.secret_rotated',
  'webhook.updated',
]

// Published changes to the predicate for these actions. Each action still has to be present.
const historicalRewrites: Readonly<Record<string, readonly string[]>> = {
  '0080_audit_event_details.sql': [
    'slack_destination.created',
    'slack_destination.deleted',
    'slack_destination.paused',
    'slack_destination.resumed',
    'slack_destination.tested',
    'slack_destination.updated',
    ...webhookActions,
  ],
  '0143_workflow_webhook_subscriptions.sql': webhookActions,
  '0163_sso_recovery_audit.sql': ['sso_delegation.revoked'],
  '0171_scim_suspension_sign_in_audit.sql': ['sso_authentication.failed'],
}

function normalize(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'))
    .join('\n')
}

function auditRules(file: string) {
  const { head, branches } = detailsCheckBranches(file)
  const rules = new Map<string, string>()
  for (const { when, text } of branches) {
    const sql = normalize(text)
    const condition = /^(?:WHEN action (?:= ('[^']+')|IN \(([^)]+)\)) THEN|ELSE)\b/.exec(sql)
    if (!condition) throw new Error(`${file}: unrecognized audit selector ${when.trim()}`)
    const predicate = sql.slice(condition[0].length).trim()
    // Track each action separately so splitting a grouped WHEN leaves its other rules intact.
    const actionList = condition[1] ?? condition[2]
    const actions = actionList
      ? actionList.split(',').map((entry) => {
          const action = entry.trim().match(/^'([a-z0-9_.]+)'$/)?.[1]
          if (!action) throw new Error(`${file}: invalid audit action ${entry}`)
          return action
        })
      : ['ELSE']
    for (const action of actions) {
      if (rules.has(action)) throw new Error(`${file}: duplicate audit rule for ${action}`)
      rules.set(action, predicate)
    }
  }
  return { file, head: normalize(head), rules }
}

it('defines the audit details check in the highest-numbered migration that touches it', () => {
  const latestTouch = detailsCheckMigrationHistory().at(-1)
  expect(latestTouch, 'The last migration touching audit_events_details_check').toMatchObject({
    defines: true,
  })
})

it('carries the audit details check rules forward through every migration', () => {
  let previous: ReturnType<typeof auditRules> | undefined
  for (const { file, defines } of detailsCheckMigrationHistory()) {
    if (!defines) continue
    const current = auditRules(file)
    if (previous) {
      const context = `${file} must retain the audit rules from ${previous.file}`
      expect(current.head, context).toBe(previous.head)
      const missing = [...previous.rules.keys()].filter((action) => !current.rules.has(action))
      expect(missing, `${context}; missing actions or fallback`).toEqual([])
      const rewritten = [...previous.rules]
        .filter(([action, predicate]) => current.rules.get(action) !== predicate)
        .map(([action]) => action)
      expect(rewritten.sort(), `${context}; changed actions or fallback`).toEqual(
        [...(historicalRewrites[file] ?? [])].sort(),
      )
    }
    previous = current
  }
})
