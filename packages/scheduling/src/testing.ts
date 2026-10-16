// Test support: real users, personal organizations and teams in a throwaway database (see
// @hourmere/db/testing), and the principals a resolver would produce for them.
import { randomBytes, randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { ensurePersonalOrganization, type Principal } from '@hourmere/auth'
import type { Db } from '@hourmere/db'
import type { ServiceContext } from './context.ts'
import { DomainError } from './errors.ts'

export interface TestUser {
  id: string
  name: string
  email: string
  /** The user acting in their personal organization through an API key. */
  principal: Principal
}

export interface TestTeam {
  id: string
  /** `user` acting in this team; they must be one of its members. */
  as: (user: TestUser) => Principal
}

const unique = () => randomBytes(4).toString('hex')

/** Inserts a verified user with their personal organization. */
export async function createTestUser(db: Db, name = 'Test User'): Promise<TestUser> {
  const email = `${unique()}@example.com`
  const { id } = await db
    .insertInto('auth.user')
    .values({ name, email, emailVerified: true })
    .returning('id')
    .executeTakeFirstOrThrow()
  const organizationId = await ensurePersonalOrganization(db, id)
  const organization = await db
    .selectFrom('auth.organization')
    .select(['id', 'name', 'slug'])
    .where('id', '=', organizationId)
    .executeTakeFirstOrThrow()
  const user = { id, name, email }
  return {
    ...user,
    principal: {
      kind: 'api_key',
      apiKeyId: randomUUID(),
      user,
      organization: { ...organization, personal: true },
    },
  }
}

/** Inserts a team organization with these members; roles as Better Auth stores them. */
export async function createTestTeam(
  db: Db,
  members: { user: TestUser; role: string }[],
  name = 'Test Team',
): Promise<TestTeam> {
  const createdAt = new Date()
  const organization = await db
    .insertInto('auth.organization')
    .values({ name, slug: `team-${unique()}`, createdAt })
    .returning(['id', 'name', 'slug'])
    .executeTakeFirstOrThrow()
  if (members.length) {
    await db
      .insertInto('auth.member')
      .values(
        members.map(({ user, role }) => ({
          organizationId: organization.id,
          userId: user.id,
          role,
          createdAt,
        })),
      )
      .execute()
  }
  return {
    id: organization.id,
    as: (user) => ({ ...user.principal, organization: { ...organization, personal: false } }),
  }
}

/** Runs `fn` and returns the DomainError it throws; fails if it throws anything else. */
export async function domainError(fn: () => Promise<unknown>): Promise<DomainError> {
  const error = await fn().then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof DomainError)) {
    throw new Error(`expected a DomainError, got ${inspect(error)}`)
  }
  return error
}

/** A ServiceContext for `principal`, with the real clock unless one is given. */
export function testContext(
  db: Db,
  principal: Principal,
  now: () => Temporal.Instant = () => Temporal.Now.instant(),
): ServiceContext {
  return { db, principal, now }
}
