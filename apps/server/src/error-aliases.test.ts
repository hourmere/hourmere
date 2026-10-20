import { describe, expect, it } from 'vitest'
import { errorAliases, errorAliasFor } from './error-aliases.ts'
import { ErrorAlias, ErrorBody } from './openapi.ts'

describe('error aliases', () => {
  it('maps every registered code into the shared documented alias set', () => {
    expect(ErrorAlias.options).toEqual(Object.values(errorAliases))
    for (const [error, alias] of Object.entries(errorAliases)) {
      expect(errorAliasFor(error)).toBe(alias)
      expect(ErrorBody.parse({ error, errorAlias: alias })).toEqual({ error, errorAlias: alias })
    }
  })

  it('preserves errors without aliases and refuses undocumented aliases', () => {
    expect(errorAliasFor('slot_taken')).toBeUndefined()
    expect(ErrorBody.parse({ error: 'slot_taken' })).toEqual({ error: 'slot_taken' })
    expect(ErrorBody.safeParse({ error: 'slot_taken', errorAlias: 'undocumented' }).success).toBe(
      false,
    )
  })

  it.each(['constructor', 'toString', '__proto__'])(
    'does not treat the object prototype key %s as a registered alias',
    (code) => expect(errorAliasFor(code)).toBeUndefined(),
  )
})
