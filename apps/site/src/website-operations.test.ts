import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const operations = readFileSync(new URL('../../../docs/website.md', import.meta.url), 'utf8')
const prose = operations.replace(/\s+/g, ' ')
const commands = [...operations.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) =>
  (match[1] ?? '').replace(/\\\n\s*/g, '').trim(),
)
const config = JSON.parse(
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
)

describe('Cloud waitlist operations contract', () => {
  it('disables Worker observability instead of relying on logging defaults', () => {
    expect(config.observability).toEqual({ enabled: false })
  })

  it('ties the recorded consent version to the published launch-notification consent', () => {
    expect(prose).toContain('`2026-10-22`')
    expect(prose).toContain('displayed launch-notification consent and policy publication date')
    expect(prose).not.toContain('`2026-11-30`')
  })

  it('binds the existing production D1 database and keeps development local', () => {
    expect(config.d1_databases).toEqual([
      {
        binding: 'WAITLIST_DB',
        database_name: 'hourmere-cloud-waitlist',
        database_id: '1af0d108-0f24-4166-8f33-d20583d15798',
        migrations_dir: './migrations',
        remote: false,
      },
    ])
    expect(config.env.development.d1_databases[0]).toMatchObject({
      database_id: 'LOCAL_ONLY_WAITLIST_D1_DATABASE',
      remote: false,
    })
    expect(prose).toContain('jurisdiction **`us`** (United States)')
    expect(prose).toContain('**`1af0d108-0f24-4166-8f33-d20583d15798`**')
    expect(prose).toContain('Do not create another database or use `--update-config`')
    expect(operations).not.toContain('TODO_CREATE_WAITLIST_D1_DATABASE')
  })

  it('keeps namespace 1001 account-unique and retains the five-per-minute binding', () => {
    expect(config.ratelimits).toEqual([
      {
        name: 'WAITLIST_RATE_LIMITER',
        namespace_id: '1001',
        simple: { limit: 5, period: 60 },
      },
    ])
    expect(prose).toContain('Keep rate-limit namespace **`1001`** account-unique')
    expect(config.vars?.WAITLIST_DEVELOPMENT).toBeUndefined()
    expect(config.env.development.vars.WAITLIST_DEVELOPMENT).toBe('true')
  })

  it('gives the lead exact migration and production deployment commands', () => {
    expect(commands).toContain(
      'npx --yes wrangler@4.151.0 d1 migrations apply WAITLIST_DB --remote --env=""',
    )
    expect(commands).toContain('npm run deploy --workspace @hourmere/site')
    const sitePackage = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    )
    expect(sitePackage.scripts.deploy).toBe(
      'npm run build && npx --yes wrangler@4.151.0 deploy --env=""',
    )
    expect(prose).toContain('The construction task runs no remote Wrangler commands.')
  })

  it('exports the complete stored fields privately and deletes one normalized address on request', () => {
    expect(commands).toContain(
      'umask 077\nnpx --yes wrangler@4.151.0 d1 execute WAITLIST_DB --remote --env="" --json --command \'SELECT email, created_at, source, locale, consent_text_version FROM waitlist ORDER BY created_at\' > /secure/operator-owned-directory/waitlist.json',
    )
    expect(commands).toContain(
      'npx --yes wrangler@4.151.0 d1 execute WAITLIST_DB --remote --env="" --file /secure/operator-owned-directory/delete-waitlist.sql',
    )
    expect(operations).toContain("DELETE FROM waitlist WHERE email = 'person@example.test';")
    expect(prose).toContain('request sent to `hello@hourmere.com`')
    expect(prose).toContain('normalize the address')
    expect(prose).toContain('double any embedded single quote')
    expect(prose).toContain('Remove the address from any outstanding launch-mail export/queue too')
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
