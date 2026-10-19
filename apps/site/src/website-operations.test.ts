import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const operations = readFileSync(new URL('../../../docs/website.md', import.meta.url), 'utf8')
const prose = operations.replace(/\s+/g, ' ')
const commands = [...operations.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) =>
  (match[1] ?? '').replace(/\\\n\s*/g, '').trim(),
)

describe('Cloud waitlist operations contract', () => {
  it('creates D1 in the disclosed US jurisdiction without rewriting bindings', () => {
    expect(commands).toContain(
      'npx --yes wrangler@4.151.0 d1 create hourmere-cloud-waitlist --jurisdiction us',
    )
    expect(prose).toContain('Do not use `--update-config`')
    expect(prose).toContain('Replace `TODO_CREATE_WAITLIST_D1_DATABASE`')
  })

  it('deletes the stored list and exported copies after the launch notification', () => {
    expect(prose).toContain(
      'After the Hourmere Cloud launch notification has been sent, delete the list',
    )
    expect(commands).toContain(
      'npx --yes wrangler@4.151.0 d1 execute WAITLIST_DB --remote --env="" --command \'DELETE FROM waitlist;\'',
    )
    expect(prose).toContain('Delete any launch-mail exports and queued copies as well.')
  })

  it('documents multipart JavaScript and URL-encoded native submissions', () => {
    expect(prose).toContain('JSON, URL-encoded and multipart/form-data submissions')
    expect(prose).toContain("The site's JavaScript sends multipart/form-data")
    expect(prose).toContain('the native form without JavaScript sends URL-encoded data')
    expect(prose).toContain('`hm_extra` honeypot')
  })

  it('leaves the rate-limit period to the binding with a stable hashed key', () => {
    expect(prose).toContain('stable SHA-256 key')
    expect(prose).toContain('the binding controls the 60-second period')
    expect(prose).not.toContain('minute-scoped')
  })
})
