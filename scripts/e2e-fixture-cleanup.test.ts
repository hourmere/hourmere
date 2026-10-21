import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

type Step =
  | 'parent.close'
  | 'app.close'
  | 'appListener.close'
  | 'authPool.end'
  | 'database.drop'
  | 'verification.query'
  | 'verification.end'
  | 'appListener.assertClosed'
  | 'parent.assertClosed'
type Listener = { close: () => Promise<void>; assertClosed: () => Promise<void> }
type Cleanup = (resources: {
  parentListener: Listener
  app: { close: () => Promise<void> }
  appListener: Listener
  authPool: { end: () => Promise<void> }
  owned: { url: string; drop: () => Promise<void> }
  createPool: (url: string) => { query: () => Promise<void>; end: () => Promise<void> }
}) => Promise<void>

const success = 'Fixture cleanup verified: database absent and owned listeners closed'
function sourceCopy(log: (message: string) => void, replacement?: [string, string]): Cleanup {
  let source = readFileSync('tools/e2e/fixtures.ts', 'utf8')
  if (replacement) {
    expect(source.includes(replacement[0]), 'mutation must match source').toBe(true)
    source = source.replace(...replacement)
  }
  const start = source.indexOf('    } finally {\n      try {'),
    end = source.indexOf('\n  },\n})\nexport { expect }')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const teardown = source.slice(start, end)
  return new Function(
    'expect',
    'console',
    `${stripTypeScriptTypes(`async function cleanup({
      parentListener, app, appListener, authPool, owned, createPool
    }) { try { ${teardown} }`)}; return cleanup`,
  )(expect, { log }) as Cleanup
}

function resources(events: string[], failure?: Step) {
  const step = (name: Step) => async () => {
    events.push(name)
    if (name === failure) throw new Error(`synthetic failure: ${name}`)
  }
  return {
    parentListener: { close: step('parent.close'), assertClosed: step('parent.assertClosed') },
    app: { close: step('app.close') },
    appListener: {
      close: step('appListener.close'),
      assertClosed: step('appListener.assertClosed'),
    },
    authPool: { end: step('authPool.end') },
    owned: { url: 'synthetic-owned-database', drop: step('database.drop') },
    createPool: (url: string) => {
      expect(url).toBe('synthetic-owned-database')
      return {
        query: async () => {
          await step('verification.query')()
          throw Object.assign(new Error('synthetic absent database'), { code: '3D000' })
        },
        end: step('verification.end'),
      }
    },
  }
}

async function verifyFailure(failure: Step, replacement?: [string, string]) {
  const events: string[] = [],
    log = vi.fn(),
    cleanup = sourceCopy(log, replacement)
  await expect(cleanup(resources(events, failure))).rejects.toThrow(
    failure === 'verification.query'
      ? 'The helper-owned database must no longer exist'
      : `synthetic failure: ${failure}`,
  )
  expect(log.mock.calls, 'Failed cleanup must never announce success').toEqual([])
  if (['parent.close', 'app.close', 'appListener.close', 'authPool.end'].includes(failure))
    expect(events).toEqual([
      'parent.close',
      'app.close',
      'appListener.close',
      'authPool.end',
      'database.drop',
      'verification.query',
      'verification.end',
      'appListener.assertClosed',
      'parent.assertClosed',
    ])
}

describe('fixture cleanup reporting', () => {
  it('announces success only after every close and verification succeeds', async () => {
    const events: string[] = [],
      log = vi.fn(() => events.push('success'))
    await sourceCopy(log)(resources(events))
    expect(log).toHaveBeenCalledExactlyOnceWith(success)
    expect(events).toEqual([
      'parent.close',
      'app.close',
      'appListener.close',
      'authPool.end',
      'database.drop',
      'verification.query',
      'verification.end',
      'appListener.assertClosed',
      'parent.assertClosed',
      'success',
    ])
  })
  it.each<Step>([
    'parent.close',
    'app.close',
    'appListener.close',
    'authPool.end',
    'database.drop',
    'verification.query',
    'verification.end',
    'appListener.assertClosed',
    'parent.assertClosed',
  ])('does not announce success after %s fails', (failure) => verifyFailure(failure))
})

describe('fixture cleanup source-copy negative controls', () => {
  it('detects announcing success inside the outer teardown finally', async () => {
    await expect(
      verifyFailure('app.close', [
        `          await parentListener?.assertClosed()
        }
      }
      console.log('${success}')`,
        `          await parentListener?.assertClosed()
          console.log('${success}')
        }
      }`,
      ]),
    ).rejects.toThrow('Failed cleanup must never announce success')
  })
})
