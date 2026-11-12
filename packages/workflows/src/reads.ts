// Workflow definition reads (docs/workflows.md, step 4: "Definition reads and availability
// signals"). A caller reads the definitions of the owner it acts as in its current
// organization: in a personal organization its own personal definitions, in a team the team's
// definitions while it is a current owner or admin there. Everything else is refused without
// revealing whether it exists: a list names its owner explicitly and gets the same
// `insufficient_role` for every owner it may not read, and a lookup by ID gets the same
// `workflow_not_found` for a missing, deleted, foreign or other-organization definition.
//
// The transports call the guarded `listWorkflows` and `getWorkflow`, which answer
// `workflows_disabled` while workflows are off. The unguarded services are the internal entry
// points that tests call directly with injected dependencies, as hard-off.ts describes.

import type { Db } from '@hourmere/db'
import { DomainError } from '@hourmere/scheduling/errors'
import { type WorkflowDefinition, WorkflowDefinitionSchema } from './definition.ts'
import { workflowOperation } from './hard-off.ts'
import { WORKFLOW_MAX_DEFINITIONS_PER_OWNER } from './limits.ts'
import {
  uuidSchema,
  type WorkflowOwner,
  type WorkflowOwnerSelector,
  WorkflowOwnerSelectorSchema,
  workflowOwnerSelector,
} from './ownership.ts'

/** Page sizes of the definition list; a full page holds every definition an owner may keep. */
export const WORKFLOW_PAGE = Object.freeze({
  default: 50,
  max: WORKFLOW_MAX_DEFINITIONS_PER_OWNER,
})

/** Who reads: a resolved caller's user and the organization it currently acts in. */
export interface WorkflowReader {
  user: { id: string }
  organization: { id: string }
}

export interface WorkflowReadContext {
  db: Db
  principal: WorkflowReader
}

/** A definition as the reads return it: its current revision and the live enabled flag. */
export type WorkflowView = {
  id: string
  owner: WorkflowOwnerSelector
  /** The current revision; a later update names it as its expected revision. */
  revision: number
} & WorkflowDefinition & {
    createdAt: string
    updatedAt: string
  }

export interface WorkflowPage {
  data: WorkflowView[]
  /** Pass as `cursor`, with the same owner, for the next page; null on the last page. */
  nextCursor: string | null
}

export interface WorkflowListInput {
  owner: WorkflowOwnerSelector
  limit?: number | undefined
  cursor?: string | undefined
}

const notFound = () => new DomainError('not_found', 'workflow_not_found', 'No such workflow')
const insufficientRole = () =>
  new DomainError(
    'forbidden',
    'insufficient_role',
    'Only the personal owner, or a team owner or admin acting in that team, can read its workflows',
  )
const invalidCursor = () => new DomainError('invalid', 'invalid_cursor', 'cursor is not valid')

/** A UUID in the database's lowercase form, or undefined. */
function uuid(value: unknown): string | undefined {
  const result = uuidSchema.safeParse(value)
  return result.success ? result.data : undefined
}

/**
 * The owner whose definitions the caller may read where it acts now, from current rows: a
 * verified user's own personal organization, or a team it currently owns or administers. An
 * ordinary member, a removed or unverified user and anything malformed read nothing.
 */
async function readableOwner(db: Db, reader: WorkflowReader): Promise<WorkflowOwner | undefined> {
  const userId = uuid(reader.user.id)
  const organizationId = uuid(reader.organization.id)
  if (!userId || !organizationId) return undefined
  const membership = await db
    .selectFrom('auth.member as m')
    .innerJoin('auth.user as u', 'u.id', 'm.userId')
    .innerJoin('auth.organization as o', 'o.id', 'm.organizationId')
    .leftJoin('personal_organizations as p', 'p.organization_id', 'm.organizationId')
    .select(['m.role', 'p.user_id as personalUserId'])
    .where('m.organizationId', '=', organizationId)
    .where('m.userId', '=', userId)
    .where('u.emailVerified', '=', true)
    .executeTakeFirst()
  if (!membership) return undefined
  if (membership.personalUserId !== null)
    return membership.personalUserId === userId
      ? { kind: 'personal', userId, organizationId }
      : undefined
  // Better Auth stores several roles comma-separated.
  const roles = membership.role.split(',').map((role) => role.trim())
  return roles.includes('owner') || roles.includes('admin')
    ? { kind: 'team', organizationId }
    : undefined
}

