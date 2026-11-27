import { readFileSync } from 'node:fs'
import { parse, type parseExpression } from '@babel/parser'
import { expect, it } from 'vitest'

const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')

type ObjectExpression = Extract<ReturnType<typeof parseExpression>, { type: 'ObjectExpression' }>

const identifier = (name: string) => ({ type: 'Identifier', name })
const member = (object: string, property: string) => ({
  type: 'MemberExpression',
  computed: false,
  object: identifier(object),
  property: identifier(property),
})
const call = (name: string) => ({ type: 'CallExpression', callee: identifier(name) })

function option(options: Pick<ObjectExpression, 'properties'>, name: string) {
  const property = options.properties.findLast(
    (node) =>
      node.type === 'SpreadElement' ||
      node.computed ||
      (node.key.type === 'Identifier' && node.key.name === name) ||
      (node.key.type === 'StringLiteral' && node.key.value === name),
  )
  if (property?.type !== 'ObjectProperty' || property.computed)
    throw new Error(`Missing or overridden ${name} option`)
  return property.value
}

function verifyClaimWiring(serverSource: string) {
  const { program } = parse(serverSource, { sourceType: 'module', plugins: ['typescript'] })
  const declarations = program.body.map((node) =>
    node.type === 'ExportNamedDeclaration' ? node.declaration : node,
  )
  const functionBody = (name: string) => {
    const declaration = declarations.find(
      (node) => node?.type === 'FunctionDeclaration' && node.id?.name === name,
    )
    if (declaration?.type !== 'FunctionDeclaration') throw new Error(`Missing ${name} function`)
    return declaration.body.body
  }
  const returnedOptions = (name: string) => {
    const statement = functionBody(name).find((node) => node.type === 'ReturnStatement')
    if (statement?.argument?.type !== 'ObjectExpression') throw new Error(`Missing ${name} options`)
    return statement.argument
  }

  const claims = declarations
    .flatMap((node) => (node?.type === 'VariableDeclaration' ? node.declarations : []))
    .find((node) => node.id.type === 'Identifier' && node.id.name === 'productionScimClaims')?.init
  expect(claims, 'Production SCIM claims are invitation-only').toMatchObject({
    type: 'ObjectExpression',
    properties: [
      {
        type: 'ObjectProperty',
        computed: false,
        key: identifier('invitation'),
        value: member('scimClaimCompletion', 'invitation'),
      },
    ],
  })

  const claimOptions = {
    type: 'ConditionalExpression',
    test: member('config', 'SCIM_PROVISIONING_ENABLED'),
    consequent: identifier('productionScimClaims'),
    alternate: identifier('scimClaimAdmissionOnly'),
  }
  expect(
    option(returnedOptions('productionAuthOptions'), 'scimClaims'),
    'Better Auth claims',
  ).toMatchObject(claimOptions)

  const oidc = option(returnedOptions('productionAppOptions'), 'ssoOidcSignIn')
  expect(oidc).toMatchObject(call('oidcSignInRoutes'))
  if (oidc.type !== 'CallExpression') throw new Error('Missing production OIDC routes')
  const [oidcOptions] = oidc.arguments
  if (oidcOptions?.type !== 'ObjectExpression') throw new Error('Missing production OIDC options')
  expect(option(oidcOptions, 'scimClaims'), 'OIDC claims').toMatchObject(claimOptions)

  const authBranch = functionBody('start').find(
    (node) =>
      node.type === 'IfStatement' &&
      node.test.type === 'UnaryExpression' &&
      node.test.operator === '!' &&
      node.test.argument.type === 'Identifier' &&
      node.test.argument.name === 'authPool',
  )
  if (authBranch?.type !== 'IfStatement' || authBranch.alternate?.type !== 'BlockStatement')
    throw new Error('Missing web server startup')

  const startup = authBranch.alternate.body
  const auth = startup
    .flatMap((node) => (node.type === 'VariableDeclaration' ? node.declarations : []))
    .find((node) => node.id.type === 'Identifier' && node.id.name === 'auth')?.init
  expect(auth, 'Startup must preserve the production auth claim options').toMatchObject({
    ...call('createAuth'),
    arguments: [
      {
        type: 'ObjectExpression',
        properties: [
          { type: 'SpreadElement', argument: call('productionAuthOptions') },
          {
            type: 'ObjectProperty',
            computed: false,
            key: identifier('organizationListRateLimitMaxForTests'),
            value: member('options', 'organizationListRateLimitMaxForTests'),
          },
        ],
      },
    ],
  })

  const fetch = startup.find(
    (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression.type === 'AssignmentExpression' &&
      node.expression.left.type === 'Identifier' &&
      node.expression.left.name === 'fetch',
  )
  expect(fetch, 'Startup must preserve the production OIDC claim options').toMatchObject({
    expression: {
      right: {
        type: 'MemberExpression',
        computed: false,
        object: { ...call('createApp'), arguments: [call('productionAppOptions')] },
        property: identifier('fetch'),
      },
    },
  })
}

it('uses invitation-only SCIM claims at both production startup sites', () => {
  verifyClaimWiring(source)
})

it.each([
  {
    regression: 'a startup override that enables implicit OIDC claim completion',
    before:
      '      scimClaims: config.SCIM_PROVISIONING_ENABLED ? productionScimClaims : scimClaimAdmissionOnly,\n' +
      '      session: { secret: config.BETTER_AUTH_SECRET },',
    after:
      '      scimClaims: config.SCIM_PROVISIONING_ENABLED\n' +
      '        ? { ...productionScimClaims, link: scimClaimCompletion.link }\n' +
      '        : scimClaimAdmissionOnly,\n' +
      '      session: { secret: config.BETTER_AUTH_SECRET },',
    assertion: 'OIDC claims',
  },
  {
    regression: 'a startup override of the Better Auth claims',
    before:
      '      organizationListRateLimitMaxForTests: options.organizationListRateLimitMaxForTests,',
    after:
      '      organizationListRateLimitMaxForTests: options.organizationListRateLimitMaxForTests,\n' +
      '      scimClaims: scimClaimCompletion,',
    assertion: 'Startup must preserve the production auth claim options',
  },
  {
    regression: 'the full SCIM claim handler replacing the invitation-only handler',
    before: 'const productionScimClaims = { invitation: scimClaimCompletion.invitation }',
    after: 'const productionScimClaims = scimClaimCompletion',
    assertion: 'Production SCIM claims are invitation-only',
  },
])('detects $regression in a source copy', ({ before, after, assertion }) => {
  const mutant = source.replace(before, after)
  expect(mutant).not.toBe(source)
  expect(() => verifyClaimWiring(mutant)).toThrow(
    expect.objectContaining({
      name: 'AssertionError',
      message: expect.stringContaining(assertion),
    }),
  )
})
