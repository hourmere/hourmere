import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// This is a static DDL lint, not a PostgreSQL parser. Keep quoted text as opaque
// tokens so examples, function bodies and identifiers cannot become SQL keywords.
function sqlTokens(sql: string) {
  const tokens: string[] = []
  for (let index = 0; index < sql.length; ) {
    const rest = sql.slice(index)
    if (/^\s/.test(rest)) {
      index++
    } else if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', index + 2)
      index = end < 0 ? sql.length : end + 1
    } else if (rest.startsWith('/*')) {
      index += 2
      let depth = 1
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth++
          index += 2
        } else if (sql.startsWith('*/', index)) {
          depth--
          index += 2
        } else index++
      }
    } else if (/^(?:[eE]'|[uU]&['"]|['"])/.test(rest)) {
      const prefix = rest.match(/^(?:[eE](?=')|[uU]&(?=['"]))/)?.[0] ?? ''
      index += prefix.length
      const quote = sql.charAt(index++)
      const escaped = prefix.toUpperCase() === 'E'
      while (index < sql.length) {
        if (escaped && sql[index] === '\\') index += 2
        else if (sql[index] !== quote) index++
        else if (sql[index + 1] === quote) index += 2
        else {
          index++
          break
        }
      }
      tokens.push(quote === '"' ? '<identifier>' : '<literal>')
    } else {
      const dollar = rest.match(/^\$(?:[a-z_\u0080-\uffff][a-z_0-9\u0080-\uffff]*)?\$/i)?.[0]
      if (dollar) {
        const end = sql.indexOf(dollar, index + dollar.length)
        index = end < 0 ? sql.length : end + dollar.length
        tokens.push('<literal>')
      } else {
        const word = rest.match(/^[a-z_\u0080-\uffff][a-z_0-9$\u0080-\uffff]*/i)?.[0]
        tokens.push(word ? word.toUpperCase() : sql.charAt(index))
        index += word?.length ?? 1
      }
    }
  }
  return tokens
}

function isIdentifier(token: string | undefined) {
  return (
    token !== undefined &&
    /^(?:<identifier>|[A-Z_\u0080-\uffff][A-Z_0-9$\u0080-\uffff]*)$/.test(token)
  )
}

function breaksTableCompatibility(statement: string[]) {
  if (statement[0] === 'DROP' && statement[1] === 'TABLE') return true
  if (statement[0] !== 'ALTER' || statement[1] !== 'TABLE') return false

  let index = 2
  if (statement[index] === 'IF' && statement[index + 1] === 'EXISTS') index += 2
  if (statement[index] === 'ONLY') index++
  if (!isIdentifier(statement[index++])) return false
  while (statement[index] === '.' && isIdentifier(statement[index + 1])) index += 2
  if (statement[index] === '*') index++

  let depth = 0
  let actionStart = true
  for (; index < statement.length; index++) {
    const token = statement[index]
    if (actionStart) {
      // DROP/RENAME CONSTRAINT and ALTER ... DROP DEFAULT/NOT NULL/IDENTITY/EXPRESSION
      // preserve table and column names. Inspect only the beginning of each action.
      if (token === 'DROP' && statement[index + 1] !== 'CONSTRAINT') return true
      if (token === 'RENAME' && statement[index + 1] !== 'CONSTRAINT') {
        return true
      }
      actionStart = false
    }
    if (token === '(') depth++
    else if (token === ')') depth--
    else if (token === ',' && depth === 0) actionStart = true
  }
  return false
}

export function requiresUpgradeNote(sql: string) {
  let statement: string[] = []
  for (const token of sqlTokens(sql)) {
    if (token === ';') {
      if (breaksTableCompatibility(statement)) return true
      statement = []
    } else statement.push(token)
  }
  return breaksTableCompatibility(statement)
}

export function undocumentedMigrations(directory: string) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .filter((name) => {
      if (!requiresUpgradeNote(readFileSync(join(directory, name), 'utf8'))) return false
      const note = join(directory, name.replace(/\.sql$/, '.md'))
      return (
        !existsSync(note) ||
        !/^(?:Schema-break|Column-drop) upgrade:[ \t]*\S.*$/m.test(readFileSync(note, 'utf8'))
      )
    })
}