/** The owner's live definitions with their current revision. */
function definitionsOf(db: Db, owner: WorkflowOwner) {
  return db
    .selectFrom('workflow_definitions as d')
    .innerJoin('workflow_revisions as r', (join) =>
      join
        .onRef('r.organization_id', '=', 'd.organization_id')
        .onRef('r.workflow_id', '=', 'd.id')
        .onRef('r.revision', '=', 'd.revision'),
    )
    .select(['d.id', 'd.revision', 'd.enabled', 'd.created_at', 'd.updated_at', 'r.definition'])
    .where('d.organization_id', '=', owner.organizationId)
    .where('d.deleted_at', 'is', null)
    .where((eb) =>
      owner.kind === 'personal'
        ? eb('d.owner_user_id', '=', owner.userId)
        : eb('d.owner_user_id', 'is', null),
    )
}

type DefinitionRow = {
  id: string
  revision: number
  enabled: boolean
  created_at: Date
  updated_at: Date
  definition: unknown
}

/**
 * The read representation of a stored definition. The revision holds the contract's canonical
 * output, which the database checks; anything else is a fault, never shown to the caller.
 */
function view(owner: WorkflowOwner, row: DefinitionRow): WorkflowView {
  const stored = row.definition
  const parsed =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? WorkflowDefinitionSchema.safeParse({ ...stored, enabled: row.enabled })
      : undefined
  if (!parsed?.success)
    throw new Error(
      `workflow ${row.id} revision ${row.revision} does not match the definition contract`,
    )
  return {
    id: row.id,
    owner: workflowOwnerSelector(owner),
    revision: row.revision,
    ...parsed.data,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

const selectorKey = (selector: WorkflowOwnerSelector) => `${selector.kind}:${selector.id}`

function encodeCursor(selector: WorkflowOwnerSelector, id: string): string {
  return Buffer.from(JSON.stringify([selectorKey(selector), id])).toString('base64url')
}

/** A cursor continues the list of the owner it came from, after the definition it names. */
function decodeCursor(selector: WorkflowOwnerSelector, cursor: unknown): string {
  if (typeof cursor !== 'string' || cursor.length > 512) throw invalidCursor()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalidCursor()
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== selectorKey(selector))
    throw invalidCursor()
  const after = uuid(parsed[1])
  if (!after) throw invalidCursor()
  return after
}

/**
 * The definitions of the explicitly named owner, oldest first (by their time-ordered ID). The
 * owner must be the one the caller acts as in its current organization; any other owner,
 * existing or not, gets the same `insufficient_role`.
 */
export async function listWorkflowDefinitions(
  ctx: WorkflowReadContext,
  input: WorkflowListInput,
): Promise<WorkflowPage> {
  const selector = WorkflowOwnerSelectorSchema.safeParse(input.owner)
  if (!selector.success)
    throw new DomainError(
      'invalid',
      'invalid_workflow_owner',
      'owner must name a personal user or a team by its ID',
    )
  const limit = input.limit ?? WORKFLOW_PAGE.default
  if (!Number.isInteger(limit) || limit < 1 || limit > WORKFLOW_PAGE.max)
    throw new DomainError(
      'invalid',
      'invalid_limit',
      `limit must be an integer from 1 to ${WORKFLOW_PAGE.max}`,
    )
  const after = input.cursor === undefined ? undefined : decodeCursor(selector.data, input.cursor)
  // One snapshot: the caller's role and the definitions it may see.
  return ctx.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const owner = await readableOwner(trx, ctx.principal)
      if (!owner || selectorKey(workflowOwnerSelector(owner)) !== selectorKey(selector.data))
        throw insufficientRole()
      const rows = await definitionsOf(trx, owner)
        .$if(after !== undefined, (query) => query.where('d.id', '>', after as string))
        .orderBy('d.id')
        .limit(limit + 1)
        .execute()
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return {
        data: page.map((row) => view(owner, row)),
        nextCursor: rows.length > limit && last ? encodeCursor(selector.data, last.id) : null,
      }
    })
}

/**
 * One definition of the owner the caller acts as in its current organization. A missing,
 * deleted or malformed ID, another owner's definition, and every definition while the caller
 * may read none here, all get the same `workflow_not_found`.
 */
export async function getWorkflowDefinition(
  ctx: WorkflowReadContext,
  id: string,
): Promise<WorkflowView> {
  const workflowId = uuid(id)
  if (!workflowId) throw notFound()
  return ctx.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const owner = await readableOwner(trx, ctx.principal)
      if (!owner) throw notFound()
      const row = await definitionsOf(trx, owner).where('d.id', '=', workflowId).executeTakeFirst()
      if (!row) throw notFound()
      return view(owner, row)
    })
}

/** `GET /api/v1/workflows`, `list_workflows` and `workflows list`; off while hard-off. */
export const listWorkflows = workflowOperation(listWorkflowDefinitions)

/** `GET /api/v1/workflows/{id}`, `get_workflow` and `workflows get`; off while hard-off. */
export const getWorkflow = workflowOperation(getWorkflowDefinition)
