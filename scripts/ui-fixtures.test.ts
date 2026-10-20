import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const directory = mkdtempSync(join(tmpdir(), 'hourmere-ui-oauth-fixture-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const fixtureSource = readFileSync('tools/e2e/fixtures.ts', 'utf8')

const assertions = `
import assert from 'node:assert/strict'
import {createPreparation} from './oauth-fixture.ts'
let registrations=0,authorizations=0
for(let app=0;app<7;app++) {
  const url='http://127.0.0.1:'+(42000+app)
  const rows=[]
  const db={insertInto:(table)=>({values:(value)=>({execute:async()=>{rows.push({table,value})}})})}
  const fetch=async(input)=> {
    const target=new URL(input)
    assert.equal(target.origin,url,'OAuth fixture requests must stay on the owned app')
    if(target.pathname==='/api/auth/oauth2/register') {
      registrations++
      return registrations>5 ? Response.json({error:'rate_limited'},{status:429}) : Response.json({client_id:'dynamic-fixture'},{status:201})
    }
    assert.equal(target.pathname,'/api/auth/oauth2/authorize','The real authorization pipeline must run')
    authorizations++
    return Response.json({url:url+'/oauth/authorize?sig=synthetic-fixture'})
  }
  const prepare=createPreparation({db,url,fetch})
  await assert.doesNotReject(()=>prepare(),'Fresh audit apps must not spend the process-wide DCR budget')
  assert.equal(await prepare(),'?sig=synthetic-fixture','OAuth preparation must reuse its per-app continuation')
  const client=rows.find(row=>row.table==='auth.oauthClient')?.value
  assert.ok(client,'Fixture must seed its public OAuth client')
  assert.equal(client.name,'Synthetic audit connector')
  assert.equal(client.tokenEndpointAuthMethod,'none','Fixture must remain a public client')
  assert.equal(client.requirePKCE,true,'Fixture must keep PKCE enabled')
  assert.deepEqual(JSON.parse(client.redirectUris),['https://hourmere.invalid/callback'])
  assert.deepEqual(JSON.parse(client.scopes),['mcp:tools','offline_access'])
  assert.deepEqual(JSON.parse(client.grantTypes),['authorization_code','refresh_token'])
  assert.deepEqual(JSON.parse(client.responseTypes),['code'])
  const resource=rows.find(row=>row.table==='auth.oauthClientResource')?.value
  assert.equal(resource?.clientId,client.clientId,'Fixture must link the client to its owned resource')
  assert.equal(resource?.resourceId,url+'/mcp','Fixture resource must belong to its own app')
  assert.equal(rows.length,2,'Each app seeds only one client and one resource association')
}
assert.equal(registrations,0,'Repeated matrix scans must never use DCR')
assert.equal(authorizations,7,'Every fresh app must execute real authorization once')
`

function sourceCopyResult(source: string) {
  const body = /auditOAuthQuery: async \(\) => \{([\s\S]*?)\n {8}\},\n {8}teamPath:/.exec(
    source,
  )?.[1]
  if (!body) throw new Error('Missing OAuth fixture preparation method')
  writeFileSync(
    join(directory, 'oauth-fixture.ts'),
    `export function createPreparation({db,url,fetch}) {
      let auditOAuthQuery: string | undefined
      const uiAudit=true
      return async()=>{${body}}
    }`,
  )
  const runner = join(directory, 'oauth-fixture.mjs')
  writeFileSync(runner, assertions)
  const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

describe('source-copy OAuth fixture isolation', () => {
  it('prepares seven separate apps without consuming dynamic registration limits', () => {
    const result = sourceCopyResult(fixtureSource)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('detects dynamic registration returning to every fresh audit app', () => {
    const mutant = fixtureSource.replace(
      "const clientId = 'synthetic-ui-audit-client'",
      `const registered = await fetch(url+'/api/auth/oauth2/register')
          if (registered.status !== 201) throw new Error('Synthetic registration refused')
          const clientId = 'synthetic-ui-audit-client'`,
    )
    expect(mutant).not.toBe(fixtureSource)
    const result = sourceCopyResult(mutant)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Fresh audit apps must not spend the process-wide DCR budget')
    expect(result.stderr).toContain('AssertionError')
  })

  for (const [from, to, assertion] of [
    [
      ".insertInto('auth.oauthClientResource')",
      ".insertInto('wrong-resource-table')",
      'Fixture must link the client to its owned resource',
    ],
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: mutate literal fixture source
      'resourceId: `${url}/mcp`',
      "resourceId: 'https://invalid.invalid/mcp'",
      'Fixture resource must belong to its own app',
    ],
    [
      'if (auditOAuthQuery) return auditOAuthQuery',
      '',
      'Each app seeds only one client and one resource association',
    ],
    ['requirePKCE: true', 'requirePKCE: false', 'Fixture must keep PKCE enabled'],
  ])
    it(`detects regression: ${assertion}`, () => {
      const mutant = fixtureSource.replace(from as string, to as string)
      expect(mutant).not.toBe(fixtureSource)
      const result = sourceCopyResult(mutant)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(assertion)
      expect(result.stderr).toContain('AssertionError')
    })
})
