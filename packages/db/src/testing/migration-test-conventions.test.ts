import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser'
import { expect, it } from 'vitest'

type SyntaxNode = { type: string } & Record<string, unknown>

function isNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
  )
}

function identifier(value: unknown): string | undefined {
  if (isNode(value) && value.type === 'Identifier' && typeof value.name === 'string') {
    return value.name
  }
}

function* descendants(value: unknown): Generator<SyntaxNode> {
  if (Array.isArray(value)) {
    for (const item of value) yield* descendants(item)
  } else if (isNode(value)) {
    yield value
    for (const child of Object.values(value)) yield* descendants(child)
  }
}

function* calls(value: unknown, names: ReadonlySet<string>) {
  for (const node of descendants(value)) {
    const callee = identifier(node.callee)
    if (
      node.type === 'CallExpression' &&
      callee &&
      names.has(callee) &&
      Array.isArray(node.arguments)
    ) {
      yield { node, args: node.arguments as unknown[] }
    }
  }
}

function properties(value: unknown): SyntaxNode[] {
  return isNode(value) && Array.isArray(value.properties) ? value.properties.filter(isNode) : []
}

function conventionProblems(file: string, source: string): string[] {
  const { program } = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const imports = program.body.filter((node) => node.type === 'ImportDeclaration')
  const names = (module: RegExp, ...symbols: string[]) =>
    new Set(
      imports
        .filter((node) => module.test(node.source.value))
        .flatMap(({ specifiers }) =>
          specifiers.flatMap((specifier) =>
            specifier.type === 'ImportSpecifier' &&
            specifier.imported.type === 'Identifier' &&
            symbols.includes(specifier.imported.name)
              ? [specifier.local.name]
              : [],
          ),
        ),
    )

  const cover = names(/\/constraint-coverage\.ts$/, 'checkConstraintCoverage')
  const checks = [...calls(program, cover)]
  if (!checks.length) return [`${file}: call checkConstraintCoverage`]

  const migrationReplay = /\/migration-replay(\.ts)?$/
  const coverageBudgets = names(migrationReplay, 'MIGRATION_COVERAGE_TIMEOUT')
  const replayBudgets = names(migrationReplay, 'MIGRATION_REPLAY_TIMEOUT')
  const replay = names(/\/migrate\.ts$|^@hourmere\/db$/, 'runMigrations')
  const fixture = names(/\/testing(\.ts)?$/, 'createTestDatabase')
  const replayOperations = (scope: unknown) => [
    ...calls(scope, replay),
    ...[...calls(scope, fixture)].filter(
      ({ args: [, directory] }) => directory !== undefined && identifier(directory) !== 'undefined',
    ),
  ]
  const useReplay = names(migrationReplay, 'useMigrationReplay')
  const replayBindings = new Set(
    [...descendants(program)]
      .filter(
        (node) =>
          node.type === 'VariableDeclarator' &&
          isNode(node.init) &&
          node.init.type === 'CallExpression' &&
          useReplay.has(identifier(node.init.callee) ?? ''),
      )
      .map((node) => identifier(node.id))
      .filter((name) => name !== undefined),
  )
  const isPredecessor = (value: unknown) =>
    isNode(value) &&
    value.type === 'MemberExpression' &&
    identifier(value.property) === 'predecessor' &&
    replayBindings.has(identifier(value.object) ?? '')

  const testCases = [...calls(program, names(/^vitest$/, 'it', 'test'))]
  const coveredCalls = new Set<SyntaxNode>()
  const replayCalls = new Set<SyntaxNode>()
  const problems: string[] = []
  for (const {
    args: [, callback, timeout],
  } of testCases) {
    const budget = identifier(timeout)
    if (budget && coverageBudgets.has(budget)) {
      for (const { node } of calls(callback, cover)) coveredCalls.add(node)
    }
    const operations = replayOperations(callback)
    if (operations.length && budget && replayBudgets.has(budget)) {
      for (const { node } of operations) replayCalls.add(node)

      const descendantsOfTest = [...descendants(callback)]
      const boundPredecessors = new Set<string | undefined>()
      for (const node of descendantsOfTest) {
        if (node.type !== 'VariableDeclarator' || !replayBindings.has(identifier(node.init) ?? ''))
          continue
        for (const property of properties(node.id)) {
          if (identifier(property.key) === 'predecessor') {
            boundPredecessors.add(identifier(property.value))
          }
        }
      }
      const clones = descendantsOfTest.some((node) => {
        const callee = node.callee
        return (
          node.type === 'CallExpression' &&
          isNode(callee) &&
          callee.type === 'MemberExpression' &&
          identifier(callee.property) === 'clone' &&
          (isPredecessor(callee.object) || boundPredecessors.has(identifier(callee.object)))
        )
      })
      if (!clones)
        problems.push(`${file}: clone useMigrationReplay's predecessor in the replay test`)
    }
  }

  if (checks.some(({ node }) => !coveredCalls.has(node))) {
    problems.push(`${file}: use MIGRATION_COVERAGE_TIMEOUT on each checkConstraintCoverage test`)
  }
  const replays = replayOperations(program)
  if (replays.length) {
    if (replays.some(({ node }) => !replayCalls.has(node))) {
      problems.push(`${file}: use MIGRATION_REPLAY_TIMEOUT on each migration replay test`)
    }
    if (
      checks.some(
        ({ args: [options] }) =>
          !properties(options).some(
            (property) =>
              identifier(property.key) === 'predecessorTemplate' && isPredecessor(property.value),
          ),
      )
    ) {
      problems.push(`${file}: share useMigrationReplay's predecessor with checkConstraintCoverage`)
    }
  }
  return problems
}

it('uses the migration coverage timeout and shares historical templates in each coverage file', () => {
  const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
  const problems = readdirSync(sourceRoot, { encoding: 'utf8', recursive: true })
    .filter(
      (file) =>
        file.endsWith('.test.ts') && file !== join('testing', 'constraint-coverage.test.ts'),
    )
    .sort()
    .flatMap((file) => {
      const source = readFileSync(join(sourceRoot, file), 'utf8')
      return file.endsWith('-coverage.test.ts') ||
        /from ['"][^'"]*\/constraint-coverage\.ts['"]/.test(source)
        ? conventionProblems(file, source)
        : []
    })
  expect(problems, 'See CONTRIBUTING.md, Constraint coverage for new migrations').toEqual([])
})
