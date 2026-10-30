import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { z } from '@hono/zod-openapi'
import type { Db } from '@hourmere/db'
import { describe, expect, it } from 'vitest'
import { productRoutes } from '../server.ts'
import { TeamInvitationSummarySchema } from '../team-invitations.ts'
import { teamInvitationRoutes } from './team-invitations.ts'

const db = {} as Db
const message = 'Invitation summary requires mail admission configuration'

function verifyRequiredConfiguration(factory: typeof teamInvitationRoutes) {
  expect(() => {
    // @ts-expect-error Mail admission configuration is required at registration.
    factory({ db })
  }).toThrow(message)
}

function sourceCopy(removeGuard = false): typeof teamInvitationRoutes {
  const source = readFileSync(new URL('./team-invitations.ts', import.meta.url), 'utf8')
  const guard = `  if (!invitationMailLimits)\n    throw new Error('${message}')`
  expect(source.includes(guard), 'registration guard matches source').toBe(true)
  const javascript = stripTypeScriptTypes(
    (removeGuard ? source.replace(guard, '') : source).replace(
      /^import[\s\S]*?from '[^']+'\n/gm,
      '',
    ),
  ).replace(/\bexport /g, '')
  return new Function(
    'z',
    'TeamInvitationSummarySchema',
    `${javascript}; return teamInvitationRoutes`,
  )(z, TeamInvitationSummarySchema) as typeof teamInvitationRoutes
}

describe('invitation summary route registration', () => {
  it('requires mail admission configuration before serving requests', () => {
    verifyRequiredConfiguration(teamInvitationRoutes)
    expect(() => {
      // @ts-expect-error The production composition requires the same configuration.
      productRoutes({ db, socialProviders: {} })
    }).toThrow(message)
    expect(() =>
      teamInvitationRoutes({ db, invitationMailLimits: { secret: 'synthetic-registration-only' } }),
    ).not.toThrow()
  })

  it('checks the unmodified source copy before mutation', () => {
    verifyRequiredConfiguration(sourceCopy())
  })

  it('detects a removed registration guard through a real assertion failure', () => {
    const mutant = sourceCopy(true)
    try {
      verifyRequiredConfiguration(mutant)
      throw new Error('Registration mutation escaped the assertion')
    } catch (error) {
      expect(error).toMatchObject({ name: 'AssertionError' })
    }
  })
})
