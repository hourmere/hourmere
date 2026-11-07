import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { WEBHOOK_EVENTS } from '../packages/webhooks/src/service.ts'
import { SlackCreateInput, SlackUpdateInput } from '../packages/webhooks/src/slack.ts'
import { HELP } from '../tools/cli/src/cli.ts'

const eventNames = (text: string) => [...text.matchAll(/\bbooking\.[a-z_]+/g)].map(([name]) => name)
const marked = (path: string) => {
  const text = readFileSync(path, 'utf8')
  const start = text.indexOf('<!-- slack-events:start -->')
  const end = text.indexOf('<!-- slack-events:end -->')
  expect(start, path).toBeGreaterThan(-1)
  expect(end, path).toBeGreaterThan(start)
  return text.slice(start, end)
}
// Each documented row/item names its event once (the site table also shows it in the first line).
const rows = (section: string) =>
  section
    .split('\n')
    .filter((line) => /^(\| `booking\.|- `booking\.)/.test(line))
    .map((line) => eventNames(line)[0])

it('documents exactly the Slack event types that REST, MCP and the CLI accept', () => {
  const sample = { url: 'https://hooks.slack.com/services/T/B/C' }
  for (const event of WEBHOOK_EVENTS) {
    expect(SlackCreateInput.safeParse({ ...sample, events: [event] }).success, event).toBe(true)
    expect(SlackUpdateInput.safeParse({ events: [event] }).success, event).toBe(true)
  }
  expect(SlackCreateInput.safeParse({ ...sample, events: ['booking.other'] }).success).toBe(false)
  for (const path of ['apps/site/src/content/docs/docs/slack.md', 'docs/slack.md'])
    expect(rows(marked(path)), path).toEqual([...WEBHOOK_EVENTS])
  const help = HELP.slice(HELP.indexOf('Slack events:'))
  expect(eventNames(help.slice(0, help.indexOf('.\n') + 1))).toEqual([...WEBHOOK_EVENTS])
  // The generated client types follow the OpenAPI document served by the code.
  const schema = readFileSync('apps/web/src/api/schema.d.ts', 'utf8')
  const destination = schema.slice(schema.indexOf('SlackDestination: {'))
  const events = /events: \(([^)]*)\)\[\];/.exec(destination)?.[1] ?? ''
  expect(events.split(' | ').map((value) => JSON.parse(value))).toEqual([...WEBHOOK_EVENTS])
})
