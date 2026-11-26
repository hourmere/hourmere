import { readFileSync } from 'node:fs'
import { parse } from '@babel/parser'
import { expect, it } from 'vitest'

const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')

function verifyAuthWiring(serverSource: string) {
  const { program } = parse(serverSource, { sourceType: 'module', plugins: ['typescript'] })
  const start = program.body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id?.name === 'start',
  )
  if (start?.type !== 'FunctionDeclaration') throw new Error('Missing server startup')

  const authBranch = start.body.body.find(
    (node) =>
      node.type === 'IfStatement' &&
      node.test.type === 'UnaryExpression' &&
      node.test.operator === '!' &&
      node.test.argument.type === 'Identifier' &&
      node.test.argument.name === 'authPool',
  )
  if (authBranch?.type !== 'IfStatement' || authBranch.alternate?.type !== 'BlockStatement')
    throw new Error('Missing web server startup')

  const auth = authBranch.alternate.body
    .flatMap((node) => (node.type === 'VariableDeclaration' ? node.declarations : []))
    .find((node) => node.id.type === 'Identifier' && node.id.name === 'auth')?.init

  // Claim completion is invitation-only in productionAuthOptions. Check what startup passes
  // to createAuth so a startup override cannot enable implicit OIDC claim completion.
  expect(auth).toMatchObject({
    type: 'CallExpression',
    callee: { type: 'Identifier', name: 'createAuth' },
  })
  if (auth?.type !== 'CallExpression') throw new Error('Missing auth construction')
  expect(auth.arguments).toHaveLength(1)
  const [options] = auth.arguments
  expect(options).toMatchObject({
    type: 'CallExpression',
    callee: { type: 'Identifier', name: 'productionAuthOptions' },
  })
  return options
}

it('uses the production claim completion options at server startup', () => {
  verifyAuthWiring(source)
})

it('detects a startup override that enables implicit OIDC claim completion', () => {
  const options = verifyAuthWiring(source)
  if (options?.start == null || options.end == null) throw new Error('Missing auth options range')
  const { start, end } = options
  const mutant = `${source.slice(0, start)}{ ...${source.slice(start, end)}, scimClaims: scimClaimCompletion }${source.slice(end)}`
  expect(() => verifyAuthWiring(mutant)).toThrow(
    expect.objectContaining({ name: 'AssertionError' }),
  )
})
